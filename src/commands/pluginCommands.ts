// src/commands/pluginCommands.ts
// 插件工作区命令:添加/扫描/设活跃/打开/推送插件配置。

import * as vscode from 'vscode';
import {
    getConfig, getWorkspaceRoot, ensureConfigFile,
    addPluginCandidates, scanWorkspaceForPlugins, isPluginRoot,
    setActiveWorkspace as persistActiveWorkspace, getActiveWorkspace,
} from '../config/index.js';
import {
    openPluginConfigForm,
} from '../views/configForm.js';
import {
    pushPluginConfig,
} from '../views/configEditor.js';
import type { AppContext } from '../context.js';
import type { CommandDef } from './registry.js';
import { workspaceFromArg } from './shared.js';

/** 把候选插件加入 pluginWorkspaces(去重),并尝试标记第一个为活跃 */
export async function addWorkspaces(
    app: AppContext,
    cands: { dir: string; name: string; version: string }[],
): Promise<void> {
    const config = getConfig();
    if (!config) {
        // 配置不存在:先创建模板,再加入
        await ensureConfigFile();
    }
    const added = await addPluginCandidates(cands);
    app.syncContext();
    if (added > 0) {
        vscode.window.showInformationMessage(`已加入 ${added} 个插件工作区`);
    }
}

export function pluginCommands(app: AppContext): CommandDef[] {
    return [
        // ── 添加插件工作区 ──
        {
            id: 'astrbot-devkit.AddWorkspace',
            handler: async () => {
                const root = getWorkspaceRoot();
                const folders = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    defaultUri: root ? vscode.Uri.file(root) : undefined,
                    openLabel: '选择插件根目录(含 metadata.yaml)',
                });
                if (!folders || folders.length === 0) {return;}
                const candidate = isPluginRoot(folders[0].fsPath);
                if (!candidate) {
                    vscode.window.showErrorMessage('所选目录不是插件根(缺少 metadata.yaml 或 name/version 字段)');
                    return;
                }
                await addWorkspaces(app, [candidate]);
            },
        },

        // ── 扫描插件 ──
        {
            id: 'astrbot-devkit.ScanPlugins',
            handler: async () => {
                const cands = scanWorkspaceForPlugins();
                if (cands.length === 0) {
                    vscode.window.showInformationMessage('未在工作区中检测到 AstrBot 插件(需含 metadata.yaml 且有 name+version)');
                    return;
                }
                const config = getConfig();
                const existing = new Set((config?.pluginWorkspaces ?? []).map(w => w.name));
                const picks = await vscode.window.showQuickPick(
                    cands.map(c => ({
                        label: c.name,
                        description: c.version,
                        detail: c.dir,
                        picked: existing.has(c.name),
                        candidate: c,
                    })),
                    { canPickMany: true, title: `检测到 ${cands.length} 个插件,选择要加入配置的`, placeHolder: '勾选要加入/保留的插件' },
                );
                if (!picks) {return;}
                await addWorkspaces(app, picks.map(p => p.candidate));
            },
        },

        // ── 设置活跃插件 ──
        {
            id: 'astrbot-devkit.SetActivePlugin',
            handler: async (arg: unknown) => {
                const ws = workspaceFromArg(arg);
                if (!ws) {return;}
                await persistActiveWorkspace(ws.name);
                app.syncContext();
            },
        },

        // ── 打开插件配置(默认走表单;表单内可切到原始 JSON)──
        {
            id: 'astrbot-devkit.OpenPluginConfig',
            handler: async (arg: unknown) => {
                if (!app.ensureClient()) {return;}
                const ws = workspaceFromArg(arg) ?? getActiveWorkspace(getConfig());
                if (!ws) {
                    vscode.window.showWarningMessage('请先选择一个插件工作区');
                    return;
                }
                await openPluginConfigForm(app.client!, ws);
            },
        },

        // ── 推送插件配置 ──
        {
            id: 'astrbot-devkit.SavePluginConfig',
            handler: async () => {
                if (!app.ensureClient()) {return;}
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('没有活动编辑器');
                    return;
                }
                await pushPluginConfig(app.client!, editor);
            },
        },
    ];
}
