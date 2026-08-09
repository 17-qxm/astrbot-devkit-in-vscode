// src/debug/logleak.ts
// 日志投射插件(logleak)检测与自动安装。

import * as vscode from 'vscode';
import type { AstrBotClient } from '../api/client.js';
import { describeApiError } from '../api/client.js';
import { listPlugins, installPluginFromGithub } from '../api/plugins.js';
import { LOGLEAK_PLUGIN_ID, LOGLEAK_PLUGIN_REPO } from '../constants.js';
import * as logger from '../logger.js';
import type { ConsoleWriter } from './protocol.js';

/** 检测日志投射插件是否就绪;缺失时引导从 GitHub 安装。返回是否可用 */
export async function ensureLogleakPlugin(
    client: AstrBotClient,
    write: ConsoleWriter,
): Promise<boolean> {
    try {
        const plugins = await listPlugins(client, { includeReserved: true });
        const plugin = plugins.find(p =>
            p.name === LOGLEAK_PLUGIN_ID || p.id === LOGLEAK_PLUGIN_ID,
        );
        // 已安装且启用(字段以实际响应为准:enabled / activated)
        if (plugin && plugin.enabled !== false && plugin.activated !== false) {
            return true;
        }
        if (plugin && (plugin.enabled === false || plugin.activated === false)) {
            write('console', '⚠️ 日志投射插件已禁用,请在 AstrBot WebUI 启用\n');
            return false;
        }
        // 未安装:通知用户,从 GitHub 一键安装
        const pick = await vscode.window.showInformationMessage(
            '未检测到日志投射插件 astrbot_plugin_devkit_for_vscode_logleak。\n' +
            '点击「从 GitHub 安装」将自动安装:' +
            'https://github.com/17-qxm/astrbot_plugin_devkit_for_vscode_logleak',
            '从 GitHub 安装', '继续',
        );
        if (pick !== '从 GitHub 安装') {
            write('console', '⚠️ 未安装日志投射插件,日志暂不可用\n');
            return false;
        }
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在从 GitHub 安装日志投射插件…',
                },
                () => installPluginFromGithub(client, LOGLEAK_PLUGIN_REPO),
            );
            write('console', '✅ 已从 GitHub 安装日志投射插件\n');
            // 等待服务器加载插件(最多约 5s);已启用则本会话直接连日志
            for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 1000));
                try {
                    const list = await listPlugins(client, { includeReserved: true });
                    const p = list.find(x =>
                        x.name === LOGLEAK_PLUGIN_ID || x.id === LOGLEAK_PLUGIN_ID,
                    );
                    if (p && p.enabled !== false && p.activated !== false) {
                        write('console', '✅ 日志投射插件已就绪\n');
                        return true;
                    }
                } catch {}
            }
            vscode.window.showInformationMessage(
                '日志投射插件已安装,若未启用请在 AstrBot WebUI 确认,然后重新调试',
            );
            return false;
        } catch (e) {
            const msg = describeApiError(e);
            write('stderr', `日志插件安装失败:${msg}\n`);
            // 自动安装失败 → 引导用户用 GitHub 链接手动安装
            const repoUrl = `https://github.com/${LOGLEAK_PLUGIN_REPO}`;
            vscode.window.showErrorMessage(
                `日志投射插件自动安装失败:${msg}\n可打开 GitHub 手动安装:${repoUrl}`,
                '打开 GitHub',
            ).then(action => {
                if (action === '打开 GitHub') {
                    void vscode.env.openExternal(vscode.Uri.parse(repoUrl));
                }
            });
            return false;
        }
    } catch (e) {
        logger.error(`检测日志插件时出错:${describeApiError(e)}`);
        return false;
    }
}
