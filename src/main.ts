// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as tool from './tool.js';
import * as logger from './logger.js';
import {
    addPluginCandidates,
    ensureConfigFile,
    getConfig,
    isPluginRoot,
    scanWorkspaceForPlugins,
    saveConfig,
} from './config.js';
import { runConfigWizard } from './configWizard.js';

const PLUGIN_PREFIX = 'astrbot_plugin_';
const HELLOWORLD_TEMPLATE_URL = 'https://github.com/Soulter/helloworld/archive/refs/heads/master.zip';
const ASTRBOT_SKILL_REPO = 'xunxiing/AstrBot-Skill';

/** 初始化步骤的执行结果 */
type StepStatus = 'ok' | 'cancelled' | 'failed';

/** InitEnv 的整体结果 */
type InitResult = 'ok' | 'cancelled' | 'failed';

/** 初始化步骤定义 */
interface Step {
    /** 步骤标题,用作输出面板分隔线;可以是函数(依赖上下文动态生成) */
    title: string | ((ctx: InitContext) => string);
    /** 已就绪时跳过整步(幂等判断);返回 true 表示无需执行 */
    skipIfDone?: (ctx: InitContext) => boolean;
    /** 跳过时打印到输出面板的说明 */
    skipMessage?: string | ((ctx: InitContext) => string);
    /** 跳过时弹出的信息提示(可选) */
    doneMessage?: string;
    /** 失败时弹出的错误文案;默认用步骤标题 */
    failMessage?: string | ((ctx: InitContext) => string);
    /** false 表示失败不中止流程(提示后继续后续步骤),默认 true */
    fatal?: boolean;
    /** 步骤主逻辑 */
    run: (ctx: InitContext) => Promise<StepStatus>;
}

/** 步骤间共享的上下文 */
interface InitContext {
    /** Python 可执行文件路径(按平台区分) */
    pyExe: string;
    /** 用户输入的插件名(预收集阶段写入,模板下载/git init 消费) */
    pluginName?: string;
}

/** 一条步骤链:链内步骤串行执行,链与链之间可并行 */
type StepChain = Step[];

/**
 * 初始化插件编辑环境,流程由若干独立步骤组成。每个步骤:
 *   - 先判断环境是否已就绪(幂等),已就绪则跳过,不会重复执行;
 *   - 失败时统一弹错误通知并中止(软链接步骤除外,失败仅提示后继续)。
 *
 * 执行方式:
 * 1. 预收集用户输入(虚拟环境创建方式、插件名),避免并行阶段弹多个输入框;
 * 2. 三条步骤链并行执行(链内串行),全程通过进度通知展示当前进度:
 *    A. 创建虚拟环境 → 更新 pip → 安装依赖
 *    B. 下载 AstrBot-Skill → 创建 .codex/skills 软链接
 *    C. 下载 helloworld 模板 → git init → 写 .vscode/astrbot-devkit-config.json(注册新插件)
 *       → 询问服务器地址/API key 并探活保存(已配置则跳过)
 * 3. 全部结束后统一汇总:任一 fatal 步骤失败则整体标记失败。
 */
export async function InitEnv() {
    logger.clear();
    logger.separator('InitEnv 开始');
    logger.log('🚀 正在准备初始化环境');

    // 进度通知贯穿整个初始化过程,直到全部步骤结束
    const result: InitResult = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: '🚀 AstrBot DevKit 正在初始化环境',
            cancellable: false,
        },
        async (progress) => {
            // ── 1. 预收集输入:避免并行阶段同时弹多个输入框 ──
            progress.report({ message: '收集配置...' });
            const venvTool = await askVenvTool();
            if (!venvTool) {
                return 'cancelled';
            }

            const pluginName = await askPluginName();
            const ctx: InitContext = {
                pyExe: process.platform === 'win32'
                    ? '.venv\\Scripts\\python.exe'
                    : '.venv/bin/python',
                pluginName,
            };

            // ── 2. 三条步骤链并行执行(链内串行) ──
            const chains: StepChain[] = [
                [stepCreateVenv(venvTool), stepUpdatePip(), stepInstallDeps()],
                [stepDownloadSkill(), stepCreateSymlink()],
                [stepDownloadTemplate(), stepGitInit(), stepWriteConfig(), stepConfigureServer()],
            ];
            const totalSteps = chains.reduce((n, c) => n + c.length, 0);
            let completed = 0;

            const results = await Promise.all(
                chains.map(chain => runChain(chain, ctx, () => {
                    completed += 1;
                    progress.report({
                        increment: 100 / totalSteps,
                        message: `(${completed}/${totalSteps})`,
                    });
                })),
            );

            return results.every(Boolean) ? 'ok' : 'failed';
        },
    );

    switch (result) {
        case 'ok':
            logger.separator('InitEnv 完成');
            logger.log('✅ InitEnv 完成');
            break;
        case 'cancelled':
            logger.log('用户取消,InitEnv 中止');
            break;
        case 'failed':
            logger.log('⛔ InitEnv 结束(存在失败步骤,详情见上方输出)');
            break;
    }
}

