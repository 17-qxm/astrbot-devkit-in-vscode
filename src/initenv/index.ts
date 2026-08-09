// src/initenv/index.ts
// InitEnv 编排框架:预收集输入 → 三条步骤链并行 → 统一汇总。

import * as vscode from 'vscode';
import * as logger from '../logger.js';
import type { InitContext, InitResult, Step, StepChain } from './types.js';
import { askVenvTool, stepCreateVenv, stepUpdatePip, stepInstallDeps } from './steps/env.js';
import { stepDownloadSkill, stepCreateSymlink } from './steps/skills.js';
import { askPluginName, stepDownloadTemplate, stepGitInit } from './steps/template.js';
import { stepWriteConfig, stepConfigureServer } from './steps/config.js';

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
async function runStep(step: Step, ctx: InitContext): Promise<'ok' | 'cancelled' | 'failed'> {
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
        let status: 'ok' | 'cancelled' | 'failed';
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
