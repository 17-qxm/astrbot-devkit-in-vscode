// src/initenv/steps/env.ts
// 虚拟环境相关步骤:创建 venv / 更新 pip / 安装依赖。

import * as vscode from 'vscode';
import * as tool from '../../tool.js';
import * as logger from '../../logger.js';
import type { Step } from '../types.js';

/**
 * 询问用户用 `uv` 还是 `venv` 创建虚拟环境
 *
 * @returns 用户的选择;按 Esc 取消返回 undefined
 */
export async function askVenvTool(): Promise<'uv' | 'venv' | undefined> {
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

export { stepCreateVenv, stepUpdatePip, stepInstallDeps };
