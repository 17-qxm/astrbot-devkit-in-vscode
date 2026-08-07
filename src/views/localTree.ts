// 侧边栏「本地插件」单选列表:数据源为 .vscode/astrbot-devkit-config.json 的
// pluginWorkspaces。单击单选设定 F5 推送目标(active 唯一),与主视图的活跃插件保持一致。

import * as vscode from 'vscode';
import { getConfig, getWorkspaceRoot, type PluginWorkspace } from '../config.js';

export type LocalNode =
    | { kind: 'plugin'; workspace: PluginWorkspace; active: boolean }
    | { kind: 'placeholder'; message: string; command?: string };

/** 本地插件单选列表数据源 */
export class DevkitLocalProvider implements vscode.TreeDataProvider<LocalNode> {
    private readonly _emitter = new vscode.EventEmitter<LocalNode | undefined>();
    readonly onDidChangeTreeData = this._emitter.event;

    refresh(): void {
        this._emitter.fire(undefined);
    }

    getTreeItem(element: LocalNode): vscode.TreeItem {
        const item = new vscode.TreeItem('') as vscode.TreeItem & { node: LocalNode };
        if (element.kind === 'placeholder') {
            item.label = element.message;
            item.contextValue = 'devkitLocalPlaceholder';
            item.iconPath = new vscode.ThemeIcon('info');
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            if (element.command) {
                item.command = { command: element.command, title: element.command };
            }
            item.node = element;
            return item;
        }
        const ws = element.workspace;
        item.label = `${ws.name} ${ws.version}`;
        item.description = element.active ? '当前推送目标' : ws.dir;
        item.contextValue = element.active ? 'devkitLocalPluginActive' : 'devkitLocalPlugin';
        item.iconPath = new vscode.ThemeIcon(
            element.active ? 'circle-large-filled' : 'circle-large-outline',
        );
        item.tooltip = [
            `插件:${ws.name}`,
            `版本:${ws.version}`,
            `目录:${ws.dir}`,
            element.active ? '(当前 F5 推送目标)' : '',
        ].filter(Boolean).join('\n');
        item.command = {
            command: element.active ? 'astrbot-devkit.Debug' : 'astrbot-devkit.SetActivePlugin',
            title: element.active ? 'Debug' : '设为推送目标',
            arguments: [ws],
        };
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.node = element;
        return item;
    }

    getChildren(): LocalNode[] {
        if (!getWorkspaceRoot()) {
            return [{ kind: 'placeholder', message: '未打开工作区' }];
        }
        const workspaces = getConfig()?.pluginWorkspaces ?? [];
        if (workspaces.length === 0) {
            return [{
                kind: 'placeholder',
                message: '暂无插件工作区,点击扫描',
                command: 'astrbot-devkit.ScanPlugins',
            }];
        }
        return workspaces.map(ws => ({
            kind: 'plugin',
            workspace: ws,
            active: !!ws.active,
        }));
    }
}
