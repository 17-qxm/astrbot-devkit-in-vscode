// src/api/plugins.ts
// 插件管理 API:列出/配置/启用/重载/上传安装。端点映射见 implementation.md §4.3。

import type { AstrBotClient } from './client.js';

/**
 * GET /plugins 返回项。
 * 实测服务器(v4.4.0)返回:无 id 字段(用 name 作唯一标识),启用状态字段是
 * `activated`(非 enabled)。这里两者都标可选 + 带 helpers,兼容新旧。
 */
export interface PluginInfo {
    /** 服务器实际不返回此字段;用 name 作 id。保留是为了兼容旧响应 */
    id?: string;
    name: string;
    /** 旧字段;新服务器用 activated */
    enabled?: boolean;
    /** 新服务器(v4.x)的启用状态字段 */
    activated?: boolean;
    version?: string;
    desc?: string;
    repo?: string;
    [k: string]: unknown;
}

/** 插件是否处于启用状态:优先 activated(新),其次 enabled(旧),默认 true */
export function isPluginEnabled(p: PluginInfo): boolean {
    // activated 优先;若显式为 false 则禁用;undefined 时 fallback 到 enabled
    if (p.activated !== undefined) {return p.activated;}
    if (p.enabled !== undefined) {return p.enabled;}
    return true;
}

/** 取插件唯一标识:优先 id,否则 name(新服务器无 id) */
export function pluginIdOf(p: PluginInfo): string {
    return p.id ?? p.name;
}

/**
 * _conf_schema.json 字段定义(AstrBot 自定义格式,非标准 JSON Schema)。
 * 字段含义见 design.md §4.3。
 */
export interface SchemaField {
    type?: string;
    description?: string;
    hint?: string;
    obvious_hint?: string;
    default?: unknown;
    options?: unknown[];
    /** type=object 时的子 schema,可无限嵌套 */
    items?: Record<string, SchemaField>;
    invisible?: boolean;
    _special?: string;
    editor_mode?: string;
    editor_language?: string;
    [k: string]: unknown;
}

export type ConfigSchema = Record<string, SchemaField>;

// ─── 端点封装 ────────────────────────────────────────────

/** GET /api/v1/plugins — 列出已安装插件 */
export async function listPlugins(
    client: AstrBotClient,
    opts?: { includeReserved?: boolean; enabled?: boolean },
): Promise<PluginInfo[]> {
    const qs = new URLSearchParams();
    if (opts?.includeReserved !== undefined) {
        qs.set('include_reserved', String(opts.includeReserved));
    }
    if (opts?.enabled !== undefined) {
        qs.set('enabled', String(opts.enabled));
    }
    const q = qs.toString();
    const data = await client.request<PluginInfo[] | { plugins?: PluginInfo[] }>(
        `/api/v1/plugins${q ? `?${q}` : ''}`,
    );
    // 兼容两种返回:直接数组 / { plugins: [...] }
    return Array.isArray(data) ? data : (data?.plugins ?? []);
}

/** GET /api/v1/plugins/{id}/config — 读取插件当前配置 */
export async function getPluginConfig(
    client: AstrBotClient, pluginId: string,
): Promise<Record<string, unknown>> {
    return client.request<Record<string, unknown>>(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/config`,
    );
}

/** PUT /api/v1/plugins/{id}/config — 保存插件配置 */
export async function savePluginConfig(
    client: AstrBotClient, pluginId: string, config: object,
): Promise<void> {
    await client.request<unknown>(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/config`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        },
    );
}

/** GET /api/v1/plugins/{id}/config/schema — 获取 _conf_schema.json 内容 */
export async function getPluginConfigSchema(
    client: AstrBotClient, pluginId: string,
): Promise<ConfigSchema> {
    const data = await client.request<ConfigSchema>(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/config/schema`,
    );
    return data ?? {};
}

/** PATCH /api/v1/plugins/{id}/enabled — 启用/禁用插件 */
export async function setPluginEnabled(
    client: AstrBotClient, pluginId: string, enabled: boolean,
): Promise<void> {
    await client.request<unknown>(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/enabled`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        },
    );
}

/** POST /api/v1/plugins/{id}/reload — 重载插件 */
export async function reloadPlugin(client: AstrBotClient, pluginId: string): Promise<void> {
    await client.request<unknown>(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/reload`,
        { method: 'POST' },
    );
}

/** DELETE /api/v1/plugins/{id} — 删除插件(同名冲突时先删后装) */
export async function deletePlugin(client: AstrBotClient, pluginId: string): Promise<void> {
    await client.request<unknown>(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}`,
        { method: 'DELETE' },
    );
}

/** POST /api/v1/plugins/install/github — 从 GitHub 安装 */
export async function installPluginFromGithub(
    client: AstrBotClient, repository: string,
): Promise<void> {
    await client.request<unknown>(
        '/api/v1/plugins/install/github',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repository }),
        },
    );
}

/**
 * POST /api/v1/plugins/install/upload — 上传 zip 安装/覆盖。
 * 返回 upload 响应(从中可取 plugin_id)。
 *
 * 注意:已安装插件重复上传的行为待真实服务器验证(implementation.md §15 TODO 1);
 * 当前实现按 design.md §8.2「先取 plugin_id,必要时补匹配」处理。
 */
export async function uploadPluginZip(
    client: AstrBotClient, zipBuffer: Buffer, filename: string,
): Promise<{ plugin_id?: string; [k: string]: unknown }> {
    return client.uploadZip(zipBuffer, filename);
}

/**
 * 按 name 匹配插件 id(用于 configEditor / debugAdapter)。
 * 新服务器无 id 字段,直接用 name 作标识;返回值用作 /plugins/{id}/... 的 path 参数。
 */
export async function resolvePluginId(
    client: AstrBotClient, name: string,
): Promise<string | undefined> {
    const plugins = await listPlugins(client, { includeReserved: true });
    const byName = plugins.find(p => p.name === name);
    if (byName) {return pluginIdOf(byName);}
    const byId = plugins.find(p => p.id === name);
    return byId ? pluginIdOf(byId) : undefined;
}
