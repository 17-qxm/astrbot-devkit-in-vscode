// src/debug/debugSession.ts
// F5 Debug 工作流:ruff 检查 → 打包 → upload 推送 → 启动日志观察 → 通知停止。
// 见 implementation.md §8 与 design.md §8。
//
// 状态机:idle → ruff → packaging → uploading → streaming →(Stop)→ idle
// 任一前置步骤失败回到 idle,原因写入 AstrBot DevKit 通道。

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import type { AstrBotClient, ApiError } from '../api/client.js';
import { describeApiError } from '../api/client.js';
import {
    uploadPluginZip, listPlugins, setPluginEnabled, installPluginFromGithub,
} from '../api/plugins.js';
import type { PluginWorkspace } from '../config.js';
import { getConfig, getWorkspaceRoot, saveConfig } from '../config.js';
import { generateKey } from '../config.js';
import { LogRelay } from '../logs/relay.js';
import * as tool from '../tool.js';
import * as logger from '../logger.js';
import {
    RUFF_WIN, RUFF_UNIX, ZIP_EXCLUDE, LOGLEAK_PLUGIN_ID,
} from '../constants.js';

export type DebugState = 'idle' | 'ruff' | 'packaging' | 'uploading' | 'streaming' | 'error';

/** 状态变化回调(供 extension 同步 setContext / 刷新侧边栏) */
export type DebugStateListener = (state: DebugState, workspace?: PluginWorkspace) => void;

export class DebugSession {
    private _state: DebugState = 'idle';
    private _workspace?: PluginWorkspace;
    private readonly listeners: DebugStateListener[] = [];

    constructor(
        private readonly client: AstrBotClient,
        private readonly relay: LogRelay,
    ) {}

    get state(): DebugState { return this._state; }
    get workspace(): PluginWorkspace | undefined { return this._workspace; }

    onStateChange(cb: DebugStateListener): void {
        this.listeners.push(cb);
    }

    private setState(s: DebugState, ws?: PluginWorkspace): void {
        this._state = s;
        if (ws !== undefined) {this._workspace = ws;}
        const w = ws ?? this._workspace;
        this.listeners.forEach(l => { try { l(s, w); } catch {} });
    }

    // ─── 入口 ────────────────────────────────────────────

    /**
     * 启动 debug 流程。前置检查 → ruff → 打包 → upload → 日志 → 通知停止。
     * 任何步骤失败都会回 idle 并弹错误通知。
     */
    async start(workspace: PluginWorkspace | undefined): Promise<void> {
        // 重复 F5:先停止旧会话
        if (this._state === 'streaming') {
            await this.stop();
        }

        // 0. 前置检查
        if (!(await this.ensureReady(workspace))) {return;}

        // 1. ruff
        this.setState('ruff', workspace);
        const ruffOk = await this.ruffCheck(workspace!);
        if (!ruffOk) {
            this.setState('idle');
            return;
        }

        // 2. 检测日志投射插件(缺失提示,不阻塞)
        await this.ensureLogleakPlugin();

        // 3. 打包
        this.setState('packaging');
        let zip: Buffer;
        try {
            zip = await this.packagePlugin(workspace!);
        } catch (e) {
            vscode.window.showErrorMessage(`打包失败:${(e as Error).message}`);
            this.setState('idle');
            return;
        }

        // 4. 推送
        this.setState('uploading');
        let resp: { plugin_id?: string; [k: string]: unknown };
        try {
            logger.log(`上传 ${workspace!.name}.zip(${zip.length} 字节)`);
            resp = await uploadPluginZip(this.client, zip, `${workspace!.name}.zip`);
            logger.log(`上传完成:${JSON.stringify(resp)}`);
        } catch (e) {
            this.handlePushError(e);
            this.setState('idle');
            return;
        }

        // 5+6. 启动日志观察
        this.setState('streaming');
        const relayStarted = await this.relay.start();
        if (!relayStarted) {
            vscode.window.showInformationMessage(
                `✅ ${workspace!.name} 已推送,但日志投射不可用(未配置 logleakKey 或插件未就绪)`,
            );
        }

        // 7. 通知 + 停止按钮
        await this.showStopNotification(workspace!);
    }

