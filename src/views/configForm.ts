// src/views/configForm.ts
// 插件配置的 Webview 表单编辑器:host 端。
// 拉 config + schema → 开 webview panel → postMessage 收发 → 校验 + 保存 + 询问 reload。
// 校验复用 configEditor.ts 的 validateConfigValue;保存复用 savePluginConfig。
// 表单 HTML 由 configFormHtml.ts 生成,主题跟随 VS Code(--vscode-* 变量)。

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AstrBotClient } from '../api/client.js';
import { describeApiError } from '../api/client.js';
import {
    getPluginConfig, getPluginConfigSchema, savePluginConfig, resolvePluginId,
    type ConfigSchema,
} from '../api/plugins.js';
import type { PluginWorkspace } from '../config/index.js';
import * as logger from '../logger.js';
import { configFormHtml } from './configFormHtml.js';
import { validateConfigValue, askReloadAfterPush, openPluginConfig } from './configEditor.js';

/**
 * 打开某插件的配置表单(webview)。默认入口,失败时回退提示。
 * 流程:resolvePluginId → 并行拉 config + schema → 开 panel → 收消息保存。
 */
export async function openPluginConfigForm(
    client: AstrBotClient, workspace: PluginWorkspace,
): Promise<void> {
    logger.separator(`打开配置表单:${workspace.name}`);
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
        pluginId,
        config,
        schema,
        nonce,
        cspSource: panel.webview.cspSource,
    });

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
    pluginId: string,
    pluginName: string,
    schema: ConfigSchema,
    value: unknown,
): Promise<void> {
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
