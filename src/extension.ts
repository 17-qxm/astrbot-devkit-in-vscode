// src/extension.ts
// 扩展入口:激活/装配。共享状态收敛在 AppContext,命令由 commands/ 注册,
// 启动检查由 startup 负责。见 design.md §3 / implementation.md §10。

import * as vscode from 'vscode';
import * as logger from './logger.js';
import { watchConfig } from './config/index.js';
import { forgetDocument } from './views/configEditor.js';
import { AstrBotDebugAdapter } from './debug/adapter.js';
import { AppContext } from './context.js';
import { registerCommands } from './commands/registry.js';
import { runStartupChecks } from './startup.js';

/** 持有 app 引用,供 deactivate 释放 */
let app: AppContext | undefined;

export function activate(context: vscode.ExtensionContext) {
    logger.initLogger(context);
    logger.log('AstrBot DevKit 扩展已激活');

    app = new AppContext();

    // setContext 初始化
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);

    // 注册侧边栏视图
    vscode.window.registerTreeDataProvider('astrbot-devkit.main', app.tree);
    vscode.window.registerTreeDataProvider('astrbot-devkit.local', app.localTree);

    // 构建初始 client(若已有配置)
    app.rebuildClient();

    // 注册全部命令
    registerCommands(context, app);

    // 注册原生调试适配器(type: astrbot),与 extension 共享 client/relay
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('astrbot', {
            createDebugAdapterDescriptor() {
                return new vscode.DebugAdapterInlineImplementation(
                    new AstrBotDebugAdapter({
                        getClient: () => app!.client,
                        getRelay: () => app!.relay,
                    }),
                );
            },
        }),
    );

    // 原生调试会话启停 → 同步侧边栏/状态栏/上下文
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(s => {
            if (s.type !== 'astrbot') {return;}
            vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', true);
            app!.tree.setDebugging(true);
        }),
        vscode.debug.onDidTerminateDebugSession(s => {
            if (s.type !== 'astrbot') {return;}
            vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);
            app!.tree.setDebugging(false);
        }),
    );

    // 文档关闭时清理配置编辑会话
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => forgetDocument(doc)),
    );

    // 配置文件监听:仅连接相关字段(server/key)变化时重建 client;
    // 只改 debug/pluginWorkspaces 则刷新 UI,避免切换活跃插件时断连
    context.subscriptions.push(watchConfig(() => {
        app!.handleConfigChanged();
    }));

    // 同步初始上下文(活跃插件等)
    app.syncContext();

    // 启动检查:配置缺失则检索提示;已有配置则静默探活 + 校验
    void runStartupChecks(app);
}

export function deactivate() {
    app?.dispose();
    app = undefined;
}