/** 解析步骤标题(支持函数式标题) */
function stepTitle(step: Step, ctx: InitContext): string {
    return typeof step.title === 'function' ? step.title(ctx) : step.title;
}

/**
 * 执行单个初始化步骤:打印分隔线 → 幂等跳过判断 → 执行 → 统一失败处理
 *
 * @returns 'ok' 表示本步完成(含跳过);'cancelled'/'failed' 由调用方决定是否中止
 */
async function runStep(step: Step, ctx: InitContext): Promise<StepStatus> {
    const title = stepTitle(step, ctx);
    logger.separator(title);

    // 幂等判断:环境已就绪则跳过
    if (step.skipIfDone?.(ctx)) {
        const skipMessage = typeof step.skipMessage === 'function'
            ? step.skipMessage(ctx)
            : (step.skipMessage ?? '已满足条件,跳过');
        logger.log(skipMessage);
        if (step.doneMessage) {
            vscode.window.showInformationMessage(step.doneMessage);
        }
        return 'ok';
    }

    const status = await step.run(ctx);
    if (status !== 'failed') {
        return status;
    }

    // 统一失败处理:显示输出面板 + 错误通知(可点击"查看日志")
    logger.show();
    const failMessage = typeof step.failMessage === 'function'
        ? step.failMessage(ctx)
        : (step.failMessage ?? `${title} 失败`);
    vscode.window.showErrorMessage(`❌ ${failMessage},请查看输出面板`, '查看日志').then(action => {
        if (action === '查看日志') { logger.show(); }
    });

    // 非致命步骤失败不中止整个流程
    if (step.fatal === false) {
        logger.log('⚠️ 此步失败,继续后续步骤');
        return 'ok';
    }
    return 'failed';
}

/**
 * 串行执行一条步骤链,每完成一步调用 onStepDone 上报进度
 *
 * @returns true 表示链内所有步骤都成功(含跳过/非致命失败)
 */
async function runChain(
    chain: StepChain,
    ctx: InitContext,
    onStepDone?: () => void,
): Promise<boolean> {
    for (const step of chain) {
        let status: StepStatus;
        try {
            status = await runStep(step, ctx);
        } catch (e: any) {
            logger.error(`步骤内部异常: ${stepTitle(step, ctx)}${e?.message ? ` (${e.message})` : ''}`);
            return false;
        }
        onStepDone?.();
        if (status !== 'ok') {
            return false;
        }
    }
    return true;
}

// ─── step 1:创建虚拟环境 ─────────────────────────────────

/**
 * 询问用户用 `uv` 还是 `venv` 创建虚拟环境
 *
 * @returns 用户的选择;按 Esc 取消返回 undefined
 */
async function askVenvTool(): Promise<'uv' | 'venv' | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: 'uv', description: '📦 使用 uv 创建虚拟环境', detail: '推荐，但需先安装 uv' },
            { label: 'venv', description: '🐍 使用 venv 创建虚拟环境', detail: '兼容性最好，但速度较慢' },
        ],
        {
            placeHolder: '选择虚拟环境创建方式',
            title: '🚀 AstrBot DevKit - 初始化环境',
            ignoreFocusOut: true,
        },
    );
    if (!choice) {
        return undefined;
    }
    logger.log(`用户选择: ${choice.label}`);
    return choice.label === 'uv' ? 'uv' : 'venv';
}

