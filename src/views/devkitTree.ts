// src/views/devkitTree.ts
// 侧边栏 TreeDataProvider(两层):服务器 + 插件(可展开为操作面板)+ 设置组 + 日志。
// 状态来源:pluginWorkspaces → getConfig();连接/服务器插件状态 → setConnectionState/setServerPlugins。
// 见 design.md §7 / implementation.md §6。

import * as vscode from 'vscode';
import type { ConnectionState } from '../api/client.js';
import type { PluginInfo } from '../api/plugins.js';
import type { PluginWorkspace } from '../config/index.js';
import { getConfig, isWorkspaceEmpty } from '../config/index.js';

// ─── 节点类型 ────────────────────────────────────────────

/** 插件在服务器端的状态(pushed=已安装;enabled=启用) */
export interface ServerPluginState {
    pushed: boolean;
    enabled: boolean;
    pluginId?: string;
}

export type DevkitNode =
    | { kind: 'server'; state: ConnectionState; address: string }
    | { kind: 'workspace'; workspace: PluginWorkspace; active: boolean; serverState: ServerPluginState | undefined }
    | { kind: 'workspaceAction'; workspace: PluginWorkspace; action: 'config' | 'debug' | 'reload' }
    | { kind: 'workspaceEnabled'; workspace: PluginWorkspace; enabled: boolean }
    | { kind: 'settingsGroup' }
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
 * 侧边栏数据源(两层):
 *  - 根:服务器 + 插件工作区(可折叠)+ 设置组 + 日志
 *  - 插件节点展开:配置 / 调试 / 重载(仅已推送)/ 已启用开关(仅已推送)
 *  - 设置组展开:自动连接 / 调试结束后 / 接收日志
 */
export class DevkitTreeProvider implements vscode.TreeDataProvider<DevkitNode> {
    private _connection: ConnectionState = 'unconfigured';
    private _serverAddress = '';
    private _debugging = false;
    private _serverPlugins: PluginInfo[] = [];
    private readonly _emitter = new vscode.EventEmitter<DevkitNode | undefined>();
    readonly onDidChangeTreeData = this._emitter.event;

    /** 由 extension 设置连接状态(连接成功/失败/探活后) */
    setConnectionState(state: ConnectionState, address?: string): void {
        this._connection = state;
        if (address !== undefined) {this._serverAddress = address;}
        this.refresh();
    }

    /** 由 extension 设置服务器端插件列表(连接成功/刷新/操作后) */
    setServerPlugins(list: PluginInfo[]): void {
        this._serverPlugins = list;
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
        return this.toTreeItem(element);
    }

    getChildren(element?: DevkitNode): DevkitNode[] {
        if (!element) {return this.rootChildren();}
        if (element.kind === 'workspace') {return this.workspaceChildren(element);}
        if (element.kind === 'settingsGroup') {return this.settingsChildren();}
        return [];
    }

    // ─── 子项构造 ────────────────────────────────────────

    /** 根 → 服务器 + 插件 + 设置组 + 日志 */
    private rootChildren(): DevkitNode[] {
        const children: DevkitNode[] = [];

        // 0. 工作区严格为空 → 顶部常驻「初始化插件环境」入口(与激活弹窗互补,弹窗可被忽略/关闭)
        if (isWorkspaceEmpty()) {
            children.push({
                kind: 'placeholder',
                message: '初始化插件环境',
                command: 'astrbot-devkit-in-vscode.InitEnv',
            });
        }

        // 1. 服务器节点(始终显示)
        const config = getConfig();
        const address = config?.astrbotServer ?? this._serverAddress;
        children.push({ kind: 'server', state: this._connection, address });

        // 未配置时,给创建入口
        if (!config) {
            children.push({
                kind: 'placeholder',
                message: '配置服务器',
                command: 'astrbot-devkit.CreateConfig',
            });
            return children;
        }

        // 2. 插件工作区节点(可折叠,展开后是操作面板)
        const workspaces = config.pluginWorkspaces ?? [];
        if (workspaces.length === 0) {
            children.push({
                kind: 'placeholder',
                message: '暂无插件工作区,点击添加或扫描',
                command: 'astrbot-devkit.ScanPlugins',
            });
        } else {
            for (const w of workspaces) {
                children.push({
                    kind: 'workspace',
                    workspace: w,
                    active: !!w.active,
                    serverState: this.serverStateFor(w.name),
                });
            }
        }

        // 3. 设置分组(可折叠,默认折叠)
        children.push({ kind: 'settingsGroup' });

        // 4. 日志节点(始终显示)
        children.push({ kind: 'logs' });

        return children;
    }

