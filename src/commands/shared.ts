// src/commands/shared.ts
// 命令共享辅助。

import type { PluginWorkspace } from '../config/index.js';

/** 从命令参数取 workspace(侧边栏点击时传 DevkitNode 或 PluginWorkspace) */
export function workspaceFromArg(arg: unknown): PluginWorkspace | undefined {
    // 侧边栏点击时传 DevkitNode 或 PluginWorkspace
    if (!arg) {return undefined;}
    if (typeof arg === 'object') {
        if ('workspace' in (arg as object)) {
            return (arg as { workspace: PluginWorkspace }).workspace;
        }
        if ('name' in (arg as object) && 'dir' in (arg as object)) {
            return arg as PluginWorkspace;
        }
    }
    return undefined;
}