function stepCreateVenv(method: 'uv' | 'venv'): Step {
    return {
        title: 'step 1: 创建虚拟环境',
        skipIfDone: () => tool.exists('.venv/'),
        skipMessage: '已检测到 .venv,跳过',
        doneMessage: '✅ 已经检测到虚拟环境！',
        failMessage: '虚拟环境创建失败',
        run: async () => {
            // captureOutput:失败时把 uv/venv 的报错打到输出面板,方便排查
            const ok = method === 'uv'
                ? tool.run('uv venv', { captureOutput: true })
                : tool.run('python -m venv .venv', { captureOutput: true });

            if (ok) {
                logger.log('✅ 虚拟环境创建成功');
                vscode.window.showInformationMessage('✅ 已成功安装虚拟环境！');
                return 'ok';
            }
            logger.error('虚拟环境创建失败');
            return 'failed';
        },
    };
}

// ─── step 2:更新虚拟环境 pip ─────────────────────────────

function stepUpdatePip(): Step {
    return {
        title: 'step 2: 更新虚拟环境 pip',
        // pip 更新失败不中止流程:依赖安装步骤会再次暴露问题,
        // 避免因网络抖动导致整个初始化流程卡死
        fatal: false,
        failMessage: '虚拟环境 pip 更新失败',
        run: async (ctx) => {
            // uv venv 默认不内置 pip,先探测;没有 pip 时退回 uv pip install
            // (它会顺手把 pip 装进虚拟环境)
            if (tool.run(`"${ctx.pyExe}" -m pip --version`)) {
                logger.log('检测到 pip,执行升级: python -m pip install --upgrade pip');
                const ok = tool.run(`"${ctx.pyExe}" -m pip install --upgrade pip`, { captureOutput: true });
                if (ok) {
                    logger.log('✅ 虚拟环境 pip 已更新');
                    vscode.window.showInformationMessage('✅ 虚拟环境 pip 已更新');
                    return 'ok';
                }
                logger.error('虚拟环境 pip 更新失败');
                return 'failed';
            }

            logger.log('虚拟环境未内置 pip(uv venv),改用 uv pip 安装并更新 pip');
            const ok = tool.run('uv pip install --upgrade pip', { captureOutput: true });
            if (ok) {
                logger.log('✅ 已通过 uv 安装/更新 pip');
                vscode.window.showInformationMessage('✅ 虚拟环境 pip 已更新');
                return 'ok';
            }
            logger.error('uv pip 安装/更新 pip 失败(请确认已安装 uv)');
            return 'failed';
        },
    };
}

// ─── step 3:安装 Python 依赖 ─────────────────────────────

function stepInstallDeps(): Step {
    const step: Step = {
        title: 'step 3: 安装 Python 依赖',
        failMessage: '安装 Python 依赖失败',
        run: async (ctx) => {
            logger.log(`Python: ${ctx.pyExe}`);
            // 显示输出面板,用户能实时看到 pip 下载进度
            logger.show();

            // 需要安装的包列表
            const packagesToCheck = ['astrbot'];
            // 收集真正需要安装的包(已装的跳过)
            const packagesToInstall: string[] = [];
            for (const pkg of packagesToCheck) {
                // pip show 在包已装时退出码 0,未装时退出码 1
                if (tool.run(`"${ctx.pyExe}" -m pip show ${pkg}`)) {
                    logger.log(`✅ ${pkg} 已安装,跳过`);
                } else {
                    logger.log(`${pkg} 未安装,将安装`);
                    packagesToInstall.push(pkg);
                }
            }

            if (packagesToInstall.length === 0) {
                logger.log('✅ 所有依赖已就绪,无需安装');
                vscode.window.showInformationMessage('✅ 所有 Python 依赖已安装');
                return 'ok';
            }

            const installList = packagesToInstall.join(' ');
            logger.log(`开始安装: ${installList}`);
            const ok = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `📦 正在安装 ${installList}...`,
                    cancellable: false,
                },
                async () => {
                    // 用 runStreaming,stdout/stderr 实时逐行打到输出面板
                    // 用户打开输出面板就能看到 pip 的下载进度条
                    return tool.runStreaming(`"${ctx.pyExe}" -m pip install ${installList}`);
                },
            );

            if (ok) {
                logger.log(`✅ ${installList} 安装完成`);
                vscode.window.showInformationMessage(`✅ 依赖安装完成: ${installList}`);
                return 'ok';
            }
            logger.error(`安装失败: ${installList}`);
            step.failMessage = `安装失败: ${installList}`;
            return 'failed';
        },
    };
    return step;
}

