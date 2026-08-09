// src/config/types.ts
// 配置层类型与默认值。

export interface DebugSettings {
    stopAction: 'ask' | 'disable' | 'keep';
    reloadAfterPush: 'ask' | 'always' | 'never';
    /** 是否接收并显示服务器日志(侧边栏「接收服务器日志」开关) */
    receiveLogs: boolean;
    reconnectLimit: number;
}

export interface PluginWorkspace {
    /** 插件根目录相对路径(直接含 main.py + metadata.yaml 的那一层) */
    dir: string;
    name: string;
    version: string;
    /** 至多一个 true,由扩展保证唯一 */
    active?: boolean;
}

export interface DevKitConfig {
    version: 2;
    /** 服务器地址,host:port 或完整 http(s):// */
    astrbotServer: string;
    /** OpenAPI API Key(abk_ 开头) */
    astrbotAPIkey: string;
    /** 启动时是否自动连接/拉取服务器(侧边栏可切换) */
    autoConnect?: boolean;
    debug: DebugSettings;
    pluginWorkspaces?: PluginWorkspace[];
}

/** metadata.yaml 解析出的插件候选(scanWorkspaceForPlugins 的产物) */
export interface PluginCandidate {
    /** 含 metadata.yaml 的目录(相对工作区根) */
    dir: string;
    name: string;
    version: string;
}

/** 默认 debug 设置 */
export const DEFAULT_DEBUG: DebugSettings = {
    stopAction: 'ask',
    reloadAfterPush: 'ask',
    receiveLogs: true,
    reconnectLimit: 5,
};
