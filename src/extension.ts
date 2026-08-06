// src/extension.ts
// 扩展入口:激活流程、命令注册、视图/客户端/日志/调试的状态编排。
// 激活全部静默、零打扰;所有初始化结果只反映在侧边栏状态上。见 design.md §3 / implementation.md §10。

import * as vscode from 'vscode';
import * as AstrBotMain from './main.js';
import { initLogger, log, show } from './logger.js';
import * as logger from './logger.js';
import {
    getConfig, ensureConfigFile, saveConfig, validateConfig,
    setActiveWorkspace as persistActiveWorkspace,
    getActiveWorkspace, watchConfig, generateKey,
    scanWorkspaceForPlugins, isPluginRoot, getConfigFilePath,
    toRelativePosix, getWorkspaceRoot,
    type PluginWorkspace, type DevKitConfig,
} from './config.js';
import {
    createClient, describeApiError, type AstrBotClient, type ConnectionState,
} from './api/client.js';
import * as pluginsApi from './api/plugins.js';
import * as imApi from './api/im.js';
import { DevkitTreeProvider, type DevkitNode } from './views/devkitTree.js';
import {
    openPluginConfig, pushPluginConfig, forgetDocument,
} from './views/configEditor.js';
import { LogRelay } from './logs/relay.js';
import { DebugSession } from './debug/debugSession.js';
import { OUTPUT_CHANNEL_SERVER } from './constants.js';

// ─── 模块级状态(单例) ───────────────────────────────────

let tree: DevkitTreeProvider;
let client: AstrBotClient | undefined;
let relay: LogRelay | undefined;
let debugSession: DebugSession | undefined;

/** 同步 astrbotDevkit.active / activePlugin 上下文 key */
function syncContext(): void {
    const config = getConfig();
    const active = getActiveWorkspace(config);
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.active', !!active);
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.activePlugin', active?.name ?? '');
    tree.refresh();
}

/** 重建 client(配置变化时调用) */
function rebuildClient(): void {
    const config = getConfig();
    relay?.dispose();
    relay = undefined;
    debugSession = undefined;
    if (!config) {
        client = undefined;
        tree.setConnectionState('unconfigured', '');
        return;
    }
    client = createClient(config, state => {
        tree.setConnectionState(state, config.astrbotServer);
    });
    relay = new LogRelay(client);
    debugSession = new DebugSession(client, relay);
    debugSession.onStateChange((state) => {
        tree.setDebugging(state === 'streaming');
    });
    // 初始状态:已配置但未连接
    tree.setConnectionState('unconfigured', config.astrbotServer);
}

// ─── 激活 ────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    initLogger(context);
    log('AstrBot DevKit 扩展已激活');

    tree = new DevkitTreeProvider();

    // setContext 初始化
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);

    // 注册侧边栏视图
    vscode.window.registerTreeDataProvider('astrbot-devkit.main', tree);

    // 构建初始 client(若已有配置)
    rebuildClient();

    // 注册全部命令
    registerCommands(context);

    // 文档关闭时清理配置编辑会话
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => forgetDocument(doc)),
    );

    // 配置文件监听:变更后重建 client + 同步上下文 + 刷新
    context.subscriptions.push(watchConfig(() => {
        rebuildClient();
        syncContext();
    }));

    // 同步初始上下文(活跃插件等)
    syncContext();

    // 配置缺失 → 触发插件检索(design.md §3.2)
    const initial = getConfig();
    if (!initial) {
        void maybeCreateFromScan();
    } else {
        // 静默探活(design.md §3.3):不 await、失败静默
        if (client) {
            client.connect().then(() => syncContext(), () => {});
        }
        // 校验配置(有错误只提示,不阻塞)
        const errs = validateConfig(initial);
        if (errs.length > 0) {
            logger.error(`配置校验:${errs.length} 项问题`);
            errs.forEach(e => logger.raw('  - ' + e));
        }
    }

    // 保留现有命令的注册(main.ts 的 WorkspaceCheck 在 activate 末尾被旧代码调用,
    // 当前 main.ts 中 WorkspaceCheck 为空实现;此处仍调用以兼容旧行为)
    AstrBotMain.WorkspaceCheck();
}

export function deactivate() {
    relay?.dispose();
}