// ─── step 4:下载 AstrBot-Skill ───────────────────────────

function stepDownloadSkill(): Step {
    return {
        title: 'step 4: 下载 AstrBot-Skill',
        skipIfDone: () => tool.exists('.claude/skills/AstrBot-Skill/'),
        skipMessage: '已检测到 .claude/skills/AstrBot-Skill,跳过下载',
        doneMessage: '✅ AstrBot-Skill 已存在',
        failMessage: 'AstrBot-Skill 下载失败',
        run: async () => {
            // 下载过程可能较长,提前显示面板让用户看进度
            logger.show();
            const ok = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '⬇️  正在下载 AstrBot-Skill...',
                    cancellable: false,
                },
                async () => {
                    // 1. 查最新 release
                    logger.log('查询 GitHub 最新 release...');
                    const release = await tool.getLatestRelease(ASTRBOT_SKILL_REPO);
                    if (!release) {
                        logger.error('获取 release 失败(仓库不存在/无 release/网络问题)');
                        return false;
                    }
                    logger.log(`最新版本: ${release.tagName}`);

                    // 2. 下载 zipball 到临时位置
                    const tmpZip = `.tmp/astrbot-skill-${release.tagName}.zip`;
                    const tmpExtract = '.tmp/astrbot-skill-extracted';
                    logger.log(`下载: ${release.zipballUrl}`);
                    logger.log(`       → ${tmpZip}`);
                    if (!await tool.downloadFile(release.zipballUrl, tmpZip)) {
                        logger.error('下载失败,请检查网络(国内可能需要代理)');
                        return false;
                    }
                    logger.log('下载完成');

                    // 3. 解压到临时目录(GitHub zipball 会套一层 hash 命名的子目录)
                    tool.remove(tmpExtract);
                    logger.log(`解压: ${tmpZip} → ${tmpExtract}`);
                    if (!tool.extractZip(tmpZip, tmpExtract)) {
                        logger.error('解压失败(zip 文件可能损坏)');
                        return false;
                    }

                    // 4. 找到嵌套的 hash 子目录并移动到目标位置
                    const subdirs = tool.listSubdirs(tmpExtract);
                    if (subdirs.length === 0) {
                        logger.error('解压结果异常,未找到子目录');
                        return false;
                    }
                    logger.log(`嵌套子目录: ${subdirs[0]}`);
                    logger.log('移动 → .claude/skills/AstrBot-Skill');
                    if (!tool.move(`${tmpExtract}/${subdirs[0]}`, '.claude/skills/AstrBot-Skill')) {
                        logger.error('整理 AstrBot-Skill 目录失败');
                        return false;
                    }

                    // 5. 清理临时文件
                    tool.remove(tmpZip);
                    tool.remove(tmpExtract);
                    logger.log('临时文件已清理');
                    return true;
                },
            );

            if (!ok) {
                return 'failed';
            }
            logger.log('✅ AstrBot-Skill 已安装');
            vscode.window.showInformationMessage('✅ AstrBot-Skill 已安装');
            return 'ok';
        },
    };
}

    // ─── step 4.1:创建 .codex/skills 软链接 ───────────────────

function stepCreateSymlink(): Step {
    return {
        title: 'step 4.1: 创建 .codex/skills 软链接',
        // 独立幂等判断:软链接已存在即跳过
        // (即使 .claude/skills 之前已下载,首次软链接失败后重跑也能补上)
        skipIfDone: () => tool.exists('.codex/skills/'),
        skipMessage: '.codex/skills 软链接已存在,跳过',
        // 软链接失败不中止整个流程:提示用户手动处理即可
        fatal: false,
        failMessage: '.codex/skills 软链接创建失败(Windows 需开发者模式)。建议手动复制: xcopy /E /I /Y .claude\\skills .codex\\skills',
        run: async () => {
            // 相对路径:.codex/skills → ../.claude/skills
            // createSymlink 内部会基于 link 父目录自动解析这个相对路径
            if (tool.createSymlink('../.claude/skills', '.codex/skills')) {
                logger.log('✅ .codex/skills 软链接已创建');
                vscode.window.showInformationMessage('✅ .codex/skills 软链接已创建');
                return 'ok';
            }
            logger.error('.codex/skills 软链接创建失败');
            logger.log('Windows 提示:请开启"开发者模式"(设置→隐私和安全→开发者选项),或以管理员身份运行 VS Code');
            logger.log('或改用复制替代软链接:xcopy /E /I /Y .claude\\skills .codex\\skills');
            return 'failed';
        },
    };
}

