// 原生 Debug Adapter(type: astrbot):把「打包 → upload 推送 → 日志观察」
// 包装成 VS Code 原生调试会话。launch.json 控制参数,调试工具栏控制启停。
// 停止逻辑(relay.stop + stopAction)与旧 DebugSession 保持一致,两个入口共用一份。
//
// 注意:插件运行在 AstrBot 服务器进程,本调试器不提供断点;
// 会话语义 = 推送 + 日志观察,直到用户点调试工具栏「停止」。

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import type { AstrBotClient } from '../api/client.js';
import { describeApiError } from '../api/client.js';
import {
    uploadPluginZip, listPlugins, setPluginEnabled, deletePlugin, resolvePluginId,
    installPluginFromGithub,
} from '../api/plugins.js';
import type { PluginWorkspace } from '../config.js';
import {
    getConfig, getActiveWorkspace, getWorkspaceRoot,
} from '../config.js';
import { LogRelay } from '../logs/relay.js';
import * as logger from '../logger.js';
import {
    ZIP_EXCLUDE, LOGLEAK_PLUGIN_ID, LOGLEAK_PLUGIN_REPO,
} from '../constants.js';

/** DAP 请求(DebugProtocolMessage 的细分类型,vscode 命名空间未导出,本地定义) */
interface DapRequest {
    seq: number;
    type: 'request';
    command: string;
    arguments?: unknown;
}

/** DAP 响应 */
interface DapResponse {
    seq: number;
    type: 'response';
    request_seq: number;
    success: boolean;
    command: string;
    body?: unknown;
    message?: string;
}

/** DAP 事件 */
interface DapEvent {
    seq: number;
    type: 'event';
    event: string;
    body?: unknown;
}

/** launch.json 的 launch 配置参数 */
export interface AstrBotLaunchArgs {
    /** 插件名(pluginWorkspaces 中的 name);缺省用当前活跃插件 */
    pluginName?: string;
}

/** 适配器依赖:共享的 client / relay(由 extension 注入,与快速推送共用) */
export interface AdapterDeps {
    getClient: () => AstrBotClient | undefined;
    getRelay: () => LogRelay | undefined;
}

/** AstrBot 原生调试适配器(DAP 子集实现) */
export class AstrBotDebugAdapter implements vscode.DebugAdapter {
    private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.sendEmitter.event;
    private seq = 0;
    private pushedPluginId?: string;
    private lastWorkspace?: PluginWorkspace;

    constructor(private readonly deps: AdapterDeps) {}

    dispose(): void {
        this.sendEmitter.dispose();
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const req = message as DapRequest;
        if (req.type !== 'request') {return;}
        switch (req.command) {
            case 'initialize':
                this.respond(req, {
                    supportsConfigurationDoneRequest: true,
                    supportsTerminateRequest: true,
                    supportsRestartRequest: false,
                });
                // DAP 要求:initialize 响应后必须发送 initialized 事件,
                // 调试 UI(工具栏/会话状态)等它才就绪;不发会卡在初始化、看似无反应
                this.event('initialized');
                break;
            case 'launch':
                this.onLaunch(req);
                break;
            case 'configurationDone':
                this.respond(req);
                break;
            case 'terminate':
            case 'disconnect':
                this.onTerminate(req);
                break;
            default:
                this.respond(req, undefined, false, `不支持的命令:${req.command}`);
        }
    }

    // ─── DAP 辅助 ────────────────────────────────────────

    private nextSeq(): number { return ++this.seq; }

    private respond(
        request: DapRequest,
        body?: unknown,
        success = true,
        message = '',
    ): void {
        const resp: DapResponse = {
            type: 'response',
            seq: this.nextSeq(),
            request_seq: request.seq,
            success,
            command: request.command,
        };
        if (body !== undefined) {resp.body = body;}
        if (message) {resp.message = message;}
        this.sendEmitter.fire(resp);
    }

    private event(event: string, body?: unknown): void {
        const e: DapEvent = {
            type: 'event',
            seq: this.nextSeq(),
            event,
        };
        if (body !== undefined) {e.body = body;}
        this.sendEmitter.fire(e);
    }

    /** 写一行到调试控制台(Debug Console) */
    private output(category: 'stdout' | 'stderr' | 'console', text: string): void {
        this.event('output', { category, output: text });
    }

    // ─── launch / terminate ──────────────────────────────

    private onLaunch(request: DapRequest): void {
        const args = (request.arguments ?? {}) as AstrBotLaunchArgs;
        // 先响应启动,流程异步执行;出错时发 terminated 结束会话
        this.respond(request);
        void this.runDebug(args).catch(err => {
            const msg = (err as Error)?.message ?? String(err);
            this.output('stderr', `❌ ${msg}\n`);
            logger.error(`原生调试失败:${msg}`);
            // 启动失败要让用户看到原因,而不是"点了没反应"
            vscode.window.showErrorMessage(`调试启动失败:${msg}`);
            this.event('terminated');
        });
    }

