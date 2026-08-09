// src/initenv/workspaceCheck.ts
// 工作区检查:扫描插件 → 注册 → 引导配置服务器连接。

import * as vscode from 'vscode';
import * as logger from '../logger.js';
import {
    addPluginCandidates,
    ensureConfigFile,
    getConfig,
    scanWorkspaceForPlugins,
} from '../config/index.js';
import { runConfigWizard } from '../configWizard.js';

/**
 * 检查工作区,有以下几个部分
 * 1. 检查 `.vscode/astrbot-devkit-config.json`
 *     - 配置缺失时扫描工作区,发现插件则引导创建配置并注册
 *     - 配置存在时把扫描到的插件合并进 pluginWorkspaces
 * 2. 注册后若未配置服务器连接,引导填写 server + API key
 */
export async function WorkspaceCheck() {
    logger.separator('WorkspaceCheck');
    logger.log('扫描工作区中的 AstrBot 插件…');
    const cands = scanWorkspaceForPlugins();
    if (cands.length === 0) {
        logger.log('未检测到 AstrBot 插件(判定标准:目录含 metadata.yaml 且 name+version 可解析)');
        vscode.window.showInformationMessage('未检测到 AstrBot 插件');
        return;
    }

    const names = cands.map(c => c.name).join('、');
    logger.log(`检测到 ${cands.length} 个插件:${names}`);

    // 配置缺失:先引导创建,再加入(与启动时的自动检索提示行为一致)
    if (!getConfig()) {
        const pick = await vscode.window.showInformationMessage(
            `检测到 ${cands.length} 个 AstrBot 插件:${names}。要创建配置并加入吗?`,
            '创建并加入', '忽略',
        );
        if (pick !== '创建并加入') {
            logger.log('用户选择忽略(可在侧边栏「创建配置文件」或再次运行本命令)');
            return;
        }
        await ensureConfigFile();
        if (!getConfig()) {
            logger.error('配置文件创建失败');
            vscode.window.showErrorMessage('配置文件创建失败');
            return;
        }
    }

    const added = await addPluginCandidates(cands);
    if (added > 0) {
        logger.log(`✅ 已新增 ${added} 个插件工作区`);
        vscode.window.showInformationMessage(`已新增 ${added} 个插件工作区`);
    } else {
        logger.log('插件均已注册,无需新增');
        vscode.window.showInformationMessage('插件均已注册,无需新增');
    }

    // 已注册插件但尚未配置服务器连接 → 引导填写(与启动检索一致)
    if (!getConfig()?.astrbotAPIkey) {
        await runConfigWizard();
    }
}