    /** 插件 → 操作面板:配置 / 调试 / 重载(仅已推送)/ 已启用开关(仅已推送) */
    private workspaceChildren(node: { workspace: PluginWorkspace; serverState: ServerPluginState | undefined }): DevkitNode[] {
        const ws = node.workspace;
        const pushed = !!node.serverState?.pushed;
        const children: DevkitNode[] = [
            { kind: 'workspaceAction', workspace: ws, action: 'config' },
            { kind: 'workspaceAction', workspace: ws, action: 'debug' },
        ];
        if (pushed) {
            children.push({ kind: 'workspaceAction', workspace: ws, action: 'reload' });
            children.push({
                kind: 'workspaceEnabled',
                workspace: ws,
                enabled: node.serverState?.enabled ?? true,
            });
        }
        return children;
    }

    /** 设置组 → 自动连接 / 调试结束后 / 接收日志 */
    private settingsChildren(): DevkitNode[] {
        const config = getConfig();
        if (!config) {return [];}
        return [
            { kind: 'autoConnectToggle', enabled: config.autoConnect ?? true },
            { kind: 'stopAction', action: config.debug.stopAction },
            { kind: 'logsToggle', enabled: config.debug.receiveLogs },
        ];
    }

    /** 按 name 在缓存的服务器插件列表里找状态 */
    private serverStateFor(name: string): ServerPluginState | undefined {
        const p = this._serverPlugins.find(x => x.name === name || x.id === name);
        if (!p) {return { pushed: false, enabled: false };}
        return { pushed: true, enabled: p.enabled !== false, pluginId: p.id ?? p.name };
    }

    // ─── 渲染 ────────────────────────────────────────────

