# AstrBot DevKit In VSCode — 实现文档

> 面向 AI/开发者的实现清单,精确到文件与关键函数。设计依据见 [design.md](./design.md)(v5)。本文件是权威实现说明,冲突时以本文件为准。
> 范围:阶段 1–5 的 VS Code 扩展侧。**logleak 服务端插件不在本文件范围**,只预留 API 对接(§14)。

## 0. 总体约定

### 0.1 现有文件(主体不动)

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/main.ts` | 不动 | `InitEnv` 已重构完成 |
| `src/tool.ts` | 不动 | 通用工具(run/runStreaming/downloadFile/extractZip/...),可直接复用 |
| `src/logger.ts` | 不动 | 扩展自身日志,通道 `AstrBot DevKit` |
| `src/extension.ts` | 重写 | 激活逻辑与命令注册(§11) |

### 0.2 新增依赖

```bash
npm install yaml
```

### 0.3 命名约定

- 新命令前缀:`astrbot-devkit.`(与 design.md 一致);现有 `astrbot-devkit-in-vscode.InitEnv/WorkspaceCheck` 保持不动
- 输出通道:`AstrBot DevKit`(现有 logger.ts)、`AstrBot Server`(新增,logs/relay.ts)
- 配置文件:`.vscode/astrbot-devkit-config.json`
- 上下文 key:`astrbotDevkit.active` / `astrbotDevkit.debugging` / `astrbotDevkit.activePlugin`
- **活跃插件节点不使用 when 动态值比较**,用专属 `contextValue: 'devkitWorkspaceActive'`

### 0.4 关键常量(`src/constants.ts`,新增)

```ts
/** 日志投射插件 ID(服务端插件名,已定,勿改) */
export const LOGLEAK_PLUGIN_ID = 'astrbot_plugin_devkit_for_vscode_logleak';
/** 日志流 SSE 端点(插件自定义路由挂载路径) */
export const LOGLEAK_SSE_ROUTE =
    `/api/v1/plugins/extensions/${LOGLEAK_PLUGIN_ID}/logs/stream`;
/** logleak 插件 GitHub 仓库(未安装时一键安装用) */
export const LOGLEAK_PLUGIN_REPO = '17-qxm/astrbot_plugin_devkit_for_vscode_logleak';

export const OUTPUT_CHANNEL_DEVKIT = 'AstrBot DevKit';
export const OUTPUT_CHANNEL_SERVER = 'AstrBot Server';

export const CONFIG_REL_PATH = '.vscode/astrbot-devkit-config.json';
export const CONFIG_VERSION = 2;

/** 新命令前缀 */
export const CMD_PREFIX = 'astrbot-devkit.';

/** 打包排除规则(目录或通配) */
export const ZIP_EXCLUDE = ['.git', '__pycache__', '.venv', 'dist', '.tmp', '*.pyc'];

/** SSE 心跳超时(ms)与重连退避(ms) */
export const SSE_IDLE_TIMEOUT_MS = 60_000;
export const SSE_RECONNECT_BACKOFF_MS = [3_000, 10_000, 30_000];
```

## 1. 文件清单与依赖图

```
src/
├── extension.ts         入口:激活、注册命令/视图、启动逻辑(重写)
├── constants.ts         常量(新增)
├── config.ts            配置层(新增)
├── api/
│   ├── client.ts        OpenAPI 客户端基座(新增)
│   ├── plugins.ts       插件 API(新增)
│   └── im.ts            消息推送 API(新增)
├── debug/
│   └── debugAdapter.ts  原生调试适配器,type: astrbot(新增)
├── views/
│   ├── devkitTree.ts    侧边栏主视图 TreeDataProvider(新增)
│   ├── localTree.ts     侧边栏「本地插件」单选列表(新增)
│   └── configEditor.ts  插件配置编辑(新增)
└── logs/
    └── relay.ts         SSE 日志客户端(新增)
```

依赖关系:

```
extension.ts → config.ts → constants.ts
            → api/client.ts → constants.ts
            → api/plugins.ts → api/client.ts
            → api/im.ts → api/client.ts
            → views/devkitTree.ts → api/plugins.ts, config.ts
            → views/configEditor.ts → api/plugins.ts, config.ts
            → views/localTree.ts → config.ts
            → debug/debugAdapter.ts → api/plugins.ts, logs/relay.ts, tool.ts
            → logs/relay.ts → api/client.ts, constants.ts
```

## 2. `src/config.ts` — 配置层

### 2.1 类型

```ts
import type * as vscode from 'vscode';

