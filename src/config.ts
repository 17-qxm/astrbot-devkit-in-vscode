// src/config.ts
// 配置层:读写 .vscode/astrbot-devkit-config.json,加载/校验/迁移/插件检索。
// 所有路径相对工作区根(workspaceFolders[0]);未打开工作区时返回 undefined。

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import * as logger from './logger.js';
import {
    CONFIG_REL_PATH,
    CONFIG_VERSION,
    SCAN_MAX_DEPTH,
    SCAN_EXCLUDE_DIRS,
} from './constants.js';

// ─── 类型 ────────────────────────────────────────────────

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

/** 配置文件模板(ensureConfigFile 写入) */
const TEMPLATE_CONFIG: DevKitConfig = {
    version: CONFIG_VERSION,
    astrbotServer: '127.0.0.1:6185',
    astrbotAPIkey: '',
    debug: { ...DEFAULT_DEBUG },
    pluginWorkspaces: [],
};

// ─── 路径 ────────────────────────────────────────────────

/** 取工作区根绝对路径;未打开工作区返回 undefined */
export function getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** 配置文件绝对路径;未打开工作区返回 undefined */
export function getConfigFilePath(): string | undefined {
    const root = getWorkspaceRoot();
    return root ? path.join(root, CONFIG_REL_PATH) : undefined;
}

/** 相对工作区根的路径 → 绝对路径 */
function resolve(relPath: string): string | undefined {
    const root = getWorkspaceRoot();
    return root ? path.join(root, relPath) : undefined;
}

/** 把绝对路径转回相对工作区根的 POSIX 路径(用于 pluginWorkspaces.dir 存储统一) */
export function toRelativePosix(absPath: string): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) {return undefined;}
    const rel = path.relative(root, absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        // 统一为 POSIX 分隔符;空字符串表示工作区根本身
        return rel.split(path.sep).join('/') || '.';
    }
    return undefined;
}

// ─── 加载 / 写回 ─────────────────────────────────────────

/** 读取 JSONC(容忍注释与尾逗号);解析失败返回 undefined */
function readJsonc(filePath: string): unknown | undefined {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const clean = stripJsonc(text);
        return JSON.parse(clean);
    } catch {
        return undefined;
    }
}

/**
 * 去除 JSONC 的注释与尾逗号,返回可被 JSON.parse 的纯 JSON。
 * 用状态机正确处理字符串(含转义)与注释,不会误伤字符串内容。
 * (注:不依赖 jsonc-parser——其 UMD 构建无法被 esbuild 正确打包)
 */
function stripJsonc(text: string): string {
    let out = '';
    let inString = false;
    let quote = '';
    let escaped = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];

        // 字符串内:原样输出,处理转义与闭合引号
        if (inString) {
            out += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === quote) {
                inString = false;
            }
            i++;
            continue;
        }
        // 字符串开始(JSON 标准只允许双引号,这里容忍单引号)
        if (ch === '"' || ch === "'") {
            inString = true;
            quote = ch;
            out += ch;
            i++;
            continue;
        }
        // 行注释
        if (ch === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') {i++;}
            continue;
        }
        // 块注释
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {i++;}
            i += 2;
            continue;
        }
        // 尾逗号:逗号后(跳过空白)是 } 或 ] 时不输出(仅在字符串外判断)
        if (ch === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) {j++;}
            if (text[j] === '}' || text[j] === ']') {
                i++;
                continue;
            }
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * 返回工作区配置;未打开工作区 / 文件不存在 / 解析失败均返回 undefined。
 * 解析失败会写日志提示文件位置。
 */
export function getConfig(): DevKitConfig | undefined {
    const file = getConfigFilePath();
    if (!file || !fs.existsSync(file)) {return undefined;}
    const raw = readJsonc(file);
    if (raw === undefined) {
        logger.error(`配置解析失败:${file}`);
        return undefined;
    }
    return normalizeConfig(raw);
}

/**
 * v1→v2 迁移:补齐 debug 块(默认值)、条目 active 字段,升级版本号。
 * 未知版本按 v2 处理。保证返回的对象字段齐全、可直接使用。
 */
