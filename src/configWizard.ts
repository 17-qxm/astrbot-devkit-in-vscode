// src/configWizard.ts
// 交互式配置向导:输入 server + API key → 探活验证 → 保存。
// 由「创建配置」命令、启动检索提示、InitEnv 收尾共用,保证各入口行为一致。

import * as vscode from 'vscode';
import { CONFIG_VERSION } from './constants.js';
import {
    getConfig,
    saveConfig,
    DEFAULT_DEBUG,
    type DevKitConfig,
} from './config.js';
import { createClient, describeApiError } from './api/client.js';

/** 服务器地址宽松校验(与 schema / EditServerAddress 一致) */
const SERVER_PATTERN = /^https?:\/\/|^[a-zA-Z0-9.\-]+(:[0-9]+)?/;

/**
 * 创建/补全配置向导:输入 server → API key → 探活验证 → 保存。
 *
 * 已有配置时原地更新(保留 pluginWorkspaces / debug / autoConnect),否则新建模板。
 * 用户在任一步取消返回 false;保存成功返回 true。
 *
 * @param onSaved 保存成功后的回调(如刷新侧边栏),可省略
 */
export async function runConfigWizard(onSaved?: () => void): Promise<boolean> {
    const current = getConfig();

    // 1. server 地址
    const addr = await vscode.window.showInputBox({
        prompt: 'AstrBot 服务器地址(host:port 或 http(s)://…)',
        placeHolder: '127.0.0.1:6185',
        value: current?.astrbotServer ?? '127.0.0.1:6185',
        ignoreFocusOut: true,
        validateInput: v => {
            const s = v.trim();
            if (!s) {return '不能为空';}
            if (!SERVER_PATTERN.test(s)) {
                return '格式不正确,支持 host:port 或 http(s)://…';
            }
            return undefined;
        },
    });
    if (!addr) {return false;}

    // 2. API key
    const key = await vscode.window.showInputBox({
        prompt: 'AstrBot API Key(在 WebUI 设置中创建)',
        placeHolder: 'abk_xxxxxxxx',
        password: true,
        ignoreFocusOut: true,
        validateInput: v => v.trim() ? undefined : '不能为空',
    });
    if (!key) {return false;}

    const server = addr.trim();
    const apiKey = key.trim();

    // 3. 立即探活验证(失败时用户可选"仍然保存")
    const tmpConfig: DevKitConfig = {
        // 已有配置则原地更新字段,保留 pluginWorkspaces/debug/autoConnect;
        // 没有配置则用模板新建
        ...(current ?? {
            version: CONFIG_VERSION,
            astrbotServer: server,
            astrbotAPIkey: apiKey,
            debug: { ...DEFAULT_DEBUG },
            pluginWorkspaces: [],
        }),
        astrbotServer: server,
        astrbotAPIkey: apiKey,
    };
    const probe = createClient(tmpConfig);
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '验证服务器连接…' },
            () => probe.connect(),
        );
        vscode.window.showInformationMessage('✅ 连接成功');
    } catch (e) {
        const choice = await vscode.window.showErrorMessage(
            `连接失败:${describeApiError(e)}`, '仍然保存',
        );
        if (choice !== '仍然保存') {return false;}
    }

    // 4. 保存(已有配置原地更新,否则写入新模板)
    const existing = getConfig();
    if (existing) {
        existing.astrbotServer = server;
        existing.astrbotAPIkey = apiKey;
        await saveConfig(existing);
    } else {
        await saveConfig(tmpConfig);
    }
    onSaved?.();
    return true;
}