export interface DebugSettings {
    stopAction: 'ask' | 'disable' | 'keep';
    reloadAfterPush: 'ask' | 'always' | 'never';
    reconnectLimit: number;
}

export interface PluginWorkspace {
    dir: string;        // 相对工作区根,必须是插件根(含 main.py + metadata.yaml)
    name: string;
    version: string;
    active?: boolean;   // 最多一个 true,由扩展保证
}

export interface DevKitConfig {
    version: 2;
    astrbotServer: string;
    astrbotAPIkey: string;
    debug: DebugSettings;
    pluginWorkspaces?: PluginWorkspace[];
}

/** 扫描结果:metadata.yaml 解析出的插件候选 */
export interface PluginCandidate {
    dir: string;        // 相对工作区根,含 metadata.yaml 的目录
    name: string;
    version: string;
}

export const DEFAULT_DEBUG: DebugSettings = {
    stopAction: 'ask',
    reloadAfterPush: 'ask',
    reconnectLimit: 5,
};
```

### 2.2 函数

```ts
/** 返回工作区配置;未打开工作区或解析失败返回 undefined */
export function getConfig(): DevKitConfig | undefined;

/** v1→v2 迁移:缺省字段填默认值,写入并升级版本号 */
export function normalizeConfig(raw: unknown): DevKitConfig;

/** 配置文件绝对路径;未打开工作区返回 undefined */
export function getConfigFilePath(): string | undefined;

/** 监听配置文件变化(fs.watch 防抖 300ms),变更时回调 */
export function watchConfig(cb: () => void): vscode.Disposable;

/** 配置缺失时写入模板文件(v2:debug 默认值、pluginWorkspaces 空) */
export function ensureConfigFile(): Promise<boolean>;

/** 校验配置,返回错误列表(空 = 合法) */
export function validateConfig(): string[];

/** 写回配置(JSON 序列化,4 空格缩进) */
export function saveConfig(config: DevKitConfig): Promise<void>;

/** 活跃插件;无则返回 undefined */
export function getActiveWorkspace(config: DevKitConfig): PluginWorkspace | undefined;

/** 设置唯一 active 条目并写回 */
export function setActiveWorkspace(name: string): Promise<void>;

/**
 * 扫描工作区找插件:工作区根 + 子目录,深度 ≤4 层。
 * 排除: .git/ node_modules/ .vscode/ .venv/ dist/ .tmp/ .claude/ .codex/
 * 判定: 目录含 metadata.yaml 且解析出合法 name + version
 */
export function scanWorkspaceForPlugins(): PluginCandidate[];

/** 解析 metadata.yaml(供 scanWorkspaceForPlugins 与 AddWorkspace 使用) */
export function parseMetadata(yamlText: string): { name?: string; version?: string; desc?: string } | undefined;
```

### 2.3 实现要点

- 用 `yaml` 包解析 metadata.yaml;解析失败一律返回 undefined,不抛错
- `normalizeConfig` 对 `version: 1` 补齐 `debug` 块与 `active: false`;对未知版本按 v2 处理
- `validateConfig` 检查:`astrbotServer` 格式(同 schema pattern)、`astrbotAPIkey` 以 `abk_` 开头、`pluginWorkspaces` 中 `active: true` 至多一个
- `scanWorkspaceForPlugins` 用递归函数,传入当前深度,>4 层剪枝;目录扫描用 `fs.readdirSync(withFileTypes)`
- 模板文件内容:

```json
{
  "version": 2,
  "astrbotServer": "127.0.0.1:6185",
  "astrbotAPIkey": "",
  "debug": {
    "stopAction": "ask",
    "reloadAfterPush": "ask",
    "reconnectLimit": 5
  },
  "pluginWorkspaces": []
}
```

## 3. `src/api/client.ts` — OpenAPI 客户端基座

### 3.1 类型

```ts
export type ConnectionState = 'unconfigured' | 'checking' | 'connected' | 'error';

export type ApiErrorKind =
    | 'UNAUTHORIZED'        // 401
    | 'FORBIDDEN'           // 403(scope 不足)
    | 'NOT_FOUND'           // 404
    | 'SERVER_ERROR'        // 5xx / 网络异常
    | 'INVALID_RESPONSE';   // SuccessEnvelope 解包失败

export class ApiError extends Error {
    kind: ApiErrorKind;
    status?: number;        // HTTP 状态码,网络错误为 undefined
}

