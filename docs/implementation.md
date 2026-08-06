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
/** 日志流鉴权请求头 */
export const LOGLEAK_AUTH_HEADER = 'X-Logleak-Key';

export const OUTPUT_CHANNEL_DEVKIT = 'AstrBot DevKit';
export const OUTPUT_CHANNEL_SERVER = 'AstrBot Server';

export const CONFIG_REL_PATH = '.vscode/astrbot-devkit-config.json';
export const CONFIG_VERSION = 2;

/** F5 相关 */
export const CMD_PREFIX = 'astrbot-devkit.';
export const DEBUG_KEY = 'f5';
export const STOP_DEBUG_KEY = 'shift+f5';

/** ruff 路径(相对工作区根) */
export const RUFF_WIN = '.venv/Scripts/ruff.exe';
export const RUFF_UNIX = '.venv/bin/ruff';

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
│   └── debugSession.ts  F5 工作流(新增)
├── views/
│   ├── devkitTree.ts    侧边栏 TreeDataProvider(新增)
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
            → debug/debugSession.ts → api/plugins.ts, views/configEditor.ts, logs/relay.ts
            → logs/relay.ts → api/client.ts, constants.ts
```

## 2. `src/config.ts` — 配置层

### 2.1 类型

```ts
import type * as vscode from 'vscode';

export interface DebugSettings {
    stopAction: 'ask' | 'disable' | 'keep';
    reloadAfterPush: 'ask' | 'always' | 'never';
    ruffFix: boolean;
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
    logleakKey?: string;               // 扩展自动生成;空则日志不可用
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
    ruffFix: false,
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

/** 配置缺失时写入模板文件(v2:debug 默认值、logleakKey 留空、pluginWorkspaces 空) */
export function ensureConfigFile(): Promise<boolean>;

/** 校验配置,返回错误列表(空 = 合法) */
export function validateConfig(): string[];

/** 写回配置(JSON 序列化,4 空格缩进) */
export function saveConfig(config: DevKitConfig): Promise<void>;

/** 生成随机密钥(用于 logleakKey) */
export function generateKey(): string;   // crypto.randomBytes(24).toString('hex')

/** 活跃插件;无则返回 undefined */
export function getActiveWorkspace(config: DevKitConfig): PluginWorkspace | undefined;

/** 设置唯一 active 条目并写回 */
export function setActiveWorkspace(name: string): Promise<void>;

/**
 * 扫描工作区找插件:工作区根 + 子目录,深度 ≤4 层。
 * 排除: .git/ node_modules/ .vscode/ .venv/ dist/ .tmp/ claude/ codex/
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
  "logleakKey": "",
  "debug": {
    "stopAction": "ask",
    "reloadAfterPush": "ask",
    "ruffFix": false,
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

## 8. `src/debug/debugSession.ts` — F5 工作流

### 8.1 类型

```ts
import type { PluginWorkspace } from '../config.js';

export type DebugState = 'idle' | 'ruff' | 'packaging' | 'uploading' | 'streaming' | 'error';

export class DebugSession {
    constructor(client: AstrBotClient, relay: LogRelay);
    get state(): DebugState;

    /** 入口:前置检查 → ruff → 打包 → upload → 打开日志 → 通知停止 */
    start(workspace: PluginWorkspace): Promise<void>;

    /** 停止观察日志 → 按 debug.stopAction 处理插件 */
    stop(): Promise<void>;
}
```

### 8.2 流程与子函数

```ts
/** 前置检查(§design 3.4):配置存在、已连接(未连接自动 connect)、有活跃插件 */
private ensureReady(workspace: PluginWorkspace): Promise<void>;

/** ruff 检查;.venv 缺失时引导创建,拒绝则尝试系统 ruff */
private ruffCheck(workspace: PluginWorkspace): Promise<boolean>;