export function normalizeConfig(raw: unknown): DevKitConfig {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const debugRaw = (obj.debug ?? {}) as Record<string, unknown>;
    const debug: DebugSettings = {
        stopAction: asEnum(debugRaw.stopAction, ['ask', 'disable', 'keep'], DEFAULT_DEBUG.stopAction),
        reloadAfterPush: asEnum(debugRaw.reloadAfterPush, ['ask', 'always', 'never'], DEFAULT_DEBUG.reloadAfterPush),
        receiveLogs: typeof debugRaw.receiveLogs === 'boolean' ? debugRaw.receiveLogs : DEFAULT_DEBUG.receiveLogs,
        reconnectLimit: typeof debugRaw.reconnectLimit === 'number' ? debugRaw.reconnectLimit : DEFAULT_DEBUG.reconnectLimit,
    };
    const ws = Array.isArray(obj.pluginWorkspaces) ? (obj.pluginWorkspaces as unknown[])
        .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
        .map(w => ({
            dir: String(w.dir ?? ''),
            name: String(w.name ?? ''),
            version: String(w.version ?? ''),
            active: typeof w.active === 'boolean' ? w.active : false,
        }))
        .filter(w => w.dir && w.name && w.version) as PluginWorkspace[]
        : [];
    return {
        version: CONFIG_VERSION,
        astrbotServer: typeof obj.astrbotServer === 'string' ? obj.astrbotServer : '',
        astrbotAPIkey: typeof obj.astrbotAPIkey === 'string' ? obj.astrbotAPIkey : '',
        autoConnect: typeof obj.autoConnect === 'boolean' ? obj.autoConnect : true,
        debug,
        pluginWorkspaces: ws,
    };
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback;
}

/** 写回配置(JSON 序列化,4 空格缩进);父目录不存在时自动创建 */
export async function saveConfig(config: DevKitConfig): Promise<void> {
    const file = getConfigFilePath();
    if (!file) {
        logger.error('未打开工作区,无法写入配置');
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 4), 'utf8');
    logger.log(`配置已写入:${file}`);
}

/** 配置缺失时写入模板文件;返回是否成功写入(已存在则返回 false) */
export async function ensureConfigFile(): Promise<boolean> {
    const file = getConfigFilePath();
    if (!file) {return false;}
    if (fs.existsSync(file)) {return false;}
    await saveConfig({ ...TEMPLATE_CONFIG });
    return true;
}

// ─── 校验 ────────────────────────────────────────────────

const SERVER_PATTERN = /^(https?:\/\/)?[a-zA-Z0-9.\-]+(:[0-9]+)?(\/.*)?$/;

/**
 * 校验配置,返回错误列表(空 = 合法)。规则见 design.md §5.4。
 */
export function validateConfig(config: DevKitConfig): string[] {
    const errors: string[] = [];
    if (!config.astrbotServer) {
        errors.push('astrbotServer 为空');
    } else if (!SERVER_PATTERN.test(config.astrbotServer)) {
        errors.push(`astrbotServer 格式不合法:${config.astrbotServer}(支持 host:port 或 http(s)://…)`);
    }
    // 注:TODO §15.5 提到 abk_ 前缀待真实服务器放宽,这里只在非空时做弱校验
    if (!config.astrbotAPIkey) {
        errors.push('astrbotAPIkey 为空,请在 AstrBot WebUI 创建 API Key');
    }
    if (config.debug.reconnectLimit < 0) {
        errors.push('debug.reconnectLimit 不能为负');
    }
    if (config.pluginWorkspaces) {
        const activeCount = config.pluginWorkspaces.filter(w => w.active).length;
        if (activeCount > 1) {
            errors.push(`pluginWorkspaces 中 active=true 的条目超过一个(${activeCount} 个),已自动修正为唯一`);
        }
        const names = config.pluginWorkspaces.map(w => w.name);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        if (dup.length) {
            errors.push(`pluginWorkspaces 存在重名插件:${[...new Set(dup)].join(', ')}`);
        }
    }
    return errors;
}

// ─── 活跃插件 ────────────────────────────────────────────

/** 返回活跃插件;无则 undefined(多个 active 时取第一个) */
export function getActiveWorkspace(config: DevKitConfig | undefined): PluginWorkspace | undefined {
    if (!config?.pluginWorkspaces?.length) {return undefined;}
    return config.pluginWorkspaces.find(w => w.active) ?? config.pluginWorkspaces[0];
}

/** 把指定 name 的条目设为唯一 active,其余置 false,并写回 */
export async function setActiveWorkspace(name: string): Promise<void> {
    const config = getConfig();
    if (!config?.pluginWorkspaces) {return;}
    let changed = false;
    for (const w of config.pluginWorkspaces) {
        const want = w.name === name;
        if (w.active !== want) {
            w.active = want;
            changed = true;
        }
    }
    if (changed) {
        await saveConfig(config);
    }
}

