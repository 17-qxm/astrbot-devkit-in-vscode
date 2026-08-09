// src/config/scan.ts
// 工作区插件检索、活跃插件管理、候选合并。

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import {
    SCAN_MAX_DEPTH,
    SCAN_EXCLUDE_DIRS,
} from '../constants.js';
import type { DevKitConfig, PluginCandidate, PluginWorkspace } from './types.js';
import type { ConfigSchema } from '../api/plugins.js';
import {
    getConfig, saveConfig, toRelativePosix, getWorkspaceRoot, resolve,
} from './io.js';

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

/**
 * 把候选插件合并进现有配置的 pluginWorkspaces(按 name 去重,已存在则更新 version/dir),
 * 无活跃插件时把第一个设为活跃。配置缺失时返回 0(不自动创建文件)。
 *
 * @returns 新增的插件数量
 */
export async function addPluginCandidates(cands: PluginCandidate[]): Promise<number> {
    const cur = getConfig();
    if (!cur) {return 0;}
    cur.pluginWorkspaces = cur.pluginWorkspaces ?? [];
    const existing = new Map(cur.pluginWorkspaces.map(w => [w.name, w]));
    let added = 0;
    for (const c of cands) {
        const rel = toRelativePosix(c.dir) ?? c.dir;
        const ex = existing.get(c.name);
        if (ex) {
            ex.version = c.version;
            ex.dir = rel;
        } else {
            cur.pluginWorkspaces.push({ dir: rel, name: c.name, version: c.version, active: false });
            added++;
        }
    }
    // 没有活跃插件时,标记第一个为活跃
    if (!cur.pluginWorkspaces.some(w => w.active) && cur.pluginWorkspaces.length > 0) {
        cur.pluginWorkspaces[0].active = true;
    }
    await saveConfig(cur);
    return added;
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
    // 兼容绝对路径(showOpenDialog 返回)与相对路径
    const abs = path.isAbsolute(dirRel) ? dirRel : resolve(dirRel);
    if (!abs) {return undefined;}
    const meta = path.join(abs, 'metadata.yaml');
    if (!fs.existsSync(meta)) {return undefined;}
    const parsed = parseMetadata(readText(meta));
    if (!parsed?.name || !parsed?.version) {return undefined;}
    // 目录在工作区外时返回 undefined(不能作为工作区插件)
    const rel = toRelativePosix(abs);
    if (!rel) {return undefined;}
    return { dir: rel, name: parsed.name, version: parsed.version };
}

/**
 * 读取本地插件目录下的 `_conf_schema.json`(AstrBot 自定义 schema 格式)。
 * 文件不存在/解析失败返回 undefined,不抛错。
 * 用于配置表单在插件未推送时也能基于本地 schema 渲染。
 */
export function getLocalConfigSchema(dirRel: string): ConfigSchema | undefined {
    const abs = path.isAbsolute(dirRel) ? dirRel : resolve(dirRel);
    if (!abs) {return undefined;}
    const file = path.join(abs, '_conf_schema.json');
    if (!fs.existsSync(file)) {return undefined;}
    try {
        const raw = JSON.parse(readText(file));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw as ConfigSchema;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * 工作区根是否为「空」:除约定忽略目录(.git/.vscode/.tmp 等)外没有任何条目。
 * 用于判定是否该显示「初始化插件环境」引导(弹窗 + 侧边栏入口)。
 * 未打开工作区时返回 false。
 */
export function isWorkspaceEmpty(): boolean {
    const root = getWorkspaceRoot();
    if (!root) {return false;}
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        return !entries.some(e => !SCAN_EXCLUDE_DIRS.has(e.name));
    } catch {
        return false;
    }
}