export interface AstrBotClient {
    readonly state: ConnectionState;
    readonly baseUrl: string;             // 规范化后,如 http://127.0.0.1:6185
    readonly config: DevKitConfig;        // 供 logs/relay 等复用 baseUrl/key

    /** 探活:GET /api/v1/plugins,成功置 connected;失败置 error 并抛 ApiError */
    connect(): Promise<void>;
    /** 本地置 unconfigured/error,不发请求 */
    disconnect(): void;

    /** 统一请求:拼 baseUrl + path,带 Bearer,解包 SuccessEnvelope */
    request<T>(path: string, init?: RequestInit): Promise<T>;

    /** multipart 上传 zip:POST /api/v1/plugins/install/upload,字段名 file */
    uploadZip(zipBuffer: Buffer, filename: string): Promise<Record<string, unknown>>;
}

export function createClient(
    config: DevKitConfig,
    onStateChange?: (s: ConnectionState) => void,
): AstrBotClient;
```

### 3.2 实现要点

- base URL 规范化:`host:port` → `http://host:port`;已是 `http(s)://` 原样;去掉末尾 `/`
- 所有请求 `Authorization: Bearer ${config.astrbotAPIkey}`,超时 15s(`AbortController`)
- 解包:`{ status, message, data }`;`status === 'ok'` 返回 `data`;否则抛 `ApiError('SERVER_ERROR'|'INVALID_RESPONSE')`
- 错误映射:

| 条件 | kind |
|---|---|
| HTTP 401 | `UNAUTHORIZED` |
| HTTP 403 | `FORBIDDEN` |
| HTTP 404 | `NOT_FOUND` |
| HTTP 5xx / 网络异常(ECONNREFUSED 等) | `SERVER_ERROR` |
| 解包失败 | `INVALID_RESPONSE` |

- `uploadZip`:用全局 `FormData` + `Blob`(Node 18+):

```ts
const fd = new FormData();
fd.append('file', new Blob([zipBuffer]), filename);
```

## 4. `src/api/plugins.ts` — 插件 API

### 4.1 类型

```ts
import type { AstrBotClient } from './client.js';

/** GET /plugins 返回项;字段以实际响应为准,至少映射 id/name/enabled */
export interface PluginInfo {
    id: string;
    name: string;
    enabled: boolean;
    version?: string;
    [k: string]: unknown;
}

/** _conf_schema.json 字段定义(AstrBot 自定义格式,非标准 JSON Schema) */
export interface SchemaField {
    type?: string;
    description?: string;
    default?: unknown;
    options?: unknown[];
    items?: Record<string, SchemaField>;
    [k: string]: unknown;
}
export type ConfigSchema = Record<string, SchemaField>;
```

### 4.2 函数

```ts
export async function listPlugins(client: AstrBotClient): Promise<PluginInfo[]>;
export async function getPluginConfig(
    client: AstrBotClient, pluginId: string,
): Promise<Record<string, unknown>>;
export async function savePluginConfig(
    client: AstrBotClient, pluginId: string, config: object,
): Promise<void>;
export async function getPluginConfigSchema(
    client: AstrBotClient, pluginId: string,
): Promise<ConfigSchema>;
export async function setPluginEnabled(
    client: AstrBotClient, pluginId: string, enabled: boolean,
): Promise<void>;                                    // PATCH enabled {"enabled": bool}
export async function reloadPlugin(
    client: AstrBotClient, pluginId: string,
): Promise<void>;                                    // POST reload
export async function installPluginFromGithub(
    client: AstrBotClient, repository: string,
): Promise<void>;                                    // POST install/github {"repository": ...}
export async function uploadPluginZip(
    client: AstrBotClient, zipBuffer: Buffer, filename: string,
): Promise<{ plugin_id?: string }>;                  // 返回 upload 响应,从中取 plugin_id
```

### 4.3 端点映射

| 函数 | 端点 |
|---|---|
| `listPlugins` | `GET /api/v1/plugins` |
| `getPluginConfig` | `GET /api/v1/plugins/{plugin_id}/config` |
| `savePluginConfig` | `PUT /api/v1/plugins/{plugin_id}/config` |
| `getPluginConfigSchema` | `GET /api/v1/plugins/{plugin_id}/config/schema` |
| `setPluginEnabled` | `PATCH /api/v1/plugins/{plugin_id}/enabled` |
| `reloadPlugin` | `POST /api/v1/plugins/{plugin_id}/reload` |
| `installPluginFromGithub` | `POST /api/v1/plugins/install/github` |
| `uploadPluginZip` | `POST /api/v1/plugins/install/upload`(multipart) |