// ─── step 5:下载 helloworld 模板 ─────────────────────────

function stepDownloadTemplate(): Step {
    return {
        title: 'step 5: 下载 helloworld 模板',
        failMessage: 'helloworld 模板下载失败',
        run: async (ctx) => {
            const pluginName = ctx.pluginName;
            if (!pluginName) {
                logger.log('用户取消输入插件名,跳过模板下载与 git init');
                vscode.window.showInformationMessage('已跳过插件模板下载(未输入插件名)');
                // 视为"完成":流程继续,后续 git init 步骤会因 pluginName 为空而自动跳过
                return 'ok';
            }
            logger.log(`插件名: ${pluginName}`);

            const tmpZip = '.tmp/helloworld.zip';
            const tmpExtract = '.tmp/helloworld-extracted';
            // 清理可能存在的旧临时文件;如果用户选了覆盖,先删掉目标目录
            tool.remove(tmpZip);
            tool.remove(tmpExtract);
            tool.remove(`${pluginName}/`);

            logger.show();
            const ok = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '⬇️  正在下载 helloworld 模板...',
                    cancellable: false,
                },
                async () => {
                    logger.log(`下载: ${HELLOWORLD_TEMPLATE_URL}`);
                    if (!await tool.downloadFile(HELLOWORLD_TEMPLATE_URL, tmpZip)) {
                        logger.error('下载 helloworld 失败(请检查网络,国内可能需要代理)');
                        return false;
                    }
                    logger.log('下载完成');

                    logger.log(`解压: ${tmpZip} → ${tmpExtract}`);
                    if (!tool.extractZip(tmpZip, tmpExtract)) {
                        logger.error('解压失败(zip 文件可能损坏)');
                        return false;
                    }

                    // GitHub zipball 套一层 hash 子目录,找到它
                    const subdirs = tool.listSubdirs(tmpExtract);
                    if (subdirs.length === 0) {
                        logger.error('解压结果异常,未找到子目录');
                        return false;
                    }
                    logger.log(`嵌套子目录: ${subdirs[0]}`);

                    // 移动到目标位置(改名为插件名)
                    logger.log(`移动 → ${pluginName}/`);
                    if (!tool.move(`${tmpExtract}/${subdirs[0]}`, `${pluginName}/`)) {
                        logger.error('整理插件目录失败');
                        return false;
                    }

                    tool.remove(tmpZip);
                    tool.remove(tmpExtract);
                    logger.log('临时文件已清理');
                    return true;
                },
            );

            if (!ok) {
                return 'failed';
            }
            logger.log('✅ helloworld 模板已就位');
            vscode.window.showInformationMessage(`✅ 插件模板已下载到 ./${pluginName}/`);
            return 'ok';
        },
    };
}

/**
 * 询问用户插件名(带覆盖确认)
 *
 * 插件名固定带 astrbot_plugin_ 前缀,用户只输入后半部分
 * (如 chat_helper → astrbot_plugin_chat_helper)
 *
 * @returns 完整插件名;用户取消返回 undefined
 */
async function askPluginName(): Promise<string | undefined> {
    while (true) {
        const suffix = await vscode.window.showInputBox({
            prompt: `请输入插件名(最终为 ${PLUGIN_PREFIX}<你输入的内容>)`,
            placeHolder: '如:chat_helper',
            value: 'hello',
            ignoreFocusOut: true,
            validateInput: s => {
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
                    return '只能包含字母、数字、下划线,且不以数字开头';
                }
                return undefined;   // 通过
            },
        });
        if (!suffix) {
            return undefined;
        }

        const pluginName = PLUGIN_PREFIX + suffix;
        // 检查目标目录是否已存在(避免覆盖用户已有项目)
        if (tool.exists(`${pluginName}/`)) {
            const overwrite = await vscode.window.showWarningMessage(
                `目录 ./${pluginName} 已存在,是否覆盖?(将重新下载模板并 git init)`,
                { modal: false },
                '覆盖',
                '取消',
            );
            // 选"取消"或关闭对话框 → 重置后继续询问
            if (overwrite !== '覆盖') {
                continue;
            }
            logger.log(`用户确认覆盖 ${pluginName}/`);
        }
        return pluginName;
    }
}