// ─── 监听 ────────────────────────────────────────────────

/**
 * 监听配置文件变化(fs.watch,防抖 300ms),变更时回调。
 * 返回 Disposable;未被 push 到 subscriptions 时调用方需自行 dispose。
 */
export function watchConfig(cb: () => void): vscode.Disposable {
    const file = getConfigFilePath();
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
        if (timer) {clearTimeout(timer);}
        timer = setTimeout(() => {
            timer = undefined;
            try { cb(); } catch (e) {
                logger.error(`watchConfig 回调异常:${(e as Error)?.message ?? e}`);
            }
        }, 300);
    };
    const watchers: fs.FSWatcher[] = [];
    if (file) {
        try {
            // 监听文件本身 + 父目录(应对文件被替换/创建)
            watchers.push(fs.watch(file, fire));
            const dir = path.dirname(file);
            if (fs.existsSync(dir)) {
                watchers.push(fs.watch(dir, (evt, filename) => {
                    if (filename && filename.includes(path.basename(file))) {fire();}
                }));
            }
        } catch (e) {
            logger.error(`启动配置监听失败:${(e as Error)?.message ?? e}`);
        }
    }
    return new vscode.Disposable(() => {
        if (timer) {clearTimeout(timer);}
        watchers.forEach(w => { try { w.close(); } catch {} });
    });
}

// ─── 插件检索 ────────────────────────────────────────────

/**
 * 扫描工作区找 AstrBot 插件:工作区根本身 + 子目录,深度 ≤ SCAN_MAX_DEPTH。
 * 排除 SCAN_EXCLUDE_DIRS 目录;判定标准=目录含 metadata.yaml 且能解析出合法 name+version。
 */
export function scanWorkspaceForPlugins(): PluginCandidate[] {
    const root = getWorkspaceRoot();
    if (!root) {return [];}
    const found: PluginCandidate[] = [];
    const seen = new Set<string>();
    const walk = (dirAbs: string, depth: number) => {
        if (depth > SCAN_MAX_DEPTH) {return;}
        // 先判定当前目录是否是插件根
        const meta = path.join(dirAbs, 'metadata.yaml');
        if (fs.existsSync(meta)) {
            const parsed = parseMetadata(readText(meta));
            if (parsed?.name && parsed?.version) {
                const rel = toRelativePosix(dirAbs);
                if (rel && !seen.has(rel)) {
                    seen.add(rel);
                    found.push({ dir: rel, name: parsed.name, version: parsed.version });
                }
                // 是插件根就不再下钻(避免扫到插件内部的依赖目录)
                return;
            }
        }
        // 非插件根 → 下钻
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory()) {continue;}
            if (SCAN_EXCLUDE_DIRS.has(e.name)) {continue;}
            walk(path.join(dirAbs, e.name), depth + 1);
        }
    };
    walk(root, 0);
    return found.sort((a, b) => a.name.localeCompare(b.name));
}

function readText(p: string): string {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * 解析 metadata.yaml,只取插件检索与展示需要的字段。
 * 解析失败/字段缺失返回 undefined,不抛错(见 design.md §13 风险)。
 */
export function parseMetadata(
    yamlText: string,
): { name?: string; version?: string; desc?: string } | undefined {
    if (!yamlText) {return undefined;}
    try {
        const doc = parse(yamlText) as Record<string, unknown> | null;
        if (!doc || typeof doc !== 'object') {return undefined;}
        const name = typeof doc.name === 'string' ? doc.name.trim() : undefined;
        const version = typeof doc.version === 'string' ? doc.version.trim() : undefined;
        const desc = typeof doc.desc === 'string' ? doc.desc.trim() : undefined;
        const out: { name?: string; version?: string; desc?: string } = {};
        if (name) {out.name = name;}
        if (version) {out.version = version;}
        if (desc) {out.desc = desc;}
        return out;
    } catch {
        return undefined;
    }
}

/** 校验某目录是否是合法插件根(含 metadata.yaml 且能解析出 name+version) */
export function isPluginRoot(dirRel: string): PluginCandidate | undefined {
    const abs = resolve(dirRel);
    if (!abs) {return undefined;}
    const meta = path.join(abs, 'metadata.yaml');
    if (!fs.existsSync(meta)) {return undefined;}
    const parsed = parseMetadata(readText(meta));
    if (!parsed?.name || !parsed?.version) {return undefined;}
    const rel = toRelativePosix(abs) ?? dirRel;
    return { dir: rel, name: parsed.name, version: parsed.version };
}
