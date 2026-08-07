// src/views/devkitTree.ts
// 侧边栏 TreeDataProvider。焦点是本地 pluginWorkspaces,不展示服务器端已安装列表。
// 见 implementation.md §6 与 design.md §7。

import * as vscode from 'vscode';
import type { ConnectionState } from '../api/client.js';
import type { PluginWorkspace } from '../config.js';
import { getConfig, getWorkspaceRoot } from '../config.js';

// ─── 节点类型 ────────────────────────────────────────────

export type DevkitNode =
    | { kind: 'root' }
    | { kind: 'server'; state: ConnectionState; address: string }
    | { kind: 'workspace'; workspace: PluginWorkspace; active: boolean }
    | { kind: 'pluginConfig'; workspace: PluginWorkspace }
    | { kind: 'autoConnectToggle'; enabled: boolean }
    | { kind: 'stopAction'; action: 'ask' | 'disable' | 'keep' }
    | { kind: 'logs' }
    | { kind: 'logsToggle'; enabled: boolean }
    | { kind: 'placeholder'; message: string; command?: string };

/** TreeItem 的额外数据:附带节点本身,供命令回调取用 */
export interface DevkitItem extends vscode.TreeItem {
    readonly node: DevkitNode;
}

// ─── Provider ────────────────────────────────────────────

/**
 * 侧边栏数据源。状态来源:
 *  - pluginWorkspaces → getConfig()
 *  - 连接状态 → setConnectionState() 由 extension 在 connect/探活后写入
 *  - debug 状态 → setDebugging() 由 vscode.debug 会话事件写入(extension.ts)
 *
 * 任一变化都调 refresh() 触发重绘。
 */
export class DevkitTreeProvider implements vscode.TreeDataProvider<DevkitNode> {
    private _connection: ConnectionState = 'unconfigured';
    private _serverAddress = '';
    private _debugging = false;
    private readonly _emitter = new vscode.EventEmitter<DevkitNode | undefined>();
    readonly onDidChangeTreeData = this._emitter.event;

    /** 由 extension 设置连接状态(连接成功/失败/探活后) */
    setConnectionState(state: ConnectionState, address?: string): void {
        this._connection = state;
        if (address !== undefined) {this._serverAddress = address;}
        this.refresh();
    }

/** 由 extension 在原生调试会话启停时调用(影响日志节点展示) */
    setDebugging(debugging: boolean): void {
        this._debugging = debugging;
        this.refresh();
    }

    refresh(): void {
        this._emitter.fire(undefined);
    }

    getTreeItem(element: DevkitNode): vscode.TreeItem {
        const item = this.toTreeItem(element);
        return item;
    }

    getChildren(element?: DevkitNode): DevkitNode[] {
        // 根 → 展开
        if (!element) {
            return this.rootChildren();
        }
        // 根节点本身不再有子项,层级保持扁平以提升可读性
        return [];
    }

    // ─── 渲染 ────────────────────────────────────────────