// ─── step 6:git init ─────────────────────────────────────

function stepGitInit(): Step {
    const step: Step = {
        title: ctx => ctx.pluginName ? `step 6: git init ./${ctx.pluginName}/` : 'step 6: git init',
        skipIfDone: ctx => !ctx.pluginName || tool.exists(`${ctx.pluginName}/.git/`),
        skipMessage: ctx => ctx.pluginName
            ? `./${ctx.pluginName}/.git 已存在,跳过 git init`
            : '未输入插件名,跳过',
        run: async (ctx) => {
            const pluginName = ctx.pluginName;
            if (!pluginName) {
                return 'ok';   // 理论上走不到(见 skipIfDone)
            }

            // 先检查 git 是否可用
            if (!tool.run('git --version', { captureOutput: true })) {
                logger.error('未检测到 git,请先安装 git');
                step.failMessage = '未检测到 git,请先安装 git';
                return 'failed';
            }
            logger.log('git 已安装');

            logger.log(`执行: git init(在 ./${pluginName}/ 中)`);
            if (tool.run('git init', { cwd: pluginName, captureOutput: true })) {
                logger.log('✅ git init 完成');
                vscode.window.showInformationMessage('✅ git 仓库已初始化');
                return 'ok';
            }
            logger.error('git init 失败');
            step.failMessage = 'git init 失败';
            return 'failed';
        },
    };
    return step;
}

// ─── step 7:写 .vscode/astrbot-devkit-config.json ────────

function stepWriteConfig(): Step {
    return {
        title: 'step 7: 写 .vscode/astrbot-devkit-config.json',
        failMessage: '写入配置文件失败',
        run: async (ctx) => {
            // 1. 配置文件缺失时用模板创建(默认服务器 127.0.0.1:6185)
            if (await ensureConfigFile()) {
                logger.log('✅ 已创建配置文件(默认服务器 127.0.0.1:6185)');
            } else {
                logger.log('配置文件已存在,复用现有内容');
            }

            const config = getConfig();
            if (!config) {
                logger.error('配置文件读取失败');
                return 'failed';
            }

            // 2. 把 InitEnv 下载的插件注册进 pluginWorkspaces(由 metadata.yaml 生成)
            if (ctx.pluginName) {
                const cand = isPluginRoot(ctx.pluginName);
                if (!cand) {
                    logger.error(`未找到 ${ctx.pluginName}/metadata.yaml,无法注册插件(可稍后用「自动检索插件」补录)`);
                    return 'failed';
                }
                const ws = config.pluginWorkspaces ?? [];
                if (ws.some(w => w.name === cand.name)) {
                    logger.log(`插件 ${cand.name} 已在 pluginWorkspaces 中,无需重复注册`);
                } else {
                    // 当前没有活跃插件时,把新插件设为活跃(F5/Debug 的目标)
                    const hasActive = ws.some(w => w.active);
                    ws.push({
                        dir: cand.dir,
                        name: cand.name,
                        version: cand.version,
                        active: !hasActive,
                    });
                    config.pluginWorkspaces = ws;
                    await saveConfig(config);
                    logger.log(`✅ 已注册插件: ${cand.name} v${cand.version}(${cand.dir})${hasActive ? '' : ',并设为活跃'}`);
                }
            }
            return 'ok';
        },
    };
}

// ─── step 8:配置服务器连接 ───────────────────────────────

function stepConfigureServer(): Step {
    return {
        title: 'step 8: 配置服务器连接',
        // 已配置过(API key 非空)则跳过,保证 InitEnv 幂等
        skipIfDone: () => !!getConfig()?.astrbotAPIkey,
        skipMessage: '已配置服务器连接(API key 非空),跳过',
        doneMessage: '✅ 服务器连接已配置',
        failMessage: '配置服务器连接失败(可稍后用「创建配置」补全)',
        run: async () => {
            const ok = await runConfigWizard();
            if (!ok) {
                // 用户取消输入:不视为失败,InitEnv 照常收尾
                logger.log('用户取消服务器配置,可稍后用「创建配置」命令补全');
                return 'ok';
            }
            logger.log('✅ 服务器连接配置完成');
            return 'ok';
        },
    };
}

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