## 5. `src/api/im.ts` — 消息推送

```ts
import type { AstrBotClient } from './client.js';

export interface MessageSegment {
    type: 'plain' | 'reply' | 'image' | 'record' | 'file' | 'video';
    text?: string;
    attachment_id?: string;
    message_id?: string;      // reply 用
    selected_text?: string;   // reply 用
}

export interface UmoInfo {
    id: string;
    [k: string]: unknown;
}

/** POST /api/v1/im/messages,message 支持纯文本或段数组 */
export async function sendMessage(
    client: AstrBotClient,
    umo: string,
    message: string | MessageSegment[],
): Promise<void>;

/** GET /api/v1/im/bots,供命令中提供 UMO 选择 */
export async function listBots(client: AstrBotClient): Promise<UmoInfo[]>;
```

## 6. `src/views/devkitTree.ts` — 侧边栏

### 6.1 节点

```ts
export type DevkitNode =
    | { kind: 'root' }
    | { kind: 'server'; state: ConnectionState; address: string }
    | { kind: 'workspace'; workspace: PluginWorkspace; active: boolean }
    | { kind: 'pluginConfig'; workspace: PluginWorkspace }
    | { kind: 'logs' };

export class DevkitTreeProvider implements vscode.TreeDataProvider<DevkitNode> {
    readonly onDidChangeTreeData: vscode.Event<void>;
    refresh(): void;
    getTreeItem(element: DevkitNode): vscode.TreeItem;
    getChildren(element?: DevkitNode): DevkitNode[];
}
```

### 6.2 TreeItem 映射

| 节点 | label | contextValue | 说明 |
|---|---|---|---|
| root | `AstrBot DevKit` | `devkitRoot` | 顶层 |
| server | `服务器 <address>` | `devkitServer` | description 显示状态 |
| workspace(非活跃) | 插件名 | `devkitWorkspace` | command: SetActivePlugin |
| workspace(活跃) | 插件名 | `devkitWorkspaceActive` | 高亮,command: Debug |
| pluginConfig | `当前插件配置` | `devkitPluginConfig` | 仅活跃插件存在时显示 |
| logs | `日志` | `devkitLogs` | command: OpenServerLogs |

### 6.3 实现要点

- 层级:root → [server, "插件工作区"(workspace 节点组), pluginConfig, logs]
- `getChildren(root)` 从 `getConfig()` 读取 `pluginWorkspaces` 与连接状态
- `refresh()` 在以下时机被调用:配置 watch 回调、连接状态变化、插件列表变化、debug 状态变化
- server 节点子项:空(状态靠 description 显示);`connected` 时 description `已连接`,否则 `未连接/配置缺失`

## 7. `src/views/configEditor.ts` — 插件配置编辑

### 7.1 状态

```ts
interface ConfigEditSession {
    workspace: PluginWorkspace;
    pluginId: string;
    schema: ConfigSchema;
    document: vscode.TextDocument;
}

/** 维护当前打开的配置编辑会话(按文档 URI) */
const activeSessions = new Map<string, ConfigEditSession>();
```

### 7.2 函数

```ts
/** 打开 untitled 文档,内容为服务器端当前配置 */
export async function openPluginConfig(workspace: PluginWorkspace): Promise<void>;

/** 从活动编辑器推送到服务器:校验 → PUT → 按 reloadAfterPush 处理 */
export async function pushPluginConfig(editor: vscode.TextEditor): Promise<void>;

/** 轻量校验:按 SchemaField 检查类型/options/default(见 design.md §4.3) */
export function validateConfigValue(
    schema: ConfigSchema,
    value: unknown,
): { path: string; message: string }[];
```

### 7.3 实现要点

- `openPluginConfig`:
  1. `listPlugins` 按 `name` 匹配 `pluginId`(匹配不到则报错并中止)
  2. 并行 `getPluginConfig` + `getPluginConfigSchema`
  3. `vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(cfg, null, 4) })`,标题 `{name} 配置(服务器)`
  4. 记录 `activeSessions`
- `pushPluginConfig`:
  1. 从 `activeSessions` 找当前文档的会话;找不到则提示"请通过侧边栏打开插件配置"
  2. `JSON.parse` 文档内容 → `validateConfigValue`;有错误则定位到行号(逐字符定位)并 `showErrorMessage`,中止
  3. `savePluginConfig(client, pluginId, value)`
  4. 按 `debug.reloadAfterPush`:`ask` → `showInformationMessage('配置已推送,是否重载插件?', '重载', '不重载')`;`always` → `reloadPlugin`;`never` → 跳过
