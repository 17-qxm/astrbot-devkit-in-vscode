// src/views/configForm.ts
// 插件配置的 Webview 表单编辑器:host 端。
// schema 优先读本地 _conf_schema.json(未推送也能编辑);config 已推送→服务器,未推送→default 预填。
// 校验复用 configEditor.ts 的 validateConfigValue;保存复用 savePluginConfig。
// 表单 HTML 由 configFormHtml.ts 生成,主题跟随 VS Code(--vscode-* 变量)。

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AstrBotClient } from '../api/client.js';
import { describeApiError } from '../api/client.js';
import { savePluginConfig, type ConfigSchema } from '../api/plugins.js';
import type { PluginWorkspace } from '../config/index.js';
import * as logger from '../logger.js';
import { configFormHtml } from './configFormHtml.js';
import {
    validateConfigValue, askReloadAfterPush, openPluginConfig, resolveSchemaAndConfig,
} from './configEditor.js';

/**
 * 打开某插件的配置表单(webview)。默认入口,失败时回退提示。
 * 流程:resolveSchemaAndConfig(schema 优先本地,未推送用 default 预填)→ 开 panel → 收消息保存。
 * 未推送插件也能打开编辑,但保存时会被拦截(提示先 F5 推送)。
 */
export async function openPluginConfigForm(
    client: AstrBotClient, workspace: PluginWorkspace,
): Promise<void> {
    logger.separator(`打开配置表单:${workspace.name}`);
    let resolved;
    try {
        resolved = await resolveSchemaAndConfig(client, workspace);
    } catch (e) {
        vscode.window.showErrorMessage(`拉取配置失败:${describeApiError(e)}`);
        return;
    }
    const { pluginId, schema, config } = resolved;
    logger.log(`pluginId = ${pluginId ?? '(未推送,使用本地 schema + default 预填)'}`);

    const nonce = crypto.randomBytes(16).toString('base64');
    const panel = vscode.window.createWebviewPanel(
        'astrbotConfigForm',
        `插件配置 · ${workspace.name}`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        },
    );

    panel.webview.html = configFormHtml({
        pluginName: workspace.name,
        pluginId: pluginId ?? '',
        config,
        schema,
        nonce,
        cspSource: panel.webview.cspSource,
    });

    // 未推送:在表单顶部提示
    if (!pluginId) {
        void panel.webview.postMessage({
            type: 'info',
            message: `${workspace.name} 尚未推送到服务器,当前为本地 schema 预填的默认配置。保存时会被拦截,请先 F5 推送。`,
        });
    }

    let disposed = false;
    panel.onDidDispose(() => { disposed = true; });

    // 收 webview 消息
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        if (disposed || !msg || typeof msg !== 'object') {return;}
        const m = msg as { type?: string; value?: unknown };
        if (m.type === 'editRawJson') {
            // 用户要切到 JSON 文档:关表单 + 开 untitled JSON(复用老路径)
            panel.dispose();
            await openPluginConfig(client, workspace);
            return;
        }
        if (m.type === 'save') {
            await onSave(panel, client, pluginId, workspace.name, schema, m.value);
        }
    });
}

/** 校验 → 保存 → 询问 reload;结果回传 webview */
async function onSave(
    panel: vscode.WebviewPanel,
    client: AstrBotClient,
    pluginId: string | undefined,
    pluginName: string,
    schema: ConfigSchema,
    value: unknown,
): Promise<void> {
    // 0. 未推送拦截
    if (!pluginId) {
        void panel.webview.postMessage({
            type: 'error',
            message: `${pluginName} 尚未推送到服务器,无法保存。请先 F5 推送插件。`,
        });
        return;
    }

    // 1. 轻量校验(复用 configEditor 的规则)
    const errors = validateConfigValue(schema, value);
    if (errors.length > 0) {
        void panel.webview.postMessage({ type: 'errors', errors });
        logger.error(`配置校验失败,共 ${errors.length} 处:`);
        errors.forEach(er => logger.raw(`  - ${er.path}: ${er.message}`));
        return;
    }

    // 2. PUT
    logger.separator(`推送配置:${pluginName}`);
    logger.log(`PUT /api/v1/plugins/${pluginId}/config`);
    try {
        await savePluginConfig(client, pluginId, value as object);
    } catch (e) {
        const msg = describeApiError(e);
        void panel.webview.postMessage({ type: 'error', message: `保存失败:${msg}` });
        vscode.window.showErrorMessage(`保存失败:${msg}`);
        return;
    }
    void panel.webview.postMessage({ type: 'saved' });
    vscode.window.showInformationMessage(`✅ ${pluginName} 配置已保存`);

    // 3. reloadAfterPush(复用共享逻辑)
    await askReloadAfterPush(client, pluginId, pluginName);
}