/** adm-zip 打包 dir 下全部内容,排除 ZIP_EXCLUDE,输出 Buffer */
private packagePlugin(workspace: PluginWorkspace): Promise<Buffer>;
```

### 8.3 步骤细节

**`ensureReady`**

1. `getConfig()` 为 undefined → 提示「尚未配置 AstrBot 服务器」+「创建配置」,中止
2. `client.state !== 'connected'` → `showInformationMessage('服务器未连接,正在尝试连接…')` → `client.connect()`;失败 → 错误通知(带 `ApiError.kind` 分类)+「打开配置」「重试」,中止
3. workspace 为空(调用方传入)→ 提示「请先在侧边栏选择一个插件工作区」,中止
4. `state === 'streaming'`(重复 F5)→ 先 `await this.stop()` 再继续

**`ruffCheck`**

1. 目标路径:Windows `RUFF_WIN` / Unix `RUFF_UNIX`(相对工作区根)
2. 存在 → `tool.run(\`"${ruffPath}" check ${workspace.dir}\`, { captureOutput: true })`,带 `--fix` 当 `debug.ruffFix`
3. 不存在 → `showInformationMessage('未检测到虚拟环境,是否创建?', '创建', '跳过')`
   - 「创建」→ `tool.run('python -m venv .venv', { captureOutput: true })`(失败则报错中止)→ 重新走步骤 2
   - 「跳过」→ 尝试 `tool.run('ruff check ...', { captureOutput: true })`
   - 仍不可用 → 提示「插件要求 ruff 检查,请先安装 ruff 或创建虚拟环境」,中止
4. 失败(非零退出码)→ 提示「ruff 检查未通过,请先修复」,中止

**`packagePlugin`**

1. 校验 `workspace.dir` 存在且含 `metadata.yaml`(不是插件根则报错)
2. `adm-zip` 遍历目录,跳过 `ZIP_EXCLUDE` 匹配项;zip 根即 dir 内容(`main.py` 在 zip 根)
3. 文件名:`${workspace.name}.zip`,先删 `.tmp/` 下旧文件

**`start` 主流程**

```ts
await this.ensureReady(workspace);
if (!await this.ruffCheck(workspace)) return;
const zip = await this.packagePlugin(workspace);
const resp = await uploadPluginZip(this.client, zip, `${workspace.name}.zip`);
const pluginId = resp.plugin_id;        // TODO: 若响应无 plugin_id,按 name 从 listPlugins 匹配
await this.relay.start();               // 清空 + show + SSE
await this.showStopNotification(workspace);
this.state = 'streaming';
```

**`stop`**

1. `this.relay.stop()`(断 SSE、停重连)
2. 按 `debug.stopAction`:
   - `ask` → `showInformationMessage(\`是否禁用插件 ${name}?\`, '禁用', '保留')` → 「禁用」→ `setPluginEnabled(client, pluginId, false)`
   - `disable` → 直接 `setPluginEnabled(client, pluginId, false)`
   - `keep` → 不动
3. `setContext('astrbotDevkit.debugging', false)`;`AstrBot Server` 通道内容保留

## 9. `src/logs/relay.ts` — SSE 日志客户端

### 9.1 类型

```ts
export class LogRelay {
    constructor(client: AstrBotClient, channel: vscode.OutputChannel);
    get running(): boolean;

    /** 清空 AstrBot Server 通道并弹出,启动 SSE;返回是否启动成功 */
    start(): Promise<boolean>;

    /** 断开 SSE,停止重连 */
    stop(): void;
}
```

### 9.2 实现要点

- SSE URL:`client.baseUrl + LOGLEAK_SSE_ROUTE`;请求头 `X-Logleak-Key: client.config.logleakKey`
- `fetch` 流式读取:`response.body.getReader()` 按 `\n` 切行,只处理 `data: ` 前缀;SSE 事件 JSON:`{ ts, level, logger, message }`
- 写出行格式:`[HH:MM:SS] [LEVEL] logger message`(ts 取本地时间)
- `message` 可能含多行:按 `\n` 拆成多行 `appendLine`,保持顺序
- 重连:失败/断开后按 `SSE_RECONNECT_BACKOFF_MS` 退避,次数上限 `config.debug.reconnectLimit`;超过后 `appendLine('⚠️ 日志连接已断开,请重新 Debug')` 并停止
- 心跳:记录最后收到数据时间;60s 无数据(含 ping)视为断线,走重连逻辑
- `logleakKey` 为空时 `start()` 返回 false 并提示「未配置 logleakKey,日志不可用」
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
| `astrbot-devkit.CreateConfig` | 创建向导(§config 输入矩阵) | InputBox server → API key(立即验证)→ 生成 logleakKey → 检索填充 → 写文件 |
| `astrbot-devkit.OpenConfig` | `vscode.window.showTextDocument` 打开配置文件 | 编辑 JSON |
| `astrbot-devkit.EditServerAddress` | InputBox 修改 `astrbotServer` 并保存 | 校验格式 |
| `astrbot-devkit.Connect` | `client.connect()` | 失败弹错误分类 |
| `astrbot-devkit.AddWorkspace` | `showOpenDialog` 选文件夹 → 校验 metadata.yaml → 追加 | 文件夹必须是插件根 |
| `astrbot-devkit.ScanPlugins` | 扫描 → `showQuickPick` 多选 → 批量加入 | 入口含空状态按钮 |
| `astrbot-devkit.SetActivePlugin` | `setActiveWorkspace(name)` + `setContext` + refresh | 点击插件节点 |
| `astrbot-devkit.Debug` | `debugSession.start(activeWorkspace)` | F5 绑定 |
| `astrbot-devkit.StopDebug` | `debugSession.stop()` | Shift+F5 绑定 |
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
      "astrbot": [{ "type": "tree", "id": "astrbot-devkit.main", "name": "AstrBot DevKit" }]
    },
    "commands": [ /* §10.2 全部命令,title 用 %key% 占位 */ ],
    "keybindings": [
      { "command": "astrbot-devkit.Debug", "key": "f5", "when": "astrbotDevkit.active" },
      { "command": "astrbot-devkit.StopDebug", "key": "shift+f5", "when": "astrbotDevkit.debugging" }
    ],
    "menus": {
      "view/title": [{ "command": "astrbot-devkit.Refresh", "when": "view == astrbot-devkit.main" }],
      "view/item/context": [
        { "command": "astrbot-devkit.Debug", "when": "viewItem == devkitWorkspaceActive" },
        { "command": "astrbot-devkit.SetActivePlugin", "when": "viewItem == devkitWorkspace" },
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

## 12. API 对接参考(AstrBot OpenAPI 事实表)

> 已核对(2026-08-06),实现时如遇 404 请以运行时 `{base}/api/v1/openapi.json` 为准。

- 鉴权:`Authorization: Bearer abk_xxx`(或 `X-API-Key`)
- 成功包装:`{ "status": "ok", "message": string, "data": any }`;失败时 `status: "error"` 与 HTTP 状态码并存
- scope 不足:`403 Insufficient API key scope`
- 插件配置 schema 为 **AstrBot 自定义格式**(非标准 JSON Schema),校验器见 §7
- 插件识别:目录含 `metadata.yaml`(字段 `name`、`version` 必填)
- 上传 zip 仅 `install/upload`;`update` 端点不接受文件

## 13. 日志流 API 对接(logleak,插件端暂不实现)

> 服务端插件 `astrbot_plugin_devkit_for_vscode_logleak` 由后续单独开发。VS Code 侧对接契约固定如下:

| 项 | 值 |
|---|---|
| 插件 ID | `astrbot_plugin_devkit_for_vscode_logleak` |
| SSE 端点 | `GET {base}/api/v1/plugins/extensions/astrbot_plugin_devkit_for_vscode_logleak/logs/stream` |
| 鉴权头 | `X-Logleak-Key: <logleakKey>` |
| 事件格式 | `data: {"ts": "...", "level": "INFO", "logger": "...", "message": "..."}` |
| 心跳 | 服务端定时 `data: {"type": "ping"}` |
| 内容类型 | `text/event-stream` |

- 插件安装:`installPluginFromGithub(client, repository)`(repository 待定)→ 自动生成 `logleakKey` 写入本地配置与插件配置
- 插件缺失检测:F5 步骤 2 `listPlugins()` 按 `name === LOGLEAK_PLUGIN_ID` 判断 → 通知「安装 / 继续」(§design 9.3)

## 14. 实现顺序与验收标准

| 阶段 | 新建文件 | 验收 |
|---|---|---|
| 1 | constants.ts, config.ts, api/client.ts, views/devkitTree.ts, extension.ts(激活) | 侧边栏可见;无配置时扫描提示;创建配置后可看到插件节点并切换活跃 |
| 2 | api/plugins.ts, views/configEditor.ts | 打开配置可编辑,推送成功,reload 询问生效 |
| 3 | debug/debugSession.ts | F5 完成 ruff→打包→upload;通知出现「停止」;停止后按 stopAction 处理 |
| 4 | logs/relay.ts | debug 时日志实时写入 `AstrBot Server`;重连 ≤reconnectLimit;结束后内容保留 |
| 5 | api/im.ts + 命令 | 可向 UMO 推送消息 |

阶段 4 依赖服务端 logleak 插件就绪;在此之前 `relay.start()` 返回 false 不阻塞 F5 推送。

## 15. 实现时需验证的 TODO

1. `POST /plugins/install/upload` 对已安装插件重复上传的行为(覆盖 or 报错)——决定是否需要先删后装
2. `GET /plugins` 返回字段名(plugin_id/name/enabled)与 upload 响应的 `plugin_id` 字段——以实际响应为准,调整 `PluginInfo` 映射
3. 插件自定义路由是否受 OpenAPI 鉴权中间件拦截(若被拦截,确认路由接受 `abk_` key 或仅 logleakKey 自校验)
4. AstrBot 最低版本检查的版本号获取方式(如 `openapi.json` 内信息或系统端点)
5. `astrbotAPIkey` 前缀是否为 `abk_`(创建向导校验时按实际格式放宽为"非空")
6. 多根工作区:`workspaceFolders[0]` 策略是否需要 UI 提示
