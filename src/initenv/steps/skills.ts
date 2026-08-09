// src/initenv/steps/skills.ts
// AstrBot-Skill 下载 + .codex/skills 软链接。

import * as vscode from 'vscode';
import * as tool from '../../tool.js';
import * as logger from '../../logger.js';
import type { Step } from '../types.js';

const ASTRBOT_SKILL_REPO = 'xunxiing/AstrBot-Skill';

// ─── step 4:下载 AstrBot-Skill ───────────────────────────

export function stepDownloadSkill(): Step {
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

export function stepCreateSymlink(): Step {
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