// ─── 命令注册 ────────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, handler: (...args: unknown[]) => unknown) => {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    };

    // ── 视图刷新 ──
    reg('astrbot-devkit.Refresh', async () => {
        rebuildClient();
        syncContext();
        if (client && client.state !== 'connected') {
            try { await client.connect(); } catch {}
        }
        syncContext();
    });

    // ── 创建配置(向导) ──
    reg('astrbot-devkit.CreateConfig', () => createConfigWizard());

    // ── 打开配置文件 ──
    reg('astrbot-devkit.OpenConfig', async () => {
        const file = getConfigFilePath();
        if (!file) {
            vscode.window.showWarningMessage('未打开工作区');
            return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc);
    });

    // ── 修改服务器地址 ──
    reg('astrbot-devkit.EditServerAddress', async () => {
        const config = getConfig();
        const addr = await vscode.window.showInputBox({
            prompt: 'AstrBot 服务器地址(host:port 或 http(s)://…)',
            value: config?.astrbotServer ?? '127.0.0.1:6185',
            validateInput: v => /^https?:\/\/|^[a-zA-Z0-9.\-]+(:[0-9]+)?/.test(v.trim())
                ? undefined : '格式不正确,支持 host:port 或 http(s)://…',
        });
        if (!addr) {return;}
        const cur = getConfig();
        if (cur) {
            cur.astrbotServer = addr.trim();
            await saveConfig(cur);
            syncContext();
        }
    });

    // ── 连接服务器 ──
    reg('astrbot-devkit.Connect', async () => {
        if (!ensureClient()) {return;}
        try {
            await client!.connect();
            syncContext();
            vscode.window.showInformationMessage('✅ 已连接到 AstrBot 服务器');
        } catch (e) {
            vscode.window.showErrorMessage(`连接失败:${describeApiError(e)}`);
        }
    });

    // ── 添加插件工作区 ──
    reg('astrbot-devkit.AddWorkspace', async () => {
        const root = getWorkspaceRoot();
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: root ? vscode.Uri.file(root) : undefined,
            openLabel: '选择插件根目录(含 metadata.yaml)',
        });
        if (!folders || folders.length === 0) {return;}
        const candidate = isPluginRoot(folders[0].fsPath);
        if (!candidate) {
            vscode.window.showErrorMessage('所选目录不是插件根(缺少 metadata.yaml 或 name/version 字段)');
            return;
        }
        await addWorkspaces([candidate]);
    });

    // ── 扫描插件 ──
    reg('astrbot-devkit.ScanPlugins', async () => {
        const cands = scanWorkspaceForPlugins();
        if (cands.length === 0) {
            vscode.window.showInformationMessage('未在工作区中检测到 AstrBot 插件(需含 metadata.yaml 且有 name+version)');
            return;
        }
        const config = getConfig();
        const existing = new Set((config?.pluginWorkspaces ?? []).map(w => w.name));
        const picks = await vscode.window.showQuickPick(
            cands.map(c => ({
                label: c.name,
                description: c.version,
                detail: c.dir,
                picked: existing.has(c.name),
                candidate: c,
            })),
            { canPickMany: true, title: `检测到 ${cands.length} 个插件,选择要加入配置的`, placeHolder: '勾选要加入/保留的插件' },
        );
        if (!picks) {return;}
        await addWorkspaces(picks.map(p => p.candidate));
    });

    // ── 设置活跃插件 ──
    reg('astrbot-devkit.SetActivePlugin', async (arg: unknown) => {
        const ws = workspaceFromArg(arg);
        if (!ws) {return;}
        await persistActiveWorkspace(ws.name);
        syncContext();
    });

    // ── Debug(F5) ──
    reg('astrbot-devkit.Debug', async (arg?: unknown) => {
        if (!ensureClient() || !debugSession) {return;}
        let ws = workspaceFromArg(arg);
        if (!ws) {
            ws = getActiveWorkspace(getConfig());
        }
        await debugSession.start(ws);
    });

    // ── 停止 Debug(Shift+F5) ──
    reg('astrbot-devkit.StopDebug', async () => {
        await debugSession?.stop();
    });

    // ── 打开插件配置 ──
    reg('astrbot-devkit.OpenPluginConfig', async (arg: unknown) => {
        if (!ensureClient()) {return;}
        const ws = workspaceFromArg(arg) ?? getActiveWorkspace(getConfig());
        if (!ws) {
            vscode.window.showWarningMessage('请先选择一个插件工作区');
            return;
        }
        await openPluginConfig(client!, ws);
    });

    // ── 推送插件配置 ──
    reg('astrbot-devkit.SavePluginConfig', async () => {
        if (!ensureClient()) {return;}
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('没有活动编辑器');
            return;
        }
        await pushPluginConfig(client!, editor);
    });

    // ── 打开服务器日志通道 ──
    reg('astrbot-devkit.OpenServerLogs', async () => {
        // 确保 channel 存在(即使未 debug 也可查看历史/手动连接提示)
        if (!relay) {
            const config = getConfig();
            if (config) {
                client = createClient(config, s => tree.setConnectionState(s, config.astrbotServer));
                relay = new LogRelay(client);
            } else {
                const ch = vscode.window.createOutputChannel(OUTPUT_CHANNEL_SERVER);
                ch.appendLine('尚未配置 AstrBot 服务器');
                ch.show(true);
                return;
            }
        }
        relay.outputChannel.show(true);
    });

    // ── 推送消息(im,阶段 5) ──
    reg('astrbot-devkit.SendMessage', async () => {
        if (!ensureClient()) {return;}
        try {
            const bots = await imApi.listBots(client!);
            if (bots.length === 0) {
                vscode.window.showWarningMessage('服务器上没有可用的 IM 平台/UMO');
                return;
            }
            const umo = await vscode.window.showQuickPick(
                bots.map(b => ({ label: b.id, description: String(b.name ?? b.id), bot: b })),
                { title: '选择目标平台/UMO', placeHolder: 'umo ID' },
            );
            if (!umo) {return;}
            const text = await vscode.window.showInputBox({
                prompt: '输入要推送的文本消息',
                placeHolder: 'Hello',
            });
            if (!text) {return;}
            await imApi.sendMessage(client!, umo.bot.id, text);
            vscode.window.showInformationMessage(`✅ 已发送到 ${umo.bot.id}`);
        } catch (e) {
            vscode.window.showErrorMessage(`发送失败:${describeApiError(e)}`);
        }
    });

    // ── 列出服务器插件(辅助命令,便于排查) ──
    reg('astrbot-devkit.ListServerPlugins', async () => {
        if (!ensureClient()) {return;}
        try {
            const list = await pluginsApi.listPlugins(client!, { includeReserved: true });
            const ch = vscode.window.createOutputChannel(OUTPUT_CHANNEL_SERVER);
            ch.clear();
            ch.appendLine(`服务器插件共 ${list.length} 个:`);
            for (const p of list) {
                ch.appendLine(`  ${p.name} (id=${p.id}, v${p.version ?? '?'}, enabled=${p.enabled})`);
            }
            ch.show(true);
        } catch (e) {
            vscode.window.showErrorMessage(`获取插件列表失败:${describeApiError(e)}`);
        }
    });
}

