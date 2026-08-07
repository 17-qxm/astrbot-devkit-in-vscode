// src/extension.ts
// 扩展入口:激活流程、命令注册、视图/客户端/日志/调试的状态编排。
// 激活全部静默、零打扰;所有初始化结果只反映在侧边栏状态上。见 design.md §3 / implementation.md §10。

import * as vscode from 'vscode';
import * as AstrBotMain from './main.js';
import * as logger from './logger.js';
import { initLogger } from './logger.js';
import {
    getConfig, ensureConfigFile, saveConfig, validateConfig,
    setActiveWorkspace as persistActiveWorkspace,
    getActiveWorkspace, watchConfig,
    scanWorkspaceForPlugins, isPluginRoot, getConfigFilePath,
    toRelativePosix, getWorkspaceRoot,
    DEFAULT_DEBUG, type PluginWorkspace, type DevKitConfig,
} from './config.js';
import {
    createClient, describeApiError, type AstrBotClient, type ConnectionState,
} from './api/client.js';
import * as pluginsApi from './api/plugins.js';
import * as imApi from './api/im.js';
import { DevkitTreeProvider } from './views/devkitTree.js';
import { DevkitLocalProvider } from './views/localTree.js';
import {
    openPluginConfig, pushPluginConfig, forgetDocument,
} from './views/configEditor.js';
import { LogRelay } from './logs/relay.js';
import { AstrBotDebugAdapter } from './debug/debugAdapter.js';
import { OUTPUT_CHANNEL_SERVER } from './constants.js';

// ─── 模块级状态(单例) ───────────────────────────────────

let tree: DevkitTreeProvider;
let localTree: DevkitLocalProvider;
let client: AstrBotClient | undefined;
let relay: LogRelay | undefined;
/** 当前 client 对应的连接相关配置快照(server|key),用于判断是否需要重建 */
let clientConfigKey = '';

function configKey(c: DevKitConfig): string {
    return `${c.astrbotServer}|${c.astrbotAPIkey}`;
}

/** 同步 astrbotDevkit.active / activePlugin 上下文 key */
function syncContext(): void {
    const config = getConfig();
    const active = getActiveWorkspace(config);
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.active', !!active);
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.activePlugin', active?.name ?? '');
    tree.refresh();
    localTree.refresh();
}

/** 供 launch.json 的 ${command:...} 动态取值:返回当前活跃插件名 */
function getActivePluginName(): string {
    return getActiveWorkspace(getConfig())?.name ?? '';
}

/** 重建 client(配置变化时调用) */
function rebuildClient(): void {
    const config = getConfig();
    relay?.dispose();
    relay = undefined;
    // 退役旧 client:其进行中的连接(如静默探活)结果不再更新 UI
    client?.retire();
    client = undefined;
    if (!config) {
        clientConfigKey = '';
        tree.setConnectionState('unconfigured', '');
        return;
    }
    client = createClient(config, state => {
        tree.setConnectionState(state, config.astrbotServer);
    });
    clientConfigKey = configKey(config);
    relay = new LogRelay(client);
    // 初始状态:已配置但未连接
    tree.setConnectionState('unconfigured', config.astrbotServer);
}