    private async onTerminate(request: DapRequest): Promise<void> {
        this.respond(request);
        // 同步快速推送的停止逻辑:断开日志 + 按 stopAction 处理插件
        this.deps.getRelay()?.stop();
        if (this.lastWorkspace) {
            await this.applyStopAction(this.lastWorkspace);
        }
        this.event('terminated');
    }

    /** 主流程:前置检查 → 日志插件检测 → 打包 → 上传 → 日志 */
    private async runDebug(args: AstrBotLaunchArgs): Promise<void> {
        const config = getConfig();
        if (!config) {throw new Error('尚未配置 AstrBot 服务器,请先创建配置');}
        const ws = config.pluginWorkspaces?.find(w => w.name === args.pluginName)
            ?? getActiveWorkspace(config);
        if (!ws) {
            throw new Error('未找到插件工作区,请先在侧边栏「本地插件」中选择推送目标');
        }
        this.lastWorkspace = ws;
        this.output('console', `▶ 开始调试 ${ws.name}…\n`);

        // 连接
        const client = this.deps.getClient();
        if (!client) {throw new Error('客户端未就绪,请检查配置');}
        if (client.state !== 'connected') {
            this.output('console', '服务器未连接,正在尝试连接…\n');
            await client.connect();
            this.output('console', `已连接 ${client.baseUrl}\n`);
        }

        // 日志插件检测(缺失不阻塞)
        const logAvailable = await this.ensureLogleakPlugin(client);

        // 打包
        this.output('console', `打包 ${ws.name}…\n`);
        const zip = await this.packagePlugin(ws);

        // 上传
        this.output('console', `上传 ${ws.name}.zip(${zip.length} 字节)…\n`);
        // 上传;失败时若服务器已存在同名插件,删除后重新安装(implementation.md §15 TODO 1)
        const resp = await this.uploadWithRetry(client, zip, `${ws.name}.zip`, ws.name);
        this.pushedPluginId = resp.plugin_id ?? ws.name;
        this.output('console', `✅ ${ws.name} 已推送到服务器\n`);
        vscode.window.showInformationMessage(`✅ ${ws.name} 已推送到服务器`);

        // 日志观察
        const relay = this.deps.getRelay();
        if (!config.debug.receiveLogs) {
            this.output('console', '⚠️ 日志接收已关闭(侧边栏「接收服务器日志」开关),跳过日志流\n');
        } else if (logAvailable && relay) {
            const started = await relay.start();
            if (!started) {
                this.output('console', '⚠️ 日志投射不可用(请检查 astrbotAPIkey 与插件状态)\n');
            } else {
                this.output('console', '日志流已连接,内容见「AstrBot Server」输出通道\n');
            }
        } else {
            this.output('console', '⚠️ 日志投射插件未安装/未启用,日志暂不可用\n');
        }

        // 会话保持运行,直到用户在调试工具栏点「停止」
        this.output('console', `调试中…点击调试工具栏「停止」结束(将按配置的 stopAction 处理插件)\n`);
    }

    /**
     * 上传 zip。
     * - 上传前主动检查服务器是否已有同名插件,有则先删除再上传
     *   (AstrBot 对已存在目录会报「安装失败:目录已存在」);
     * - 上传仍失败时再做一次兜底:重新查找同名插件,有则删除重试。
     */
    private async uploadWithRetry(
        client: AstrBotClient,
        zip: Buffer,
        filename: string,
        pluginName: string,
    ): Promise<{ plugin_id?: string; [k: string]: unknown }> {
        // 上传前:同名插件已存在则先删除(覆盖安装 = 先删后装)
        const preExisting = await resolvePluginId(client, pluginName);
        if (preExisting) {
            this.output('console',
                `检测到同名插件 ${pluginName}(id=${preExisting}),删除后重新安装…\n`);
            await deletePlugin(client, preExisting);
        }
        try {
            return await uploadPluginZip(client, zip, filename);
        } catch (e) {
            const msg = describeApiError(e);
            logger.log(`安装失败(${msg}),做最后一次兜底重试…`);
            this.output('stderr', `⚠️ 安装失败:${msg},尝试删除残留同名插件后重试…\n`);
            const pluginId = await resolvePluginId(client, pluginName);
            if (!pluginId) {
                this.output('stderr', '服务器上未找到同名插件,保留原错误\n');
                throw e;
            }
            this.output('console', `重试:删除同名插件 ${pluginName}(id=${pluginId})后重新上传…\n`);
            await deletePlugin(client, pluginId);
            return await uploadPluginZip(client, zip, filename);
        }
    }

    // ─── 步骤实现 ───────────────────────────────────────

