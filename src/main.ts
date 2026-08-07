// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as tool from './tool.js';
import * as logger from './logger.js';

const PLUGIN_PREFIX = 'astrbot_plugin_';
const HELLOWORLD_TEMPLATE_URL = 'https://github.com/Soulter/helloworld/archive/refs/heads/master.zip';
const ASTRBOT_SKILL_REPO = 'xunxiing/AstrBot-Skill';

/** 初始化步骤的执行结果 */
type StepStatus = 'ok' | 'cancelled' | 'failed';

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
    /** 用户输入的插件名(step 4 写入,step 5 消费) */
    pluginName?: string;
}

/**
 * 初始化插件编辑环境,流程由若干独立步骤组成。每个步骤:
 *   - 先判断环境是否已就绪(幂等),已就绪则跳过,不会重复执行;
 *   - 失败时统一弹错误通知并中止(软链接步骤除外,失败仅提示后继续)。
 *
 * 步骤:
 * 1. 选择 `uv` 或 `venv` 创建虚拟环境
 * 2. 安装 `astrbot`(已安装的跳过)
 * 3. 下载 `xunxiing/AstrBot-Skill` 最新 release 到 `./.claude/skills/`,
 *    并创建 `./.codex/skills` → `../.claude/skills` 软链接
 * 4. 下载 `Soulter/helloworld` 模板源码到 `./{插件名}`
 * 5. 为 `./{插件名}` 初始化本地 git 仓库
 *
 * TODO: 原计划中的步骤 6「写 .vscode/astrbot-devkit-config.json」尚未实现。
 */
export async function InitEnv() {
    logger.clear();
    logger.separator('InitEnv 开始');
    logger.log('🚀 正在准备初始化环境');
    vscode.window.showInformationMessage('🚀 正在准备初始化环境');

    const ctx: InitContext = {
        pyExe: process.platform === 'win32'
            ? '.venv\\Scripts\\python.exe'
            : '.venv/bin/python',
    };

    const steps: Step[] = [
        stepCreateVenv(),
        stepInstallDeps(),
        stepDownloadSkill(),
        stepCreateSymlink(),
        stepDownloadTemplate(),
        stepGitInit(),
    ];

    for (const step of steps) {
        const status = await runStep(step, ctx);
        if (status === 'failed') {
            logger.log('⛔ InitEnv 中止(错误详情见上方输出)');
            return;
        }
        if (status === 'cancelled') {
            logger.log('用户取消,InitEnv 中止');
            return;
        }
    }

    // 最后检查一下工作区
    WorkspaceCheck();
}

/**
 * 执行单个初始化步骤:打印分隔线 → 幂等跳过判断 → 执行 → 统一失败处理
 *
 * @returns 'ok' 表示本步完成(含跳过);'cancelled'/'failed' 由调用方决定是否中止
 */
async function runStep(step: Step, ctx: InitContext): Promise<StepStatus> {
    const title = typeof step.title === 'function' ? step.title(ctx) : step.title;
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

// ─── step 1:创建虚拟环境 ─────────────────────────────────

function stepCreateVenv(): Step {
    return {
        title: 'step 1: 创建虚拟环境',
        skipIfDone: () => tool.exists('.venv/'),
        skipMessage: '已检测到 .venv,跳过',
        doneMessage: '✅ 已经检测到虚拟环境！',
        failMessage: '虚拟环境创建失败',
        run: async () => {
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
            // 用户按 Esc 取消
            if (!choice) {
                return 'cancelled';
            }
            logger.log(`用户选择: ${choice.label}`);

            // captureOutput:失败时把 uv/venv 的报错打到输出面板,方便排查
            const ok = choice.label === 'uv'
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

// ─── step 2:安装 Python 依赖 ─────────────────────────────

function stepInstallDeps(): Step {
    const step: Step = {
        title: 'step 2: 安装 Python 依赖',
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

// ─── step 3:下载 AstrBot-Skill ───────────────────────────

function stepDownloadSkill(): Step {
    return {
        title: 'step 3: 下载 AstrBot-Skill',
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

    // ─── step 3.1:创建 .codex/skills 软链接 ───────────────────

function stepCreateSymlink(): Step {
    return {
        title: 'step 3.1: 创建 .codex/skills 软链接',
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

// ─── step 4:下载 helloworld 模板 ─────────────────────────

function stepDownloadTemplate(): Step {
    return {
        title: 'step 4: 下载 helloworld 模板',
        failMessage: 'helloworld 模板下载失败',
        run: async (ctx) => {
            const pluginName = await askPluginName();
            if (!pluginName) {
                logger.log('用户取消输入插件名,跳过 step 4-5');
                vscode.window.showInformationMessage('已跳过插件模板下载(未输入插件名)');
                // 视为"完成":流程继续,后续 git init 步骤会因 pluginName 为空而自动跳过
                return 'ok';
            }
            ctx.pluginName = pluginName;
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

// ─── step 5:git init ─────────────────────────────────────

function stepGitInit(): Step {
    const step: Step = {
        title: ctx => ctx.pluginName ? `step 5: git init ./${ctx.pluginName}/` : 'step 5: git init',
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

/**
 * 检查工作区,有以下几个部分
 * 1. 检查 `.vscode/astrbot-devkit-config.json`
 *     - 检查服务器状态
 *     - 检查已有的 `metadata.yaml` 文件并检索并更新
 * 2. 没有 `.vscode/astrbot-devkit-config.json` 则自己创建
 *
 * TODO: 尚未实现
 */
export function WorkspaceCheck() {

}
