// src/initenv/steps/config.ts
// 写 .vscode/astrbot-devkit-config.json + 配置服务器连接。

import * as logger from '../../logger.js';
import type { Step } from '../types.js';
import {
    ensureConfigFile,
    getConfig,
    isPluginRoot,
    saveConfig,
} from '../../config/index.js';
import { runConfigWizard } from '../../configWizard.js';

// ─── step 7:写 .vscode/astrbot-devkit-config.json ────────

export function stepWriteConfig(): Step {
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

export function stepConfigureServer(): Step {
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