    private async ensureLogleakPlugin(client: AstrBotClient): Promise<boolean> {
        try {
            const plugins = await listPlugins(client, { includeReserved: true });
            const plugin = plugins.find(p =>
                p.name === LOGLEAK_PLUGIN_ID || p.id === LOGLEAK_PLUGIN_ID,
            );
            // 已安装且启用(字段以实际响应为准:enabled / activated)
            if (plugin && plugin.enabled !== false && plugin.activated !== false) {
                return true;
            }
            if (plugin && (plugin.enabled === false || plugin.activated === false)) {
                this.output('console', '⚠️ 日志投射插件已禁用,请在 AstrBot WebUI 启用\n');
                return false;
            }
            // 未安装:通知用户,从 GitHub 一键安装
            const pick = await vscode.window.showInformationMessage(
                '未检测到日志投射插件 astrbot_plugin_devkit_for_vscode_logleak。\n' +
                '点击「从 GitHub 安装」将自动安装:' +
                'https://github.com/17-qxm/astrbot_plugin_devkit_for_vscode_logleak',
                '从 GitHub 安装', '继续',
            );
            if (pick !== '从 GitHub 安装') {
                this.output('console', '⚠️ 未安装日志投射插件,日志暂不可用\n');
                return false;
            }
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: '正在从 GitHub 安装日志投射插件…',
                    },
                    () => installPluginFromGithub(client, LOGLEAK_PLUGIN_REPO),
                );
                this.output('console', '✅ 已从 GitHub 安装日志投射插件\n');
                // 等待服务器加载插件(最多约 5s);已启用则本会话直接连日志
                for (let i = 0; i < 5; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        const list = await listPlugins(client, { includeReserved: true });
                        const p = list.find(x =>
                            x.name === LOGLEAK_PLUGIN_ID || x.id === LOGLEAK_PLUGIN_ID,
                        );
                        if (p && p.enabled !== false && p.activated !== false) {
                            this.output('console', '✅ 日志投射插件已就绪\n');
                            return true;
                        }
                    } catch {}
                }
                vscode.window.showInformationMessage(
                    '日志投射插件已安装,若未启用请在 AstrBot WebUI 确认,然后重新调试',
                );
                return false;
            } catch (e) {
                const msg = describeApiError(e);
                this.output('stderr', `日志插件安装失败:${msg}\n`);
                // 自动安装失败 → 引导用户用 GitHub 链接手动安装
                const repoUrl = `https://github.com/${LOGLEAK_PLUGIN_REPO}`;
                vscode.window.showErrorMessage(
                    `日志投射插件自动安装失败:${msg}\n可打开 GitHub 手动安装:${repoUrl}`,
                    '打开 GitHub',
                ).then(action => {
                    if (action === '打开 GitHub') {
                        void vscode.env.openExternal(vscode.Uri.parse(repoUrl));
                    }
                });
                return false;
            }
        } catch (e) {
            logger.error(`检测日志插件时出错:${describeApiError(e)}`);
            return false;
        }
    }

    private async packagePlugin(workspace: PluginWorkspace): Promise<Buffer> {
        const root = getWorkspaceRoot();
        if (!root) {throw new Error('未打开工作区');}
        const dirAbs = path.isAbsolute(workspace.dir)
            ? workspace.dir
            : path.join(root, workspace.dir);
        if (!fs.existsSync(path.join(dirAbs, 'metadata.yaml'))) {
            throw new Error(`${workspace.dir} 不是插件根(缺少 metadata.yaml)`);
        }
        const tmpDir = path.join(root, '.tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const zipPath = path.join(tmpDir, `${workspace.name}.zip`);
        try { fs.rmSync(zipPath, { force: true }); } catch {}
        const zip = new AdmZip();
        this.addDirToZip(zip, dirAbs, '');
        const buf = zip.toBuffer();
        fs.writeFileSync(zipPath, buf);
        return buf;
    }

    private addDirToZip(zip: AdmZip, dirAbs: string, relInZip: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch {return;}
        for (const e of entries) {
            if (this.isExcluded(e.name, e.isDirectory())) {continue;}
            const full = path.join(dirAbs, e.name);
            const zipPath = relInZip ? `${relInZip}/${e.name}` : e.name;
            if (e.isDirectory()) {
                this.addDirToZip(zip, full, zipPath);
            } else if (e.isFile()) {
                zip.addLocalFile(full, relInZip);
            }
        }
    }

    private isExcluded(name: string, isDir: boolean): boolean {
        for (const rule of ZIP_EXCLUDE) {
            if (rule.endsWith('.pyc')) {
                if (!isDir && name.endsWith('.pyc')) {return true;}
            } else if (rule.includes('*')) {
                const re = new RegExp('^' + rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
                if (re.test(name)) {return true;}
            } else {
                if (name === rule) {return true;}
            }
        }
        return false;
    }

    /** 停止调试后按 debug.stopAction 处理插件 */
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
        const client = this.deps.getClient();
        if (!client) {return;}
        try {
            await setPluginEnabled(client, this.pushedPluginId ?? workspace.name, false);
            vscode.window.showInformationMessage(`已禁用 ${workspace.name}`);
        } catch (e) {
            vscode.window.showWarningMessage(
                `禁用插件失败(可能需在 WebUI 手动禁用):${describeApiError(e)}`,
            );
        }
    }
}
