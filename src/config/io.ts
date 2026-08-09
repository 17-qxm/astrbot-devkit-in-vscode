// src/config/io.ts
// 配置文件读写:路径解析、JSONC 解析、加载/写回/模板/监听。

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as logger from '../logger.js';
import {
    CONFIG_REL_PATH,
    CONFIG_VERSION,
} from '../constants.js';
import type { DevKitConfig } from './types.js';
import { DEFAULT_DEBUG } from './types.js';
import { normalizeConfig } from './validate.js';

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
export function resolve(relPath: string): string | undefined {
    const root = getWorkspaceRoot();
    return root ? path.join(root, relPath) : undefined;
}

/** 把绝对路径转回相对工作区根的 POSIX 路径(用于 pluginWorkspaces.dir 存储统一) */
export function toRelativePosix(absPath: string): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) {return undefined;}
    const rel = path.relative(root, absPath);
    if (!rel) {
        return '.';   // 工作区根本身
    }
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        // 统一为 POSIX 分隔符
        return rel.split(path.sep).join('/');
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