    /** 停止观察日志 → 按 debug.stopAction 处理插件 */
    async stop(): Promise<void> {
        const ws = this._workspace;
        this.relay.stop();
        this.disposeStopNotification();

        if (ws) {
            await this.applyStopAction(ws);
        }
        this.setState('idle');
        vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);
    }

    // ─── 步骤 0:前置检查 ─────────────────────────────────

    private async ensureReady(workspace: PluginWorkspace | undefined): Promise<boolean> {
        const config = getConfig();
        if (!config) {
            const pick = await vscode.window.showErrorMessage(
                '尚未配置 AstrBot 服务器', '创建配置',
            );
            if (pick === '创建配置') {
                vscode.commands.executeCommand('astrbot-devkit.CreateConfig');
            }
            return false;
        }
        if (this.client.state !== 'connected') {
            vscode.window.showInformationMessage('服务器未连接,正在尝试连接…');
            try {
                await this.client.connect();
            } catch (e) {
                const pick = await vscode.window.showErrorMessage(
                    `连接失败:${describeApiError(e)}`, '打开配置', '重试',
                );
                if (pick === '打开配置') {
                    vscode.commands.executeCommand('astrbot-devkit.OpenConfig');
                } else if (pick === '重试') {
                    vscode.commands.executeCommand('astrbot-devkit.Debug', workspace);
                }
                return false;
            }
        }
        if (!workspace) {
            vscode.window.showWarningMessage('请先在侧边栏选择一个插件工作区');
            return false;
        }
        return true;
    }

    // ─── 步骤 1:ruff ────────────────────────────────────

    private async ruffCheck(workspace: PluginWorkspace): Promise<boolean> {
        const root = getWorkspaceRoot();
        if (!root) {return false;}
        const isWin = process.platform === 'win32';
        const venvRuff = path.join(root, isWin ? RUFF_WIN.replace(/\//g, path.sep) : RUFF_UNIX);
        const hasVenvRuff = fs.existsSync(venvRuff);

        let ruffCmd: string | undefined;
        if (hasVenvRuff) {
            ruffCmd = `"${venvRuff}" check ${workspace.dir}`;
        } else {
            const choice = await vscode.window.showInformationMessage(
                '未检测到虚拟环境(.venv),是否创建?',
                '创建', '跳过',
            );
            if (choice === '创建') {
                const created = tool.run('python -m venv .venv', { captureOutput: true });
                if (!created) {
                    vscode.window.showErrorMessage('虚拟环境创建失败,请查看输出面板');
                    logger.show();
                    return false;
                }
                // 创建后 ruff 可能未装,提示安装
                const pyExe = isWin ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
                logger.log('在新建虚拟环境中安装 ruff…');
                const installed = await tool.runStreaming(`"${pyExe}" -m pip install ruff`);
                if (!installed) {
                    vscode.window.showErrorMessage('ruff 安装失败,请手动安装后重试');
                    return false;
                }
                ruffCmd = `"${venvRuff}" check ${workspace.dir}`;
            } else if (choice === '跳过') {
                ruffCmd = `ruff check ${workspace.dir}`;
            } else {
                // 用户取消
                return false;
            }
        }

        const config = getConfig();
        if (config?.debug.ruffFix) {
            ruffCmd += ' --fix';
        }

        logger.separator('ruff 检查');
        const ok = tool.run(ruffCmd, { captureOutput: true });
        if (!ok) {
            vscode.window.showErrorMessage('ruff 检查未通过,请先修复(详情见输出面板)', '查看日志')
                .then(a => { if (a === '查看日志') { logger.show(); } });
            return false;
        }
        return true;
    }

    // ─── 步骤 2:日志插件检测 ─────────────────────────────

    private async ensureLogleakPlugin(): Promise<void> {
        try {
            const plugins = await listPlugins(this.client, { includeReserved: true });
            const installed = plugins.some(p =>
                p.name === LOGLEAK_PLUGIN_ID || p.id === LOGLEAK_PLUGIN_ID,
            );
            if (installed) {return;}
            const pick = await vscode.window.showInformationMessage(
                '未检测到日志投射插件 astrbot_plugin_devkit_for_vscode_logleak,服务器日志将不可用',
                '安装', '继续',
            );
            if (pick === '安装') {
                // repository 待定(见 implementation.md §13);这里走安装流程,失败不阻塞
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: '安装日志投射插件…' },
                    async () => {
                        try {
                            await installPluginFromGithub(this.client, LOGLEAK_PLUGIN_ID);
                            // 确保 logleakKey 存在并写入插件配置
                            await this.ensureLogleakKey();
                            vscode.window.showInformationMessage('✅ 日志投射插件已安装');
                        } catch (e) {
                            vscode.window.showErrorMessage(
                                `日志插件安装失败:${describeApiError(e)}(推送可继续,日志暂不可用)`,
                            );
                        }
                    },
                );
            }
        } catch (e) {
            // 检测失败不阻塞主流程
            logger.error(`检测日志插件时出错:${describeApiError(e)}`);
        }
    }

    /** 确保 logleakKey 已生成并写入本地配置 */
    private async ensureLogleakKey(): Promise<void> {
        const config = getConfig();
        if (!config) {return;}
        if (!config.logleakKey) {
            config.logleakKey = generateKey();
            await saveConfig(config);
        }
        // 注:写入插件端配置需在插件安装后用 savePluginConfig 完成,此处预留;
        // 由于 plugin_id 此时未知且 logleak 服务端插件本阶段不实现,这里只保证本地 key 就位。
    }

    // ─── 步骤 3:打包 ────────────────────────────────────

    private async packagePlugin(workspace: PluginWorkspace): Promise<Buffer> {
        const root = getWorkspaceRoot();
        if (!root) {throw new Error('未打开工作区');}
        const dirAbs = path.isAbsolute(workspace.dir)
            ? workspace.dir
            : path.join(root, workspace.dir);
        if (!fs.existsSync(path.join(dirAbs, 'metadata.yaml'))) {
            throw new Error(`${workspace.dir} 不是插件根(缺少 metadata.yaml)`);
        }
        logger.separator(`打包 ${workspace.name}`);
        // 先删旧 zip
        const tmpDir = path.join(root, '.tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const zipPath = path.join(tmpDir, `${workspace.name}.zip`);
        try { fs.rmSync(zipPath, { force: true }); } catch {}

        const zip = new AdmZip();
        this.addDirToZip(zip, dirAbs, '');
        const buf = zip.toBuffer();
        fs.writeFileSync(zipPath, buf);
        logger.log(`打包完成:${zipPath}(${buf.length} 字节)`);
        return buf;
    }

    /** 递归把 dirRelInZip 下的内容加入 zip;zip 根即插件根内容(main.py 在根) */
    private addDirToZip(zip: AdmZip, dirAbs: string, relInZip: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const name = e.name;
            if (this.isExcluded(name, e.isDirectory())) {continue;}
            const full = path.join(dirAbs, name);
            const zipPath = relInZip ? `${relInZip}/${name}` : name;
            if (e.isDirectory()) {
                this.addDirToZip(zip, full, zipPath);
            } else if (e.isFile()) {
                zip.addLocalFile(full, relInZip);
            }
        }
    }

    /** 是否命中打包排除规则 */
    private isExcluded(name: string, isDir: boolean): boolean {
        for (const rule of ZIP_EXCLUDE) {
            if (rule.endsWith('.pyc')) {
                if (!isDir && name.endsWith('.pyc')) {return true;}
            } else if (rule.includes('*')) {
                // 简单 glob:把 * 转成 .* 做正则
                const re = new RegExp('^' + rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
                if (re.test(name)) {return true;}
            } else {
                if (name === rule) {return true;}
            }
        }
        return false;
    }

    // ─── 推送错误处理 ─────────────────────────────────────

    private handlePushError(e: unknown): void {
        const err = e as ApiError & { kind?: string };
        // 404:upload 端点可能不被该版本支持
        if (err?.kind === 'NOT_FOUND') {
            vscode.window.showErrorMessage(
                '推送失败:服务器不支持 upload 端点(需 AstrBot v4.18+)',
            );
            return;
        }
        vscode.window.showErrorMessage(`推送失败:${describeApiError(e)}`);
    }

    // ─── 通知 + 停止 ─────────────────────────────────────

    private async showStopNotification(workspace: PluginWorkspace): Promise<void> {
        vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', true);
        // 用信息通知承载「停止」按钮;用户点停止或按 Shift+F5 触发 stop()
        void vscode.window.showInformationMessage(
            `正在调试 ${workspace.name}…(日志见「AstrBot Server」通道)`,
            '停止',
        ).then(action => {
            if (action === '停止') {
                void this.stop();
            }
        });
    }

    private disposeStopNotification(): void {
        // 占位:当前通知由 VS Code 自身管理生命周期,无需 dispose
        // 保留方法签名,便于后续切换为 ProgressNotification 等可 dispose 形态
    }

    /** 按 debug.stopAction 处理插件(禁用/保留/询问) */
    private async applyStopAction(workspace: PluginWorkspace): Promise<void> {
        const config = getConfig();
        const action = config?.debug.stopAction ?? 'ask';
        let shouldDisable = false;
        if (action === 'disable') {
            shouldDisable = true;
        } else if (action === 'ask') {
            const pick = await vscode.window.showInformationMessage(
                `是否禁用插件 ${workspace.name}?`, '禁用', '保留',
            );
            shouldDisable = pick === '禁用';
        }
        if (!shouldDisable) {return;}
        try {
            // 用 name 作为 plugin_id 的回退(见 design.md §8.2 步骤 4 注)
            await setPluginEnabled(this.client, workspace.name, false);
            vscode.window.showInformationMessage(`已禁用 ${workspace.name}`);
        } catch (e) {
            vscode.window.showWarningMessage(
                `禁用插件失败(可能需在 WebUI 手动禁用):${describeApiError(e)}`,
            );
        }
    }
}