// ─── 辅助:从命令参数取 workspace ─────────────────────────

function workspaceFromArg(arg: unknown): PluginWorkspace | undefined {
    // 侧边栏点击时传 DevkitNode 或 PluginWorkspace
    if (!arg) {return undefined;}
    if (typeof arg === 'object') {
        if ('workspace' in (arg as object)) {
            return (arg as { workspace: PluginWorkspace }).workspace;
        }
        if ('name' in (arg as object) && 'dir' in (arg as object)) {
            return arg as PluginWorkspace;
        }
    }
    return undefined;
}

/** 确保 client 就绪;未配置时引导创建 */
function ensureClient(): boolean {
    if (client) {return true;}
    const config = getConfig();
    if (!config) {
        vscode.window.showErrorMessage('尚未配置 AstrBot 服务器', '创建配置')
            .then(p => { if (p === '创建配置') { vscode.commands.executeCommand('astrbot-devkit.CreateConfig'); } });
        return false;
    }
    rebuildClient();
    return !!client;
}

/** 把候选插件加入 pluginWorkspaces(去重),并尝试标记第一个为活跃 */
async function addWorkspaces(cands: { dir: string; name: string; version: string }[]): Promise<void> {
    const config = getConfig();
    if (!config) {
        // 配置不存在:先创建模板,再加入
        await ensureConfigFile();
    }
    const cur = getConfig();
    if (!cur) {return;}
    cur.pluginWorkspaces = cur.pluginWorkspaces ?? [];
    const existing = new Map(cur.pluginWorkspaces.map(w => [w.name, w]));
    let added = 0;
    for (const c of cands) {
        const rel = toRelativePosix(c.dir) ?? c.dir;
        const ex = existing.get(c.name);
        if (ex) {
            // 更新 version/dir
            ex.version = c.version;
            ex.dir = rel;
        } else {
            cur.pluginWorkspaces.push({ dir: rel, name: c.name, version: c.version, active: false });
            added++;
        }
    }
    // 没有活跃插件时,标记第一个为活跃
    if (!cur.pluginWorkspaces.some(w => w.active)) {
        cur.pluginWorkspaces[0].active = true;
    }
    await saveConfig(cur);
    syncContext();
    if (added > 0) {
        vscode.window.showInformationMessage(`已加入 ${added} 个插件工作区`);
    }
}

