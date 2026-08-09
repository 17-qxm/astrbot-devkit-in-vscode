// src/initenv/steps/template.ts
// helloworld 模板下载 + git init。

import * as vscode from 'vscode';
import * as tool from '../../tool.js';
import * as logger from '../../logger.js';
import type { Step } from '../types.js';

const PLUGIN_PREFIX = 'astrbot_plugin_';
const HELLOWORLD_TEMPLATE_URL = 'https://github.com/Soulter/helloworld/archive/refs/heads/master.zip';

// ─── step 5:下载 helloworld 模板 ─────────────────────────

export function stepDownloadTemplate(): Step {
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
export async function askPluginName(): Promise<string | undefined> {
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

export function stepGitInit(): Step {
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
