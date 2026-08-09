// src/commands/configCommands.ts
// 配置相关命令:创建/打开/编辑服务器地址、自动连接/日志开关、停止动作。

import * as vscode from 'vscode';
import {
    getConfig, saveConfig, getConfigFilePath,
} from '../config/index.js';
import { runConfigWizard } from '../configWizard.js';
import type { AppContext } from '../context.js';
import type { CommandDef } from './registry.js';

export function configCommands(app: AppContext): CommandDef[] {
    return [
        // ── 创建配置(向导) ──
        {
            id: 'astrbot-devkit.CreateConfig',
            handler: async () => {
                await runConfigWizard(() => app.syncContext());
            },
        },

        // ── 打开配置文件 ──
        {
            id: 'astrbot-devkit.OpenConfig',
            handler: async () => {
                const file = getConfigFilePath();
                if (!file) {
                    vscode.window.showWarningMessage('未打开工作区');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                await vscode.window.showTextDocument(doc);
            },
        },

        // ── 修改服务器地址 ──
        {
            id: 'astrbot-devkit.EditServerAddress',
            handler: async () => {
                const config = getConfig();
                const addr = await vscode.window.showInputBox({
                    prompt: 'AstrBot 服务器地址(host:port 或 http(s)://…)',
                    value: config?.astrbotServer ?? '127.0.0.1:6185',
                    validateInput: v => /^https?:\/\/|^[a-zA-Z0-9.\-]+(:[0-9]+)?/.test(v.trim())
                        ? undefined : '格式不正确,支持 host:port 或 http(s)://…',
                });
                if (!addr) {return;}
                const cur = getConfig();
                if (cur) {
                    cur.astrbotServer = addr.trim();
                    await saveConfig(cur);
                    app.syncContext();
                }
            },
        },

        // ── 自动连接开关 ──
        {
            id: 'astrbot-devkit.ToggleAutoConnect',
            handler: async () => {
                const config = getConfig();
                if (!config) {return;}
                config.autoConnect = !(config.autoConnect ?? true);
                await saveConfig(config);
                app.syncContext();
                vscode.window.showInformationMessage(
                    `启动时自动连接服务器已${config.autoConnect ? '开启' : '关闭'}`,
                );
            },
        },

        // ── 接收服务器日志开关 ──
        {
            id: 'astrbot-devkit.ToggleLogs',
            handler: async () => {
                const config = getConfig();
                if (!config) {return;}
                config.debug.receiveLogs = !config.debug.receiveLogs;
                await saveConfig(config);
                app.syncContext();
                if (config.debug.receiveLogs) {
                    // 开启:立即开始接收日志(独立于调试会话,现在生效)
                    const relay = app.relay;
                    if (relay) {
                        // 开关开启不清空通道历史(clearFirst=false),继续追加
                        const ok = await relay.start(false);
                        if (!ok) {
                            vscode.window.showWarningMessage(
                                '日志连接失败,请检查 astrbotAPIkey 与日志投射插件状态',
                            );
                        } else {
                            vscode.window.showInformationMessage('已开启日志接收');
                        }
                    } else {
                        vscode.window.showWarningMessage('客户端未就绪,请先配置并连接服务器');
                    }
                } else {
                    app.relay?.stop();
                    vscode.window.showInformationMessage('已关闭日志接收');
                }
            },
        },

        // ── 调试结束后处理 ──
        {
            id: 'astrbot-devkit.EditStopAction',
            handler: async () => {
                const config = getConfig();
                if (!config) {return;}
                const labels: Record<string, string> = {
                    ask: '每次询问(默认)',
                    disable: '直接禁用插件',
                    keep: '保留运行',
                };
                const pick = await vscode.window.showQuickPick(
                    (['ask', 'disable', 'keep'] as const).map(v => ({
                        label: labels[v],
                        value: v,
                    })),
                    {
                        title: '调试结束后对插件的处理',
                        placeHolder: `当前:${labels[config.debug.stopAction]}`,
                    },
                );
                if (!pick) {return;}
                config.debug.stopAction = pick.value;
                await saveConfig(config);
                app.syncContext();
            },
        },
    ];
}