// ─── 启动检索提示(design.md §3.2) ──────────────────────

async function maybeCreateFromScan(): Promise<void> {
    const cands = scanWorkspaceForPlugins();
    if (cands.length === 0) {
        log('未检测到 AstrBot 插件,等待用户手动创建配置');
        return;
    }
    const pick = await vscode.window.showInformationMessage(
        `检测到 ${cands.length} 个 AstrBot 插件:${cands.map(c => c.name).join('、')}。要加入配置吗?`,
        '添加并创建配置', '忽略',
    );
    if (pick === '添加并创建配置') {
        await ensureConfigFile();
        await addWorkspaces(cands);
        // 创建后引导补充服务器信息
        void createConfigWizard(true);
    }
}

// ─── 创建配置向导 ────────────────────────────────────────

/**
 * 创建/补全配置向导。
 * @param onlyServer true=配置已存在,只补服务器信息(用于 maybeCreateFromScan 后续)
 */
async function createConfigWizard(onlyServer = false): Promise<void> {
    // server
    const addr = await vscode.window.showInputBox({
        prompt: 'AstrBot 服务器地址',
        placeHolder: '127.0.0.1:6185',
        value: getConfig()?.astrbotServer ?? '127.0.0.1:6185',
        ignoreFocusOut: true,
        validateInput: v => v.trim() ? undefined : '不能为空',
    });
    if (!addr) {return;}

    // API key(立即探活验证)
    const key = await vscode.window.showInputBox({
        prompt: 'AstrBot API Key(abk_ 开头,在 WebUI 设置中创建)',
        placeHolder: 'abk_xxxxxxxx',
        password: true,
        ignoreFocusOut: true,
        validateInput: v => v.trim() ? undefined : '不能为空',
    });
    if (!key) {return;}

    // 立即探活
    const tmpConfig: DevKitConfig = {
        version: 2,
        astrbotServer: addr.trim(),
        astrbotAPIkey: key.trim(),
        logleakKey: '',
        debug: { stopAction: 'ask', reloadAfterPush: 'ask', ruffFix: false, reconnectLimit: 5 },
        pluginWorkspaces: getConfig()?.pluginWorkspaces ?? [],
    };
    const probe = createClient(tmpConfig);
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '验证服务器连接…' },
        async () => {
            try {
                await probe.connect();
            } catch (e) {
                throw new Error(describeApiError(e));
            }
        },
    ).then(
        () => vscode.window.showInformationMessage('✅ 连接成功'),
        (e: unknown) => {
            vscode.window.showErrorMessage(`连接失败:${(e as Error).message}`, '仍然保存');
            return '仍然保存' as const;
        },
    ).then(saveChoice => {
        if (saveChoice === undefined) {
            // 用户关掉错误通知 → 视为放弃
            return false;
        }
        return true;
    }).then(shouldSave => {
        if (!shouldSave) {return;}
        void (async () => {
            tmpConfig.logleakKey = getConfig()?.logleakKey || generateKey();
            if (!onlyServer && !getConfigFilePath()) {return;}
            // 合并已有 pluginWorkspaces
            const existing = getConfig();
            if (existing) {
                existing.astrbotServer = tmpConfig.astrbotServer;
                existing.astrbotAPIkey = tmpConfig.astrbotAPIkey;
                existing.logleakKey = tmpConfig.logleakKey;
                await saveConfig(existing);
            } else {
                await saveConfig(tmpConfig);
            }
            syncContext();
            show();
            vscode.window.showInformationMessage('✅ 配置已保存');
        })();
    });
}
