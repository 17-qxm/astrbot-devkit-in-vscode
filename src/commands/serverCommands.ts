// src/commands/serverCommands.ts
// 服务器交互命令:连接、刷新、推送消息、列出服务器插件。

import * as vscode from 'vscode';
import { getConfig } from '../config/index.js';
import { describeApiError } from '../api/client.js';
import * as pluginsApi from '../api/plugins.js';
import * as imApi from '../api/im.js';
import { OUTPUT_CHANNEL_SERVER } from '../constants.js';
import type { AppContext } from '../context.js';
import type { CommandDef } from './registry.js';

export function serverCommands(app: AppContext): CommandDef[] {
    return [
        // ── 视图刷新 ──
        {
            id: 'astrbot-devkit.Refresh',
            handler: async () => {
                // 仅当连接相关配置(server/key)变化时才重建 client;
                // 否则只刷新视图 + 重连,避免销毁日志通道/断开日志流
                const cur = getConfig();
                if (cur && configKey(cur) !== app.clientConfigKey) {
                    app.rebuildClient();
                } else if (!cur && app.client) {
                    app.rebuildClient();
                }
                app.syncContext();
                const client = app.client;
                if (client && client.state !== 'connected') {
                    try { await client.connect(); } catch {}
                }
                app.syncContext();
            },
        },

        // ── 连接服务器 ──
        {
            id: 'astrbot-devkit.Connect',
            handler: async () => {
                if (!app.ensureClient()) {return;}
                const target = app.client!;
                try {
                    await target.connect();
                    app.syncContext();
                    // 连接期间配置若被重建(client 被替换),不再弹旧配置的通知
                    if (app.client === target) {
                        vscode.window.showInformationMessage('✅ 已连接到 AstrBot 服务器');
                    }
                } catch (e) {
                    if (app.client === target) {
                        vscode.window.showErrorMessage(`连接失败:${describeApiError(e)}`);
                    }
                }
            },
        },

        // ── 推送消息(im,阶段 5) ──
        {
            id: 'astrbot-devkit.SendMessage',
            handler: async () => {
                if (!app.ensureClient()) {return;}
                try {
                    const bots = await imApi.listBots(app.client!);
                    if (bots.length === 0) {
                        vscode.window.showWarningMessage('服务器上没有可用的 IM 平台/UMO');
                        return;
                    }
                    const umo = await vscode.window.showQuickPick(
                        bots.map(b => ({ label: b.id, description: String(b.name ?? b.id), bot: b })),
                        { title: '选择目标平台/UMO', placeHolder: 'umo ID' },
                    );
                    if (!umo) {return;}
                    const text = await vscode.window.showInputBox({
                        prompt: '输入要推送的文本消息',
                        placeHolder: 'Hello',
                    });
                    if (!text) {return;}
                    await imApi.sendMessage(app.client!, umo.bot.id, text);
                    vscode.window.showInformationMessage(`✅ 已发送到 ${umo.bot.id}`);
                } catch (e) {
                    vscode.window.showErrorMessage(`发送失败:${describeApiError(e)}`);
                }
            },
        },

        // ── 列出服务器插件(辅助命令,便于排查) ──
        {
            id: 'astrbot-devkit.ListServerPlugins',
            handler: async () => {
                if (!app.ensureClient()) {return;}
                try {
                    const list = await pluginsApi.listPlugins(app.client!, { includeReserved: true });
                    const ch = vscode.window.createOutputChannel(OUTPUT_CHANNEL_SERVER);
                    ch.clear();
                    ch.appendLine(`服务器插件共 ${list.length} 个:`);
                    for (const p of list) {
                        ch.appendLine(`  ${p.name} (id=${p.id}, v${p.version ?? '?'}, enabled=${p.enabled})`);
                    }
                    ch.show(true);
                } catch (e) {
                    vscode.window.showErrorMessage(`获取插件列表失败:${describeApiError(e)}`);
                }
            },
        },
    ];
}

/** 连接相关配置快照(server|key),用于判断是否需要重建 */
function configKey(c: { astrbotServer: string; astrbotAPIkey: string }): string {
    return `${c.astrbotServer}|${c.astrbotAPIkey}`;
}
