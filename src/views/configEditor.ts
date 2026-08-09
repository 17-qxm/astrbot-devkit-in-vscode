// src/views/configEditor.ts
// 插件配置编辑:从服务器拉取当前值 + schema,在 untitled 文档中编辑,
// 「推送到服务器」命令触发轻量校验 + PUT。
// 见 implementation.md §7 与 design.md §5.6 / §7.4。

import * as vscode from 'vscode';
import type { AstrBotClient } from '../api/client.js';
import {
    getPluginConfig, getPluginConfigSchema, savePluginConfig,
    reloadPlugin, resolvePluginId, type ConfigSchema, type SchemaField,
} from '../api/plugins.js';
import type { PluginWorkspace } from '../config/index.js';
import { getConfig, getLocalConfigSchema } from '../config/index.js';
import * as logger from '../logger.js';
import { describeApiError } from '../api/client.js';

/** 配置编辑会话(按 untitled 文档 URI 维护) */
interface ConfigEditSession {
    workspace: PluginWorkspace;
    pluginId: string;
    schema: ConfigSchema;
    document: vscode.TextDocument;
}

/** 当前打开的配置编辑会话,文档关闭时清理 */
const activeSessions = new Map<string, ConfigEditSession>();

// ─── schema + config 解析(表单 / JSON 文档两路共用) ────────

/** 解析结果:pluginId 为 undefined 表示插件未推送 */
export interface ResolvedConfig {
    pluginId: string | undefined;
    schema: ConfigSchema;
    config: Record<string, unknown>;
}

/**
 * 解析某插件配置的 schema 与当前值。两条路(表单 / JSON 文档)共用。
 *
 * schema 优先级:本地 `_conf_schema.json` > 服务器 schema > 空 schema。
 * config 来源:已推送(pluginId 能解析)→ 服务器 config;未推送 → 用 schema default 预填。
 *
 * @throws 网络/鉴权错误(调用方 try/catch 弹提示)
 */
export async function resolveSchemaAndConfig(
    client: AstrBotClient, workspace: PluginWorkspace,
): Promise<ResolvedConfig> {
    // 1. schema:本地优先
    const localSchema = getLocalConfigSchema(workspace.dir);
    let schema: ConfigSchema = localSchema ?? {};

    // 2. pluginId(按 name 在服务器插件列表里找)
    const pluginId = await resolvePluginId(client, workspace.name);

    // 3. 已推送:并行补 schema(本地没有时)与拉 config
    if (pluginId) {
        const [serverConfig, serverSchema] = await Promise.all([
            getPluginConfig(client, pluginId),
            localSchema ? Promise.resolve(undefined) : getPluginConfigSchema(client, pluginId),
        ]);
        if (!localSchema && serverSchema) {schema = serverSchema;}
        return { pluginId, schema, config: serverConfig };
    }

    // 4. 未推送:本地 schema(可能为空) + default 预填
    return { pluginId: undefined, schema, config: defaultConfigFromSchema(schema) };
}

/** 按 schema 各字段 default 生成一份初始 config(未推送时预填用) */
export function defaultConfigFromSchema(schema: ConfigSchema): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
        if (field.invisible) {continue;}
        out[key] = field.default !== undefined ? field.default : defaultValueForType(field);
    }
    return out;
}

function defaultValueForType(field: SchemaField): unknown {
    switch ((field.type ?? '').toLowerCase()) {
        case 'bool': return false;
        case 'int': case 'float': return 0;
        case 'list': case 'template_list': return [];
        case 'object': case 'dict':
            return field.items ? defaultConfigFromSchema(field.items as ConfigSchema) : {};
        default: return '';
    }
}

// ─── 打开配置(JSON 文档路径,表单的「编辑原始 JSON」回退到这里) ────

/**
 * 打开某插件的配置编辑文档(untitled,内容为服务器端当前配置)。
 * 流程:resolveSchemaAndConfig(schema 优先本地)→ 打开 untitled 文档。
 * 未推送插件也能打开(用本地 schema + default 预填),但保存时会拦截。
 */
