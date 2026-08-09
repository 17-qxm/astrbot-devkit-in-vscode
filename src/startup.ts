// src/startup.ts
// 启动检查:配置缺失时触发插件检索提示;已有配置则静默探活 + 校验。
// 由原 activate 尾部逻辑收敛而来,行为不变。

import * as vscode from 'vscode';
import * as logger from './logger.js';
import {
    getConfig, ensureConfigFile, scanWorkspaceForPlugins, validateConfig,
} from './config/index.js';
import { runConfigWizard } from './configWizard.js';
import type { AppContext } from './context.js';
import { addWorkspaces } from './commands/pluginCommands.js';

/**
 * 启动检查(激活时调用):
 *  - 配置缺失 → 触发插件检索(design.md §3.2)
 *  - 已有配置 → 静默探活(autoConnect 默认开)+ 校验(有错只提示)
 */
export async function runStartupChecks(app: AppContext): Promise<void> {
    const initial = getConfig();
    if (!initial) {
        await maybeCreateFromScan(app);
        return;
    }
    // 静默探活(design.md §3.3):autoConnect 关闭时不自动连接;不 await、失败静默
    if (app.client && initial.autoConnect !== false) {
        app.client.connect().then(() => app.syncContext(), () => {});
    }
    // 校验配置(有错误只提示,不阻塞)
    const errs = validateConfig(initial);
    if (errs.length > 0) {
        logger.error(`配置校验:${errs.length} 项问题`);
        errs.forEach(e => logger.raw('  - ' + e));
    }
}

/** 启动检索提示(design.md §3.2) */
async function maybeCreateFromScan(app: AppContext): Promise<void> {
    const cands = scanWorkspaceForPlugins();
    if (cands.length === 0) {
        logger.log('未检测到 AstrBot 插件,等待用户手动创建配置');
        return;
    }
    const pick = await vscode.window.showInformationMessage(
        `检测到 ${cands.length} 个 AstrBot 插件:${cands.map(c => c.name).join('、')}。要加入配置吗?`,
        '添加并创建配置', '忽略',
    );
    if (pick === '添加并创建配置') {
        await ensureConfigFile();
        await addWorkspaces(app, cands);
        // 创建后引导补充服务器信息
        void runConfigWizard(() => app.syncContext());
    }
}