- `validateConfigValue` 规则:type 匹配 JS 类型(string/int→number 且整数/float→number/bool→boolean/object/list→array/dict→object)、`options` 枚举包含、嵌套 `items` 递归

## 8. `src/debug/debugAdapter.ts` — 原生调试适配器(type: astrbot)

> 取代旧的 `debugSession.ts`(已删除)。两个入口共用同一适配器:
> **F5/launch.json**(原生调试)与**侧边栏插件节点点击**(`startDebugging` 动态配置)。
> 插件运行在服务器进程,**不提供断点**;会话语义 = 推送 + 日志观察,直到用户停止。

### 8.1 类型与依赖

```ts
/** launch.json 的 launch 参数 */
export interface AstrBotLaunchArgs {
    pluginName?: string;   // pluginWorkspaces 中的 name;缺省用活跃插件
}

/** 由 extension 注入共享 client/relay(与侧边栏/配置共用一份) */
export interface AdapterDeps {
    getClient: () => AstrBotClient | undefined;
    getRelay: () => LogRelay | undefined;
}

export class AstrBotDebugAdapter implements vscode.DebugAdapter {
    readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;
    handleMessage(message: vscode.DebugProtocolMessage): void;
    dispose(): void;
}
```

### 8.2 DAP 处理(handleMessage 分派)

| 命令 | 行为 |
|---|---|
| `initialize` | 响应 capabilities:`supportsConfigurationDoneRequest` / `supportsTerminateRequest`(true) |
| `launch` | 先响应,再异步执行主流程(§8.3);出错发 `output`(stderr)+ `terminated` 事件 |
| `configurationDone` | 空响应 |
| `terminate` / `disconnect` | 停止逻辑(§8.4),发 `terminated` |
| 其他 | 响应 unsupported |

DAP 消息类型(`DebugProtocolRequest/Response/Event`)vscode 命名空间未导出,本地定义 `DapRequest/DapResponse/DapEvent` 接口。

### 8.3 主流程(runDebug)

```ts
1. 找插件:launch args.pluginName 匹配 pluginWorkspaces,缺省用活跃插件;找不到报错
2. 连接:client.state !== 'connected' → connect()
3. ensureLogleakPlugin:检测 logleak 插件,缺失提示但继续
4. packagePlugin → `uploadWithRetry`(上传失败时检测同名插件,有则 DELETE 后重装)→ 记录 pushedPluginId(resp.plugin_id ?? name)
5. relay.start()(服务器日志 → AstrBot Server 通道)
6. 输出「调试中…」,会话保持运行直到用户停止
```

进度与结果通过 DAP `output` 事件写进 **Debug Console**(category: stdout/stderr/console)。

### 8.4 停止逻辑(与旧 DebugSession 保持一致)

`terminate`/`disconnect` → 停止逻辑同步一份:

```ts
relay.stop();                            // 断 SSE、停重连,通道内容保留
if (lastWorkspace) await applyStopAction(lastWorkspace);
```

`applyStopAction` 按 `debug.stopAction`:

- `ask` → `showInformationMessage('是否禁用插件 xxx?', '禁用', '保留')` → 「禁用」→ `setPluginEnabled(client, pushedPluginId ?? name, false)`
- `disable` → 直接禁用
- `keep` → 不动

### 8.5 步骤实现(packagePlugin / addDirToZip / isExcluded)

- `packagePlugin`:校验 `dir` 含 `metadata.yaml`;adm-zip 遍历排除 `ZIP_EXCLUDE`;zip 根即插件根内容;输出到 `.tmp/<name>.zip`
- `isExcluded`:目录名精确匹配 / `*.pyc` 后缀 / `*` 通配转正则

### 8.7 同名插件冲突兜底(uploadWithRetry)

`POST /plugins/install/upload` 对已存在插件的覆盖行为因 AstrBot 版本而异;为稳妥,上传失败时:

1. `resolvePluginId` 按 name 在 `GET /plugins` 中查找同名插件
2. 找到 → `DELETE /api/v1/plugins/{plugin_id}` → 重新 upload
3. 未找到 → 原错误保留抛出

`api/plugins.ts` 需提供 `deletePlugin(client, pluginId)`(`DELETE /api/v1/plugins/{id}`)。

### 8.6 注册(extension.ts)

