// src/context.ts
// AppContext:扩展共享状态(tree/client/relay)与生命周期的显式容器。
// 由原 extension.ts 模块级单例收敛而来,行为不变。

import * as vscode from 'vscode';
import * as logger from './logger.js';
import {
    getConfig, getActiveWorkspace,
    type DevKitConfig,
} from './config/index.js';
import {
    createClient, type AstrBotClient,
} from './api/client.js';
import { listPlugins } from './api/plugins.js';
import { LogRelay } from './logs/relay.js';
import { DevkitTreeProvider } from './views/devkitTree.js';

/** 提示配置缺失,并提供「创建配置」引导按钮 */
export function promptCreateConfig(message: string, actionLabel: string): void {
    vscode.window.showErrorMessage(message, actionLabel)
        .then(p => { if (p === actionLabel) { vscode.commands.executeCommand('astrbot-devkit.CreateConfig'); } });
}

export class AppContext {
    readonly tree: DevkitTreeProvider;
    private _client: AstrBotClient | undefined;
    private _relay: LogRelay | undefined;
    /** 当前 client 对应的连接相关配置快照(server|key),用于判断是否需要重建 */
    private _clientConfigKey = '';

    constructor() {
        this.tree = new DevkitTreeProvider();
    }

    get client(): AstrBotClient | undefined { return this._client; }
    get relay(): LogRelay | undefined { return this._relay; }

    /** 供 launch.json 的 ${command:...} 动态取值:返回当前活跃插件名 */
    get activePluginName(): string {
        return getActiveWorkspace(getConfig())?.name ?? '';
    }

    /** 同步 astrbotDevkit.active / activePlugin 上下文 key */
    syncContext(): void {
        const config = getConfig();
        const active = getActiveWorkspace(config);
        vscode.commands.executeCommand('setContext', 'astrbotDevkit.active', !!active);
        vscode.commands.executeCommand('setContext', 'astrbotDevkit.activePlugin', active?.name ?? '');
        this.tree.refresh();
    }

    /** 重建 client(配置变化时调用) */
    rebuildClient(): void {
        const config = getConfig();
        this._relay?.dispose();
        this._relay = undefined;
        // 退役旧 client:其进行中的连接(如静默探活)结果不再更新 UI
        this._client?.retire();
        this._client = undefined;
        if (!config) {
            this._clientConfigKey = '';
            this.tree.setConnectionState('unconfigured', '');
            return;
        }
        this._client = createClient(config, state => {
            this.tree.setConnectionState(state, config.astrbotServer);
            // 连接成功 → 拉取服务器插件列表(用于侧边栏已推送/已启用状态)
            if (state === 'connected') {
                void this.refreshServerPlugins();
            }
        });
        this._clientConfigKey = configKey(config);
        this._relay = new LogRelay(this._client);
        // 初始状态:已配置但未连接
        this.tree.setConnectionState('unconfigured', config.astrbotServer);
    }

    /** 拉取服务器已安装插件列表 → 缓存到 tree(连接成功/刷新/操作后调用) */
    async refreshServerPlugins(): Promise<void> {
        const client = this._client;
        if (!client || client.state !== 'connected') {return;}
        try {
            const list = await listPlugins(client, { includeReserved: true });
            if (this._client === client) {
                this.tree.setServerPlugins(list);
            }
        } catch {
            // 静默失败:状态刷新是辅助,不报错打扰用户
        }
    }

    /** 当前 client 对应的连接相关配置快照(server|key) */
    get clientConfigKey(): string { return this._clientConfigKey; }

    /** watchConfig 回调:仅连接相关字段(server/key)变化时重建 client;
     * 只改 debug/pluginWorkspaces 则刷新 UI,避免切换活跃插件时断连 */
    handleConfigChanged(): void {
        const cur = getConfig();
        if (cur && configKey(cur) !== this._clientConfigKey) {
            this.rebuildClient();
        } else if (!cur) {
            this.rebuildClient();
        }
        this.syncContext();
    }

    /** 确保 client 就绪;未配置时引导创建 */
    ensureClient(): boolean {
        const config = getConfig();
        if (!config) {
            promptCreateConfig('尚未配置 AstrBot 服务器', '创建配置');
            return false;
        }
        if (!config.astrbotAPIkey) {
            promptCreateConfig('尚未配置 AstrBot API Key,请先配置服务器连接', '去配置');
            return false;
        }
        if (this._client) {return true;}
        this.rebuildClient();
        return !!this._client;
    }

    dispose(): void {
        this._client?.retire();
        this._relay?.dispose();
    }
}

/** 当前 client 对应的连接相关配置快照(server|key),用于判断是否需要重建 */
function configKey(c: DevKitConfig): string {
    return `${c.astrbotServer}|${c.astrbotAPIkey}`;
}
