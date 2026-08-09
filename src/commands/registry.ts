// src/commands/registry.ts
// 命令注册表:扩展对外的命令唯一权威清单。
// 命令 ID 全部不变(handler 由原 extension.ts 内联块搬移而来)。

import * as vscode from 'vscode';
import { InitEnv } from '../initenv/index.js';
import { WorkspaceCheck } from '../initenv/workspaceCheck.js';
import type { AppContext } from '../context.js';
import { configCommands } from './configCommands.js';
import { pluginCommands } from './pluginCommands.js';
import { debugCommands } from './debugCommands.js';
import { serverCommands } from './serverCommands.js';

export interface CommandDef {
    id: string;
    handler: (...args: unknown[]) => unknown;
}

/** 注册全部命令(21 个) */
export function registerCommands(context: vscode.ExtensionContext, app: AppContext): void {
    const defs: CommandDef[] = [
        // ── launch.json ${command:...} 动态取值:当前活跃插件名 ──
        { id: 'astrbot-devkit.GetActivePluginName', handler: () => app.activePluginName },

        // ── 原有命令:InitEnv / WorkspaceCheck ──
        { id: 'astrbot-devkit-in-vscode.InitEnv', handler: () => InitEnv() },
        { id: 'astrbot-devkit-in-vscode.WorkspaceCheck', handler: () => WorkspaceCheck() },

        ...configCommands(app),
        ...pluginCommands(app),
        ...debugCommands(app),
        ...serverCommands(app),
    ];

    for (const def of defs) {
        context.subscriptions.push(vscode.commands.registerCommand(def.id, def.handler));
    }
}