// ─── 激活 ────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    initLogger(context);
    logger.log('AstrBot DevKit 扩展已激活');

    tree = new DevkitTreeProvider();
    localTree = new DevkitLocalProvider();

    // setContext 初始化
    vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);

    // 注册侧边栏视图
    vscode.window.registerTreeDataProvider('astrbot-devkit.main', tree);
    vscode.window.registerTreeDataProvider('astrbot-devkit.local', localTree);

    // 构建初始 client(若已有配置)
    rebuildClient();

    // 注册全部命令
    registerCommands(context);

    // 注册原生调试适配器(type: astrbot),与 extension 共享 client/relay
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('astrbot', {
            createDebugAdapterDescriptor() {
                return new vscode.DebugAdapterInlineImplementation(
                    new AstrBotDebugAdapter({
                        getClient: () => client,
                        getRelay: () => relay,
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
            tree.setDebugging(true);
        }),
        vscode.debug.onDidTerminateDebugSession(s => {
            if (s.type !== 'astrbot') {return;}
            vscode.commands.executeCommand('setContext', 'astrbotDevkit.debugging', false);
            tree.setDebugging(false);
        }),
    );

    // 文档关闭时清理配置编辑会话
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => forgetDocument(doc)),
    );

    // 配置文件监听:仅连接相关字段(server/key)变化时重建 client;
    // 只改 debug/pluginWorkspaces 则刷新 UI,避免切换活跃插件时断连
    context.subscriptions.push(watchConfig(() => {
        const cur = getConfig();
        if (cur && configKey(cur) !== clientConfigKey) {
            rebuildClient();
        } else if (!cur) {
            rebuildClient();
        }
        syncContext();
    }));

    // 同步初始上下文(活跃插件等)
    syncContext();

    // 配置缺失 → 触发插件检索(design.md §3.2)
    const initial = getConfig();
    if (!initial) {
        void maybeCreateFromScan();
    } else {
        // 静默探活(design.md §3.3):autoConnect 关闭时不自动连接;不 await、失败静默
        if (client && initial.autoConnect !== false) {
            client.connect().then(() => syncContext(), () => {});
        }
        // 校验配置(有错误只提示,不阻塞)
        const errs = validateConfig(initial);
        if (errs.length > 0) {
            logger.error(`配置校验:${errs.length} 项问题`);
            errs.forEach(e => logger.raw('  - ' + e));
        }
    }

}

export function deactivate() {
    client?.retire();
    relay?.dispose();
}