```ts
vscode.debug.registerDebugAdapterDescriptorFactory('astrbot', {
    createDebugAdapterDescriptor() {
        return new vscode.DebugAdapterInlineImplementation(
            new AstrBotDebugAdapter({ getClient: () => client, getRelay: () => relay }),
        );
    },
});
```

状态同步由 `vscode.debug.onDidStartDebugSession` / `onDidTerminateDebugSession` 驱动:
`setContext('astrbotDevkit.debugging')` + `tree.setDebugging()`。

## 9. `src/logs/relay.ts` — SSE 日志客户端

### 9.1 类型

```ts
export class LogRelay {
    constructor(client: AstrBotClient, channel: vscode.OutputChannel);
    get running(): boolean;

    /** 启动 SSE;clearFirst=true 清空通道(默认),false 保留历史(侧边栏开关开启时用) */
    start(clearFirst?: boolean): Promise<boolean>;

    /** 断开 SSE,停止重连 */
    stop(): void;
}
```

### 9.2 实现要点

- SSE URL:`client.baseUrl + LOGLEAK_SSE_ROUTE`;请求头 `Authorization: Bearer ${client.config.astrbotAPIkey}`(v0.2.0 起全局鉴权接管,无 X-Logleak-Key)
- `fetch` 流式读取:`response.body.getReader()` 按 `\n` 切行,只处理 `data: ` 前缀;SSE 事件 JSON:`{ ts, level, logger, message }`
- 写出行格式:`[HH:MM:SS] [LEVEL] logger message`(ts 取本地时间)
- `message` 可能含多行:按 `\n` 拆成多行 `appendLine`,保持顺序
- 重连:失败/断开后按 `SSE_RECONNECT_BACKOFF_MS` 退避;**`reconnectLimit` 语义 = 连续建连失败次数上限**(成功收到过数据后清零);超过后 `appendLine('⚠️ 日志连接已断开,请重新 Debug')` 并停止
- 心跳:服务端 30s 发一次 ping;客户端 60s 无数据(含 ping)视为断线,走重连逻辑
- 401 → 提示「AstrBot API Key(astrbotAPIkey)不匹配或缺失」;404 → 提示「日志投射插件未安装或 AstrBot 版本过低(需 v4.24+)」
- `stop()` 用 `AbortController` 终止 fetch;`dispose` 时 `channel.dispose()`

## 10. `src/extension.ts` — 激活与命令注册

### 10.1 激活流程(`activate`)

```ts
export function activate(context: vscode.ExtensionContext) {
    initLogger(context);

    // 1. 状态容器(单例,模块级)
    let config = getConfig();
    let client: AstrBotClient | undefined;
    const relay = new LogRelay(...);           // 延迟到有 config 时创建
    const tree = new DevkitTreeProvider();

    // 2. setContext 初始化
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.active', !!getActiveWorkspace(config));
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);

    // 3. 注册视图
    vscode.window.registerTreeDataProvider('astrbot-devkit.main', tree);

    // 4. 注册全部命令(§10.2)
    registerCommands(context);

    // 5. 配置 watch:变更后刷新 tree 与上下文
    context.subscriptions.push(watchConfig(() => { tree.refresh(); syncContext(); }));

    // 6. 配置缺失 → 插件检索(§design 3.2)
    if (!config) { maybeCreateFromScan(); }

    // 7. 静默探活(§design 3.3):不 await、失败静默
    if (config) { createClient(config).connect().catch(() => {}); }

    // 8. WorkspaceCheck 保持注册(空实现,不调用)
}
```

### 10.2 命令注册表