export async function openPluginConfig(
    client: AstrBotClient, workspace: PluginWorkspace,
): Promise<void> {
    logger.separator(`打开配置:${workspace.name}`);
    let resolved: ResolvedConfig;
    try {
        resolved = await resolveSchemaAndConfig(client, workspace);
    } catch (e) {
        vscode.window.showErrorMessage(`拉取配置失败:${describeApiError(e)}`);
        return;
    }
    const { pluginId, schema, config } = resolved;

    const content = JSON.stringify(config, null, 4);
    const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content,
    });
    // untitled 文档没有文件名,用 scheme:untitled + path 作为 key
    const uriKey = doc.uri.toString();
    // pluginId 为空时存一个标记:保存时用此判断是否拦截
    activeSessions.set(uriKey, {
        workspace, pluginId: pluginId ?? '', schema, document: doc,
    });

    await vscode.window.showTextDocument(doc, { preview: false });
    if (!pluginId) {
        vscode.window.showWarningMessage(
            `${workspace.name} 尚未推送到服务器,当前为本地 schema 预填的默认配置。保存时会被拦截,请先 F5 推送。`,
        );
    } else {
        vscode.window.showInformationMessage(
            `${workspace.name} 配置已加载。编辑后通过命令面板执行「AstrBot: 推送插件配置到服务器」`,
        );
    }
    logger.log(`配置文档已打开(uri=${uriKey}, pluginId=${pluginId ?? '(未推送)'})`);
}

// ─── 推送配置 ────────────────────────────────────────────

/**
 * 从活动编辑器推送到服务器:校验 → PUT → 按 reloadAfterPush 处理。
 * 找不到会话时提示用户通过侧边栏打开。
 */
export async function pushPluginConfig(client: AstrBotClient, editor: vscode.TextEditor): Promise<void> {
    const uriKey = editor.document.uri.toString();
    const session = activeSessions.get(uriKey);
    if (!session) {
        vscode.window.showWarningMessage('当前文档不是插件配置,请通过侧边栏「当前插件配置」打开');
        return;
    }
    const { workspace, pluginId, schema } = session;

    // 0. 未推送拦截:pluginId 为空时不能保存
    if (!pluginId) {
        vscode.window.showWarningMessage(
            `${workspace.name} 尚未推送到服务器,无法保存配置。请先 F5 推送插件。`,
        );
        return;
    }

    // 1. 解析 JSON
    let value: unknown;
    try {
        value = JSON.parse(editor.document.getText());
    } catch (e) {
        vscode.window.showErrorMessage(`JSON 解析失败:${(e as Error).message}`);
        return;
    }

    // 2. 轻量校验
    const errors = validateConfigValue(schema, value);
    if (errors.length > 0) {
        const first = errors[0];
        vscode.window.showErrorMessage(
            `配置校验未通过(${errors.length} 处):${first.path} ${first.message}`,
        );
        // 尝试把光标定位到出错字段
        locateField(editor, first.path);
        logger.error(`配置校验失败,共 ${errors.length} 处:`);
        errors.forEach(er => logger.raw(`  - ${er.path}: ${er.message}`));
        logger.show();
        return;
    }

    // 3. PUT
    logger.separator(`推送配置:${workspace.name}`);
    logger.log(`PUT /api/v1/plugins/${pluginId}/config`);
    try {
        await savePluginConfig(client, pluginId, value as object);
    } catch (e) {
        vscode.window.showErrorMessage(`推送失败:${describeApiError(e)}`);
        return;
    }
    vscode.window.showInformationMessage(`✅ ${workspace.name} 配置已推送`);

    // 4. reloadAfterPush
    await askReloadAfterPush(client, pluginId, workspace.name);
}

/**
 * 按 debug.reloadAfterPush 策略询问/执行重载。
 * - never:直接返回
 * - always:静默重载
 * - ask:弹「重载/不重载」
 * 供 JSON 文档路径(pushPluginConfig)与 webview 表单路径(configForm)共用。
 */
export async function askReloadAfterPush(
    client: AstrBotClient, pluginId: string, pluginName: string,
): Promise<void> {
    const reloadPolicy = getConfig()?.debug.reloadAfterPush ?? 'ask';
    if (reloadPolicy === 'never') {return;}
    let shouldReload = false;
    if (reloadPolicy === 'always') {
        shouldReload = true;
    } else {
        const pick = await vscode.window.showInformationMessage(
            `${pluginName} 配置已推送,是否重载插件使配置生效?`,
            '重载', '不重载',
        );
        shouldReload = pick === '重载';
    }
    if (shouldReload) {
        try {
            await reloadPlugin(client, pluginId);
            vscode.window.showInformationMessage(`✅ ${pluginName} 已重载`);
        } catch (e) {
            vscode.window.showErrorMessage(`重载失败:${describeApiError(e)}`);
        }
    }
}

// ─── 轻量校验 ────────────────────────────────────────────

export interface ValidationError { path: string; message: string; }

