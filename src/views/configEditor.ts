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
import { getConfig } from '../config/index.js';
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

// ─── 打开配置 ────────────────────────────────────────────

/**
 * 打开某插件的配置编辑文档(untitled,内容为服务器端当前配置)。
 * 流程:按 name 匹配 pluginId → 并行拉 config + schema → 打开 untitled 文档。
 */
export async function openPluginConfig(
    client: AstrBotClient, workspace: PluginWorkspace,
): Promise<void> {
    logger.separator(`打开配置:${workspace.name}`);
    logger.log(`匹配 pluginId…`);
    const pluginId = await resolvePluginId(client, workspace.name);
    if (!pluginId) {
        vscode.window.showErrorMessage(
            `服务器上未找到插件「${workspace.name}」,请先推送(F5)后再编辑配置`,
        );
        return;
    }
    logger.log(`pluginId = ${pluginId}`);

    logger.log(`拉取 config + schema…`);
    let config: Record<string, unknown>;
    let schema: ConfigSchema;
    try {
        [config, schema] = await Promise.all([
            getPluginConfig(client, pluginId),
            getPluginConfigSchema(client, pluginId),
        ]);
    } catch (e) {
        vscode.window.showErrorMessage(`拉取配置失败:${describeApiError(e)}`);
        return;
    }

    const content = JSON.stringify(config, null, 4);
    const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content,
    });
    // untitled 文档没有文件名,用 scheme:untitled + path 作为 key
    const uriKey = doc.uri.toString();
    activeSessions.set(uriKey, { workspace, pluginId, schema, document: doc });

    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(
        `${workspace.name} 配置已从服务器加载。编辑后通过命令面板执行「AstrBot: 推送插件配置到服务器」`,
    );
    logger.log(`配置文档已打开(uri=${uriKey})`);
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