| 命令 id | 处理函数 | 说明 |
|---|---|---|
| `astrbot-devkit.Refresh` | 刷新 tree + 重连状态 | view/title 按钮 |
| `astrbot-devkit.CreateConfig` | 创建向导(§config 输入矩阵) | InputBox server → API key(立即验证)→ 检索填充 → 写文件 |
| `astrbot-devkit.OpenConfig` | `vscode.window.showTextDocument` 打开配置文件 | 编辑 JSON |
| `astrbot-devkit.EditServerAddress` | InputBox 修改 `astrbotServer` 并保存 | 校验格式 |
| `astrbot-devkit.Connect` | `client.connect()` | 失败弹错误分类 |
| `astrbot-devkit.AddWorkspace` | `showOpenDialog` 选文件夹 → 校验 metadata.yaml → 追加 | 文件夹必须是插件根 |
| `astrbot-devkit.ScanPlugins` | 扫描 → `showQuickPick` 多选 → 批量加入 | 入口含空状态按钮 |
| `astrbot-devkit.SetActivePlugin` | `setActiveWorkspace(name)` + `setContext` + refresh | 点击插件节点 |
| `astrbot-devkit.Debug` | `vscode.debug.startDebugging(folder, { type: 'astrbot', ... })` 动态配置 | 侧边栏节点点击;F5 走 launch.json |
| `astrbot-devkit.StopDebug` | `vscode.debug.stopDebugging(activeSession)`;无会话时兜底 `relay.stop()` | 侧边栏菜单 |
| `astrbot-devkit.ToggleAutoConnect` | 切换 `autoConnect` 并保存 | 侧边栏开关 |
| `astrbot-devkit.EditStopAction` | QuickPick 选择 `debug.stopAction`(ask/disable/keep) | 侧边栏节点 |
| `astrbot-devkit.OpenPluginConfig` | `openPluginConfig(workspace)` | 插件节点右键 |
| `astrbot-devkit.SavePluginConfig` | `pushPluginConfig(activeEditor)` | 编辑器命令 |
| `astrbot-devkit.OpenServerLogs` | 创建/显示 `AstrBot Server` 通道 | 手动查看 |

### 10.3 启动检索提示

`maybeCreateFromScan()`:扫描到候选时

```ts
const cands = scanWorkspaceForPlugins();
if (cands.length > 0) {
    const pick = await vscode.window.showInformationMessage(
        `检测到 ${cands.length} 个 AstrBot 插件:${cands.map(c => c.name).join('、')},要加入配置吗?`,
        '添加并创建配置', '忽略',
    );
    if (pick === '添加并创建配置') { /* 写模板 + 填充候选 + 打开向导 */ }
}
```

## 11. `package.json` 改动

### 11.1 contributes 新增

```jsonc
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "astrbot", "title": "AstrBot", "icon": "media/astrbot.svg" }]
    },
    "views": {
      "astrbot": [
        { "type": "tree", "id": "astrbot-devkit.main", "name": "AstrBot DevKit" },
        { "type": "tree", "id": "astrbot-devkit.local", "name": "本地插件" }
      ]
    },
    "commands": [ /* §10.2 全部命令,title 用 %key% 占位 */ ],
    "debuggers": [
      {
        "type": "astrbot",
        "label": "AstrBot 插件",
        "languages": ["python"],
        "configurationAttributes": {
          "launch": {
            "required": ["pluginName"],
            "properties": {
              "pluginName": { "type": "string", "description": "插件名(pluginWorkspaces 中的 name)" }
            }
          }
        },
        "initialConfigurations": [
          { "type": "astrbot", "request": "launch", "name": "调试 AstrBot 插件", "pluginName": "" }
        ]
      }
    ],
    "menus": {
      "view/title": [{ "command": "astrbot-devkit.Refresh", "when": "view == astrbot-devkit.main" }],
      "view/item/context": [
        { "command": "astrbot-devkit.Debug", "when": "viewItem == devkitWorkspaceActive" },
        { "command": "astrbot-devkit.SetActivePlugin", "when": "viewItem == devkitWorkspace" },
        { "command": "astrbot-devkit.SetActivePlugin", "when": "view == astrbot-devkit.local && viewItem == devkitLocalPlugin" },
        { "command": "astrbot-devkit.Debug", "when": "view == astrbot-devkit.local && viewItem == devkitLocalPluginActive && !astrbotDevkit.debugging" },
        { "command": "astrbot-devkit.StopDebug", "when": "view == astrbot-devkit.local && viewItem == devkitLocalPluginActive && astrbotDevkit.debugging" },
        { "command": "astrbot-devkit.OpenPluginConfig", "when": "viewItem == devkitWorkspace || viewItem == devkitWorkspaceActive" },
        { "command": "astrbot-devkit.AddWorkspace", "when": "viewItem == devkitRoot" },
        { "command": "astrbot-devkit.StopDebug", "when": "viewItem == devkitLogs && astrbotDevkit.debugging" }
      ]
    }
  }
}
```

### 11.2 nls 与图标

- `package.nls.json` / `package.nls.zh-cn.json` 补齐所有新命令标题
- 需要新增 `media/astrbot.svg`(Activity Bar 图标,16x16/24x24)
- **无自定义状态栏按钮**:调试入口走 VS Code 原生机制——F5/命令面板「将插件推送至AstrBot服务器并观察」(launch.json type: astrbot)、Run and Debug 侧边栏、侧边栏插件节点点击;调试工具栏(原生)控制启停

## 12. API 对接参考(AstrBot OpenAPI 事实表)

