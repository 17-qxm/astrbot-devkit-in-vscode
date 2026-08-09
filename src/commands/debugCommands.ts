// src/commands/debugCommands.ts
// 调试相关命令:启动/停止 Debug、打开服务器日志通道。

import * as vscode from 'vscode';
import { getConfig, getActiveWorkspace } from '../config/index.js';
import { OUTPUT_CHANNEL_SERVER } from '../constants.js';
import { promptCreateConfig, type AppContext } from '../context.js';
import type { CommandDef } from './registry.js';
import { workspaceFromArg } from './shared.js';

export function debugCommands(app: AppContext): CommandDef[] {
    return [
        // ── Debug:以原生调试会话启动(动态配置,无需 launch.json;状态栏/节点按钮入口) ──
        {
            id: 'astrbot-devkit.Debug',
            handler: async (arg?: unknown) => {
                const config = getConfig();
                if (!config) {
                    promptCreateConfig('尚未配置 AstrBot 服务器', '创建配置');
                    return;
                }
                if (!config.astrbotAPIkey) {
                    promptCreateConfig('尚未配置 AstrBot API Key,请先配置服务器连接', '去配置');
                    return;
                }
                let ws = workspaceFromArg(arg);
                if (!ws) {
                    ws = getActiveWorkspace(config);
                }
                if (!ws) {
                    vscode.window.showWarningMessage('请先在侧边栏「本地插件」中选择推送目标');
                    return;
                }
                // 反复启动:已有 astrbot 调试会话时,先停止再重新启动(避免多会话/状态错乱)
                const running = vscode.debug.activeDebugSession;
                if (running?.type === 'astrbot') {
                    await vscode.debug.stopDebugging(running);
                }
                const folder = vscode.workspace.workspaceFolders?.[0];
                await vscode.debug.startDebugging(folder, {
                    type: 'astrbot',
                    request: 'launch',
                    name: `快速推送:${ws.name}`,
                    pluginName: ws.name,
                });
            },
        },

        // ── 停止 Debug(状态栏按钮;原生调试由调试工具栏负责) ──
        {
            id: 'astrbot-devkit.StopDebug',
            handler: async () => {
                const session = vscode.debug.activeDebugSession;
                if (session?.type === 'astrbot') {
                    await vscode.debug.stopDebugging(session);
                } else {
                    // 无活跃原生会话时,兜底断开日志流
                    app.relay?.stop();
                }
            },
        },

        // ── 打开服务器日志通道 ──
        {
            id: 'astrbot-devkit.OpenServerLogs',
            handler: async () => {
                // 未配置时给出提示;已配置则复用/重建 client+relay,展示「AstrBot Server」通道
                if (!getConfig()) {
                    const ch = vscode.window.createOutputChannel(OUTPUT_CHANNEL_SERVER);
                    ch.appendLine('尚未配置 AstrBot 服务器');
                    ch.show(true);
                    return;
                }
                if (!app.relay) {
                    app.rebuildClient();
                }
                app.relay!.outputChannel.show(true);
            },
        },
    ];
}