    /** 把节点数据转成 TreeItem(带 contextValue / icon / command) */
    private toTreeItem(node: DevkitNode): DevkitItem {
        switch (node.kind) {
            case 'root': {
                const item = this.base('AstrBot DevKit', 'devkitRoot', node);
                item.collapsibleState = vscode.TreeItemCollapsibleState.None;
                item.iconPath = new vscode.ThemeIcon('robot');
                return item;
            }
            case 'server': {
                const item = this.base(`服务器 ${node.address || '(未配置)'}`, 'devkitServer', node);
                item.description = this.describeServer(node.state);
                item.iconPath = new vscode.ThemeIcon(
                    node.state === 'connected' ? 'vm-connect' : 'vm-active',
                );
                item.tooltip = `AstrBot 服务器\n地址:${node.address || '(未配置)'}\n状态:${this.describeServer(node.state)}`;
                return item;
            }
            case 'workspace': {
                const ctx = node.active ? 'devkitWorkspaceActive' : 'devkitWorkspace';
                const label = node.workspace.name + (node.workspace.version ? ` ${node.workspace.version}` : '');
                const item = this.base(label, ctx, node);
                item.description = node.active ? '当前活跃' : node.workspace.dir;
                item.iconPath = new vscode.ThemeIcon(
                    node.active ? 'circle-large-filled' : 'circle-large-outline',
                );
                item.tooltip = `插件:${node.workspace.name}\n版本:${node.workspace.version}\n目录:${node.workspace.dir}${node.active ? '\n(当前 Debug 目标)' : ''}`;
                // 活跃节点点击触发 Debug;非活跃点击设为活跃
                item.command = {
                    command: node.active ? 'astrbot-devkit.Debug' : 'astrbot-devkit.SetActivePlugin',
                    title: node.active ? 'Debug' : 'Set Active',
                    arguments: [node.workspace],
                };
                return item;
            }
            case 'pluginConfig': {
                const item = this.base(`当前插件配置 (${node.workspace.name})`, 'devkitPluginConfig', node);
                item.iconPath = new vscode.ThemeIcon('settings-gear');
                item.command = {
                    command: 'astrbot-devkit.OpenPluginConfig',
                    title: 'Open Plugin Config',
                    arguments: [node.workspace],
                };
                return item;
            }
            case 'autoConnectToggle': {
                const item = this.base(
                    `自动连接服务器:${node.enabled ? '开' : '关'}`,
                    'devkitAutoConnectToggle',
                    node,
                );
                item.description = node.enabled ? '启动时自动拉取' : '需手动连接';
                item.iconPath = new vscode.ThemeIcon(
                    node.enabled ? 'check' : 'circle-outline',
                );
                item.tooltip = '启动时是否自动连接/拉取 AstrBot 服务器信息,点击切换';
                item.command = {
                    command: 'astrbot-devkit.ToggleAutoConnect',
                    title: 'Toggle auto connect',
                };
                return item;
            }
            case 'stopAction': {
                const label: Record<string, string> = {
                    ask: '每次询问',
                    disable: '直接禁用',
                    keep: '保留运行',
                };
                const item = this.base(
                    `调试结束后:${label[node.action]}`,
                    'devkitStopAction',
                    node,
                );
                item.description = '点击修改';
                item.iconPath = new vscode.ThemeIcon('debug-stop');
                item.tooltip = '停止 debug 后对插件的处理:每次询问 / 直接禁用 / 保留运行';
                item.command = {
                    command: 'astrbot-devkit.EditStopAction',
                    title: 'Edit stop action',
                };
                return item;
            }
            case 'logs': {
                const item = this.base('日志', 'devkitLogs', node);
                item.description = this._debugging ? '观察中' : 'AstrBot Server';
                item.iconPath = new vscode.ThemeIcon('output');
                item.command = {
                    command: 'astrbot-devkit.OpenServerLogs',
                    title: 'Open Server Logs',
                };
                return item;
            }
            case 'logsToggle': {
                const item = this.base(
                    `接收服务器日志:${node.enabled ? '开' : '关'}`,
                    'devkitLogsToggle',
                    node,
                );
                item.description = node.enabled ? '点击关闭' : '点击开启';
                item.iconPath = new vscode.ThemeIcon(
                    node.enabled ? 'check' : 'circle-outline',
                );
                item.tooltip = '控制是否接收并显示服务器日志(调试时实时生效),点击切换';
                item.command = {
                    command: 'astrbot-devkit.ToggleLogs',
                    title: 'Toggle server logs',
                };
                return item;
            }
            case 'placeholder': {
                const item = this.base(node.message, 'devkitPlaceholder', node);
                item.iconPath = new vscode.ThemeIcon('info');
                if (node.command) {
                    item.command = { command: node.command, title: node.command };
                }
                return item;
            }
        }
    }

    private base(label: string, contextValue: string, node: DevkitNode): DevkitItem {
        const item = new vscode.TreeItem(label) as DevkitItem;
        item.contextValue = contextValue;
        (item as { node: DevkitNode }).node = node;
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        return item;
    }

    private describeServer(state: ConnectionState): string {
        switch (state) {
            case 'connected': return '已连接';
            case 'checking': return '连接中…';
            case 'error': return '未连接';
            case 'unconfigured':
            default: return '配置缺失';
        }
    }

    /** 根节点的子项:服务器 + 插件工作区组 + 配置 + 日志 */
    private rootChildren(): DevkitNode[] {
        const children: DevkitNode[] = [];

        // 1. 服务器节点(始终显示)
        const config = getConfig();
        const address = config?.astrbotServer ?? this._serverAddress;
        children.push({ kind: 'server', state: this._connection, address });

        // 未配置时,给创建入口
        if (!config) {
            children.push({
                kind: 'placeholder',
                message: '尚未配置 AstrBot 服务器',
                command: 'astrbot-devkit.CreateConfig',
            });
            return children;
        }

        // 2. 插件工作区节点组(扁平展示每个 workspace)
        const workspaces = config.pluginWorkspaces ?? [];
        if (workspaces.length === 0) {
            children.push({
                kind: 'placeholder',
                message: '暂无插件工作区,点击添加或扫描',
                command: 'astrbot-devkit.ScanPlugins',
            });
        } else {
            for (const w of workspaces) {
                children.push({ kind: 'workspace', workspace: w, active: !!w.active });
            }
        }

        // 3. 当前插件配置(仅活跃插件存在时显示)
        const active = workspaces.find(w => w.active);
        if (active) {
            children.push({ kind: 'pluginConfig', workspace: active });
        }

        // 3.5. 自动连接开关
        children.push({ kind: 'autoConnectToggle', enabled: config.autoConnect ?? true });

        // 3.6. 调试结束后处理
        children.push({ kind: 'stopAction', action: config.debug.stopAction });

        // 4. 日志节点(始终显示,debug 时标记观察中)
        children.push({ kind: 'logs' });

        // 4.5. 接收服务器日志开关(实时控制是否接收/显示)
        children.push({ kind: 'logsToggle', enabled: config.debug.receiveLogs });

        return children;
    }
}

// ─── 取当前选中节点的辅助(extension 命令回调里用) ──────────

/** 获取侧边栏当前选中节点(配合 view/item/context 菜单使用,参数透传) */
export function nodeFromArgs(arg: unknown): DevkitNode | undefined {
    if (arg && typeof arg === 'object' && 'kind' in arg) {
        return arg as DevkitNode;
    }
    return undefined;
}

/** 检查是否打开了工作区(侧边栏依赖工作区) */
export function hasWorkspace(): boolean {
    return !!getWorkspaceRoot();
}