> 已核对(2026-08-06),实现时如遇 404 请以运行时 `{base}/api/v1/openapi.json` 为准。

- 鉴权:`Authorization: Bearer abk_xxx`(或 `X-API-Key`)
- 成功包装:`{ "status": "ok", "message": string, "data": any }`;失败时 `status: "error"` 与 HTTP 状态码并存
- scope 不足:`403 Insufficient API key scope`
- 插件配置 schema 为 **AstrBot 自定义格式**(非标准 JSON Schema),校验器见 §7
- 插件识别:目录含 `metadata.yaml`(字段 `name`、`version` 必填)
- 上传 zip 仅 `install/upload`;`update` 端点不接受文件

## 13. 日志流 API 对接(logleak v0.2.0,已实测)

> 服务端插件 `astrbot_plugin_devkit_for_vscode_logleak`(v0.2.0,仓库 `17-qxm/astrbot_plugin_devkit_for_vscode_logleak`)
> 已上真实服务器实测。**鉴权由 AstrBot 全局 API Key 层强制接管,插件级密钥已废弃。**

| 项 | 值 |
|---|---|
| 插件 ID | `astrbot_plugin_devkit_for_vscode_logleak` |
| SSE 端点 | `GET {base}/api/v1/plugins/extensions/astrbot_plugin_devkit_for_vscode_logleak/logs/stream` |
| 鉴权头 | `Authorization: Bearer <astrbotAPIkey>`(无 X-Logleak-Key) |
| 未鉴权/错 key | **401** `Missing API key`(非 403) |
| 事件格式 | `data: {"ts": "...", "level": "INFO", "logger": "...", "message": "..."}` |
| 心跳 | 服务端每 **30s** 发 `data: {"type": "ping"}`(无日志时);客户端 60s 无数据判定断线 |
| 内容类型 | `text/event-stream` |

- 插件安装:`installPluginFromGithub(client, LOGLEAK_PLUGIN_REPO)`(仓库已定);未安装时 F5 提示「安装 / 继续」
- 插件缺失检测:F5 步骤 2 `listPlugins()` 按 `name === LOGLEAK_PLUGIN_ID` 判断,存在但 `enabled/activated === false` 提示「已禁用,请在 WebUI 启用」
- `logger` 字段恒为 `"astrbot"`,来源信息(`[Core]`/`[Plug]`)在 `message` 文本内;`message` 已剥离 ANSI 颜色码

## 14. 实现顺序与验收标准

| 阶段 | 新建文件 | 验收 |
|---|---|---|
| 1 | constants.ts, config.ts, api/client.ts, views/devkitTree.ts, extension.ts(激活) | 侧边栏可见;无配置时扫描提示;创建配置后可看到插件节点并切换活跃 |
| 2 | api/plugins.ts, views/configEditor.ts | 打开配置可编辑,推送成功,reload 询问生效 |
| 3 | debug/debugAdapter.ts + contributes.debuggers | F5/launch.json(type: astrbot)与侧边栏节点启动调试;打包→upload→日志;调试工具栏停止后按 stopAction 处理 |
| 4 | logs/relay.ts | debug 时日志实时写入 `AstrBot Server`;重连 ≤reconnectLimit;结束后内容保留 |
| 5 | api/im.ts + 命令 | 可向 UMO 推送消息 |

阶段 4 依赖服务端 logleak 插件就绪;在此之前 `relay.start()` 返回 false 不阻塞 F5 推送。

## 15. 实现时需验证的 TODO

1. ~~`POST /plugins/install/upload` 对已安装插件重复上传的行为~~ —— 已实现兜底:`uploadWithRetry` 失败时检测同名插件,有则 DELETE 后重装(§8.7);真实服务器上仍需验证该路径
2. `GET /plugins` 返回字段名(plugin_id/name/enabled)与 upload 响应的 `plugin_id` 字段——以实际响应为准,调整 `PluginInfo` 映射
3. ~~插件自定义路由是否受 OpenAPI 鉴权中间件拦截~~ —— **已实测确认**:Plugin Pages 路由由全局鉴权层强制保护(未带 Bearer 返回 401),插件级密钥废弃,logleakKey 配置项已移除
4. AstrBot 最低版本检查的版本号获取方式(如 `openapi.json` 内信息或系统端点)
5. `astrbotAPIkey` 前缀是否为 `abk_`(创建向导校验时按实际格式放宽为"非空")
6. 多根工作区:`workspaceFolders[0]` 策略是否需要 UI 提示
