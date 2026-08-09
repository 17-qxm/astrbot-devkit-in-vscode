// 原生 Debug Adapter(type: astrbot):把「打包 → upload 推送 → 日志观察」
// 包装成 VS Code 原生调试会话。launch.json 控制参数,调试工具栏控制启停。
// 停止时按 stopAction 处理插件;日志接收由侧边栏开关独立控制,不随调试结束自动断开。
//
// 注意:插件运行在 AstrBot 服务器进程,本调试器不提供断点;
// 会话语义 = 推送 + 日志观察,直到用户点调试工具栏「停止」。

import * as vscode from 'vscode';
import { describeApiError } from '../api/client.js';
import { setPluginEnabled } from '../api/plugins.js';
import { getConfig, getActiveWorkspace, type PluginWorkspace } from '../config/index.js';
import { LogRelay } from '../logs/relay.js';
import * as logger from '../logger.js';
import { DapBase, type DapRequest } from './protocol.js';
import { packagePlugin, pushPlugin } from './push.js';
import { ensureLogleakPlugin } from './logleak.js';
import type { AstrBotClient } from '../api/client.js';

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
export class AstrBotDebugAdapter extends DapBase {
    private pushedPluginId?: string;
    private lastWorkspace?: PluginWorkspace;

    constructor(private readonly deps: AdapterDeps) {
        super();
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
        // 日志接收由侧边栏「接收服务器日志」开关独立控制,调试结束不自动断开
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
        const logAvailable = await ensureLogleakPlugin(client, (c, t) => this.output(c, t));

        // 打包
        this.output('console', `打包 ${ws.name}…\n`);
        const zip = await packagePlugin(ws);

        // 上传
        this.output('console', `上传 ${ws.name}.zip(${zip.length} 字节)…\n`);
        // 上传;失败时若服务器已存在同名插件,删除后重新安装(implementation.md §15 TODO 1)
        const resp = await pushPlugin(client, zip, `${ws.name}.zip`, ws.name, (c, t) => this.output(c, t));
        this.pushedPluginId = resp.plugin_id ?? ws.name;
        this.output('console', `✅ ${ws.name} 已推送到服务器\n`);
        vscode.window.showInformationMessage(`✅ ${ws.name} 已推送到服务器`);

        // 日志观察
        const relay = this.deps.getRelay();
        if (!config.debug.receiveLogs) {
            this.output('console', '⚠️ 日志接收已关闭(侧边栏「接收服务器日志」开关),跳过日志流\n');
        } else if (relay?.isRunning) {
            this.output('console', '日志流已在接收中,内容见「AstrBot Server」输出通道\n');
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