    /** 把节点数据转成 TreeItem(带 contextValue / icon / command) */
    private toTreeItem(node: DevkitNode): DevkitItem {
        switch (node.kind) {
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
                // description:活跃优先;否则按服务器状态显示
                const parts: string[] = [];
                if (node.active) {parts.push('活跃');}
                if (node.serverState) {
                    if (!node.serverState.pushed) {parts.push('未推送');}
                    else if (!node.serverState.enabled) {parts.push('已禁用');}
                }
                if (parts.length === 0) {parts.push(node.workspace.dir);}
                item.description = parts.join(' · ');
                item.iconPath = new vscode.ThemeIcon(
                    node.active ? 'circle-large-filled' : 'circle-large-outline',
                );
                item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                item.tooltip = `插件:${node.workspace.name}\n版本:${node.workspace.version}\n目录:${node.workspace.dir}${node.active ? '\n(当前 Debug 目标)' : ''}`;
                // 点击只设为活跃,不再直接 Debug(避免误触;Debug 走展开后的子项)
                item.command = {
                    command: 'astrbot-devkit.SetActivePlugin',
                    title: 'Set Active',
                    arguments: [node.workspace],
                };
                return item;
            }
            case 'workspaceAction': {
                const map: Record<string, { label: string; icon: string; cmd: string; ctx: string }> = {
                    config: { label: '配置', icon: 'settings-gear', cmd: 'astrbot-devkit.OpenPluginConfig', ctx: 'devkitWorkspaceActionConfig' },
                    debug: { label: '调试', icon: 'debug-start', cmd: 'astrbot-devkit.Debug', ctx: 'devkitWorkspaceActionDebug' },
                    reload: { label: '重载', icon: 'debug-restart', cmd: 'astrbot-devkit.ReloadPlugin', ctx: 'devkitWorkspaceActionReload' },
                };
                const m = map[node.action];
                const item = this.base(m.label, m.ctx, node);
                item.iconPath = new vscode.ThemeIcon(m.icon);
                item.tooltip = node.action === 'config'
                    ? `打开 ${node.workspace.name} 的配置(支持本地 schema)`
                    : node.action === 'debug'
                        ? `推送 ${node.workspace.name} 到服务器并观察日志`
                        : `重载 ${node.workspace.name}`;
                item.command = { command: m.cmd, title: m.label, arguments: [node.workspace] };
                return item;
            }
            case 'workspaceEnabled': {
                const item = this.base(
                    node.enabled ? '已启用' : '已禁用',
                    'devkitWorkspaceEnabled',
                    node,
                );
                item.iconPath = new vscode.ThemeIcon(node.enabled ? 'check' : 'circle-outline');
                item.tooltip = `点击${node.enabled ? '禁用' : '启用'} ${node.workspace.name}(服务器端)`;
                item.command = {
                    command: 'astrbot-devkit.TogglePluginEnabled',
                    title: 'Toggle enabled',
                    arguments: [node.workspace],
                };
                return item;
            }
            case 'settingsGroup': {
                const item = this.base('设置', 'devkitSettingsGroup', node);
                item.iconPath = new vscode.ThemeIcon('gear');
                item.description = '自动连接 / 调试结束后 / 接收日志';
                item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                return item;
            }
            case 'autoConnectToggle': {
                const item = this.base(
                    `自动连接服务器:${node.enabled ? '开' : '关'}`,
                    'devkitAutoConnectToggle',
                    node,
                );
                item.description = node.enabled ? '启动时自动拉取' : '需手动连接';
                item.iconPath = new vscode.ThemeIcon(node.enabled ? 'check' : 'circle-outline');
                item.tooltip = '启动时是否自动连接/拉取 AstrBot 服务器信息,点击切换';
                item.command = { command: 'astrbot-devkit.ToggleAutoConnect', title: 'Toggle auto connect' };
                return item;
            }
            case 'stopAction': {
                const label: Record<string, string> = {
                    ask: '每次询问', disable: '直接禁用', keep: '保留运行',
                };
                const item = this.base(`调试结束后:${label[node.action]}`, 'devkitStopAction', node);
                item.description = '点击修改';
                item.iconPath = new vscode.ThemeIcon('debug-stop');
                item.tooltip = '停止 debug 后对插件的处理:每次询问 / 直接禁用 / 保留运行';
                item.command = { command: 'astrbot-devkit.EditStopAction', title: 'Edit stop action' };
                return item;
            }
            case 'logs': {
                const item = this.base('日志', 'devkitLogs', node);
                item.description = this._debugging ? '观察中' : 'AstrBot Server';
                item.iconPath = new vscode.ThemeIcon('output');
                item.command = { command: 'astrbot-devkit.OpenServerLogs', title: 'Open Server Logs' };
                return item;
            }
            case 'logsToggle': {
                const item = this.base(
                    `接收服务器日志:${node.enabled ? '开' : '关'}`,
                    'devkitLogsToggle',
                    node,
                );
                item.description = node.enabled ? '点击关闭' : '点击开启';
                item.iconPath = new vscode.ThemeIcon(node.enabled ? 'check' : 'circle-outline');
                item.tooltip = '控制是否接收并显示服务器日志(调试时实时生效),点击切换';
                item.command = { command: 'astrbot-devkit.ToggleLogs', title: 'Toggle server logs' };
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
            default:
                // 'unconfigured' 同时表示「无配置」与「已配置但未连接」,按配置是否存在区分
                return getConfig() ? '未连接' : '配置缺失';
        }
    }
}