/**
 * 按 AstrBot 自定义 schema 格式(非标准 JSON Schema)做轻量校验。
 * 检查项:type 匹配 JS 类型、options 枚举包含、嵌套 items 递归。
 * 规则见 design.md §4.3 / implementation.md §7.3。
 *
 * @param schema 服务器拉取的 ConfigSchema
 * @param value  用户编辑后的配置值
 * @returns 错误列表(空 = 通过)
 */
export function validateConfigValue(
    schema: ConfigSchema, value: unknown,
): ValidationError[] {
    const errors: ValidationError[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ path: '$', message: '配置必须是对象' });
        return errors;
    }
    validateObject(schema, value as Record<string, unknown>, '', errors);
    return errors;
}

function validateObject(
    schema: ConfigSchema,
    obj: Record<string, unknown>,
    base: string,
    errors: ValidationError[],
): void {
    for (const [key, field] of Object.entries(schema)) {
        // invisible 字段跳过校验(用户不该编辑)
        const path = base ? `${base}.${key}` : key;
        const present = key in obj;
        let v = obj[key];

        // 未提供时用 default(仅在校验阶段填充,不回写文档)
        if (!present || v === undefined || v === null) {
            if (field.default !== undefined) {
                v = field.default;
            } else {
                // 无默认值且未提供:跳过(不强制必填,AstrBot 自身会处理)
                continue;
            }
        }
        const fieldError = validateField(field, v, path);
        if (fieldError) {errors.push({ path, message: fieldError });}
        // 嵌套 object
        if (field.type === 'object' && field.items && v && typeof v === 'object' && !Array.isArray(v)) {
            validateObject(field.items, v as Record<string, unknown>, path, errors);
        }
    }
}

/** 校验单个字段;返回错误描述字符串,通过返回 undefined */
function validateField(field: SchemaField, value: unknown, path: string): string | undefined {
    const t = (field.type ?? '').toLowerCase();
    // 类型匹配
    if (t && !typeMatches(t, value)) {
        return `期望类型 ${field.type},实际为 ${jsTypeName(value)}`;
    }
    // 枚举
    if (field.options && Array.isArray(field.options) && field.options.length > 0) {
        if (!field.options.some(o => JSON.stringify(o) === JSON.stringify(value))) {
            return `值不在允许的选项中:${formatOptions(field.options)}`;
        }
    }
    void path;
    return undefined;
}

/** AstrBot type 与 JS 值的匹配规则(见 design.md §4.3 字段表) */
function typeMatches(type: string, value: unknown): boolean {
    switch (type) {
        case 'string': case 'text':
            return typeof value === 'string';
        case 'int':
            return typeof value === 'number' && Number.isInteger(value);
        case 'float':
            return typeof value === 'number';
        case 'bool':
            return typeof value === 'boolean';
        case 'object':
            return typeof value === 'object' && value !== null && !Array.isArray(value);
        case 'list': case 'template_list':
            return Array.isArray(value);
        case 'dict':
            return typeof value === 'object' && value !== null;
        case 'file':
            return typeof value === 'string';
        default:
            return true;   // 未知类型不强制校验(宽松)
    }
}

function jsTypeName(v: unknown): string {
    if (v === null) {return 'null';}
    if (Array.isArray(v)) {return 'array';}
    return typeof v;
}

function formatOptions(opts: unknown[]): string {
    return opts.slice(0, 10).map(o => JSON.stringify(o)).join(', ') +
        (opts.length > 10 ? ' …' : '');
}

/** 尝试把编辑器选中定位到某个字段路径(逐级 JSON key) */
function locateField(editor: vscode.TextEditor, path: string): void {
    try {
        const doc = editor.document;
        const keys = path.split('.');
        // 简化定位:在文档文本里按 key 顺序找最后一个 key 第一次出现的位置
        let text = doc.getText();
        let idx = -1;
        let consumed = 0;
        for (const k of keys) {
            const re = new RegExp(`"${escapeReg(k)}"\\s*:`);
            const m = re.exec(text);
            if (!m) {break;}
            idx = consumed + m.index;
            // 继续在剩余文本里找下一个 key(避免同名干扰)
            text = text.slice(m.index + m[0].length);
            consumed += m.index + m[0].length;
        }
        if (idx >= 0) {
            const pos = doc.positionAt(idx);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos.translate(0, keys[keys.length - 1].length + 2)));
        }
    } catch {
        // 定位失败不影响主流程
    }
}

function escapeReg(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── 清理 ────────────────────────────────────────────────

/** 文档关闭时移除会话(由 extension 注册 onDidCloseTextDocument 调用) */
export function forgetDocument(doc: vscode.TextDocument): void {
    activeSessions.delete(doc.uri.toString());
}