// ─── 命令注册 ────────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, handler: (...args: unknown[]) => unknown) => {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    };

    // ── launch.json ${command:...} 动态取值:当前活跃插件名 ──
    reg('astrbot-devkit.GetActivePluginName', () => getActivePluginName());

    // ── 原有命令:InitEnv / WorkspaceCheck(重构时遗漏,补注册) ──
    reg('astrbot-devkit-in-vscode.InitEnv', () => AstrBotMain.InitEnv());
    reg('astrbot-devkit-in-vscode.WorkspaceCheck', () => AstrBotMain.WorkspaceCheck());

    // ── 视图刷新 ──
    reg('astrbot-devkit.Refresh', async () => {
        // 仅当连接相关配置(server/key)变化时才重建 client;
        // 否则只刷新视图 + 重连,避免销毁日志通道/断开日志流
        const cur = getConfig();
        if (cur && configKey(cur) !== clientConfigKey) {
            rebuildClient();
        } else if (!cur && client) {
            rebuildClient();
        }
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
        const target = client!;
        try {
            await target.connect();
            syncContext();
            // 连接期间配置若被重建(client 被替换),不再弹旧配置的通知
            if (client === target) {
                vscode.window.showInformationMessage('✅ 已连接到 AstrBot 服务器');
            }
        } catch (e) {
            if (client === target) {
                vscode.window.showErrorMessage(`连接失败:${describeApiError(e)}`);
            }
        }
    });

    // ── 自动连接开关 ──
    reg('astrbot-devkit.ToggleAutoConnect', async () => {
        const config = getConfig();
        if (!config) {return;}
        config.autoConnect = !(config.autoConnect ?? true);
        await saveConfig(config);
        syncContext();
        vscode.window.showInformationMessage(
            `启动时自动连接服务器已${config.autoConnect ? '开启' : '关闭'}`,
        );
    });

    // ── 接收服务器日志开关 ──
    reg('astrbot-devkit.ToggleLogs', async () => {
        const config = getConfig();
        if (!config) {return;}
        config.debug.receiveLogs = !config.debug.receiveLogs;
        await saveConfig(config);
        syncContext();
        if (config.debug.receiveLogs) {
            // 开启:立即开始接收日志(独立于调试会话,现在生效)
            if (relay) {
                // 开关开启不清空通道历史(clearFirst=false),继续追加
                const ok = await relay.start(false);
                if (!ok) {
                    vscode.window.showWarningMessage(
                        '日志连接失败,请检查 astrbotAPIkey 与日志投射插件状态',
                    );
                } else {
                    vscode.window.showInformationMessage('已开启日志接收');
                }
            } else {
                vscode.window.showWarningMessage('客户端未就绪,请先配置并连接服务器');
            }
        } else {
            relay?.stop();
            vscode.window.showInformationMessage('已关闭日志接收');
        }
    });

    // ── 调试结束后处理 ──
    reg('astrbot-devkit.EditStopAction', async () => {
        const config = getConfig();
        if (!config) {return;}
        const labels: Record<string, string> = {
            ask: '每次询问(默认)',
            disable: '直接禁用插件',
            keep: '保留运行',
        };
        const pick = await vscode.window.showQuickPick(
            (['ask', 'disable', 'keep'] as const).map(v => ({
                label: labels[v],
                value: v,
            })),
            {
                title: '调试结束后对插件的处理',
                placeHolder: `当前:${labels[config.debug.stopAction]}`,
            },
        );
        if (!pick) {return;}
        config.debug.stopAction = pick.value;
        await saveConfig(config);
        syncContext();
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

    // ── Debug:以原生调试会话启动(动态配置,无需 launch.json;状态栏/节点按钮入口) ──
    reg('astrbot-devkit.Debug', async (arg?: unknown) => {
        const config = getConfig();
        if (!config) {
            vscode.window.showErrorMessage('尚未配置 AstrBot 服务器', '创建配置')
                .then(p => { if (p === '创建配置') { vscode.commands.executeCommand('astrbot-devkit.CreateConfig'); } });
            return;
        }
        let ws = workspaceFromArg(arg);
        if (!ws) {
            ws = getActiveWorkspace(config);
        }
        if (!ws) {
            vscode.window.showWarningMessage('请先在侧边栏「本地插件」中选择推送目标');
            return;
        }
        // 反复启动:已有 astrbot 调试会话时,先停止再重新启动(避免多会话/状态错乱)
        const running = vscode.debug.activeDebugSession;
        if (running?.type === 'astrbot') {
            await vscode.debug.stopDebugging(running);
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        await vscode.debug.startDebugging(folder, {
            type: 'astrbot',
            request: 'launch',
            name: `快速推送:${ws.name}`,
            pluginName: ws.name,
        });
    });

    // ── 停止 Debug(状态栏按钮;原生调试由调试工具栏负责) ──
    reg('astrbot-devkit.StopDebug', async () => {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === 'astrbot') {
            await vscode.debug.stopDebugging(session);
        } else {
            // 无活跃原生会话时,兜底断开日志流
            relay?.stop();
        }
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
                client?.retire();
                client = createClient(config, s => tree.setConnectionState(s, config.astrbotServer));
                clientConfigKey = configKey(config);
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
        logger.log('未检测到 AstrBot 插件,等待用户手动创建配置');
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
        void createConfigWizard();
    }
}

// ─── 创建配置向导 ────────────────────────────────────────

/** 创建/补全配置向导:输入 server → API key → 探活验证 → 保存 */
async function createConfigWizard(): Promise<void> {
    // 1. server 地址
    const addr = await vscode.window.showInputBox({
        prompt: 'AstrBot 服务器地址',
        placeHolder: '127.0.0.1:6185',
        value: getConfig()?.astrbotServer ?? '127.0.0.1:6185',
        ignoreFocusOut: true,
        validateInput: v => v.trim() ? undefined : '不能为空',
    });
    if (!addr) {return;}

    // 2. API key
    const key = await vscode.window.showInputBox({
        prompt: 'AstrBot API Key(abk_ 开头,在 WebUI 设置中创建)',
        placeHolder: 'abk_xxxxxxxx',
        password: true,
        ignoreFocusOut: true,
        validateInput: v => v.trim() ? undefined : '不能为空',
    });
    if (!key) {return;}

    // 3. 立即探活验证(失败时用户可选"仍然保存")
    const tmpConfig: DevKitConfig = {
        version: 2,
        astrbotServer: addr.trim(),
        astrbotAPIkey: key.trim(),
        debug: { ...DEFAULT_DEBUG },
        pluginWorkspaces: getConfig()?.pluginWorkspaces ?? [],
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
        if (choice !== '仍然保存') {return;}
    }

    // 4. 保存(已有配置则原地更新,否则写入新配置)
    const existing = getConfig();
    if (existing) {
        existing.astrbotServer = addr.trim();
        existing.astrbotAPIkey = key.trim();
        await saveConfig(existing);
    } else {
        await saveConfig(tmpConfig);
    }
    syncContext();
    logger.show();
    vscode.window.showInformationMessage('✅ 配置已保存');
}
