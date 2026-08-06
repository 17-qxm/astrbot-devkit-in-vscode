// src/constants.ts
// 全局常量集中点。被 config.ts / api / views / debug / logs 复用。
// 修改值时注意配套调整 package.json 与 schemas/。

/** 日志投射插件 ID(服务端插件名,已定,勿改)。F5 步骤 2 按 name 检测它。 */
export const LOGLEAK_PLUGIN_ID = 'astrbot_plugin_devkit_for_vscode_logleak';

/** 日志流 SSE 端点(插件自定义路由挂载路径,见 implementation.md §13) */
export const LOGLEAK_SSE_ROUTE =
    `/api/v1/plugins/extensions/${LOGLEAK_PLUGIN_ID}/logs/stream`;

/** 日志流鉴权请求头(插件侧自校验,与 OpenAPI 的 abk_ key 无关) */
export const LOGLEAK_AUTH_HEADER = 'X-Logleak-Key';

/** 扩展自身操作日志通道名(对应现有 logger.ts) */
export const OUTPUT_CHANNEL_DEVKIT = 'AstrBot DevKit';

/** 服务器日志通道名(debug 时 SSE 写入,见 design.md §9.4) */
export const OUTPUT_CHANNEL_SERVER = 'AstrBot Server';

/** 配置文件相对工作区根的路径 */
export const CONFIG_REL_PATH = '.vscode/astrbot-devkit-config.json';

/** 当前配置 schema 版本(v1 配置由 normalizeConfig 自动迁移) */
export const CONFIG_VERSION = 2;

/** AstrBot OpenAPI 要求的最低版本(配置/插件管理) */
export const MIN_ASTRBOT_VERSION = 'v4.18';
/** 日志投射(Plugin Pages)要求的最低版本 */
export const MIN_ASTRBOT_VERSION_LOGLEAK = 'v4.24';

/** 新命令前缀(与现有 astrbot-devkit-in-vscode.* 区分) */
export const CMD_PREFIX = 'astrbot-devkit.';

/** F5 / Shift+F5 快捷键(仅当对应 context key 为 true 时接管) */
export const DEBUG_KEY = 'f5';
export const STOP_DEBUG_KEY = 'shift+f5';

/** 默认请求超时(ms) */
export const REQUEST_TIMEOUT_MS = 15_000;

/** 探活专用短超时(ms),启动时静默探活用,见 design.md §3.3 */
export const PROBE_TIMEOUT_MS = 5_000;

/** ruff 可执行文件路径(相对工作区根) */
export const RUFF_WIN = '.venv/Scripts/ruff.exe';
export const RUFF_UNIX = '.venv/bin/ruff';

/** 打包排除规则(目录名或 glob 通配) */
export const ZIP_EXCLUDE = ['.git', '__pycache__', '.venv', 'dist', '.tmp', '*.pyc'];

/** SSE 心跳超时(ms):超过此时间无任何数据(含 ping)判定断线 */
export const SSE_IDLE_TIMEOUT_MS = 60_000;

/** SSE 断线重连退避序列(ms),逐次使用,用完即停 */
export const SSE_RECONNECT_BACKOFF_MS = [3_000, 10_000, 30_000];

/** 插件检索:最大递归深度(工作区根记为第 0 层) */
export const SCAN_MAX_DEPTH = 4;

/** 插件检索:跳过的目录名(不进、不下钻) */
export const SCAN_EXCLUDE_DIRS = new Set([
    '.git', 'node_modules', '.vscode', '.venv', 'dist', '.tmp', 'claude', 'codex',
]);
