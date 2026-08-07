import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { execSync, spawn } from 'child_process';
import * as logger from './logger.js';

// ─── 路径辅助 ─────────────────────────────────────────────

/** 取工作区根的绝对路径;未打开工作区时返回 undefined */
function getRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** 把相对工作区的路径拼成绝对路径 */
function resolve(relPath: string): string | undefined {
    const root = getRoot();
    return root ? path.join(root, relPath) : undefined;
}

// ─── 基础工具 ─────────────────────────────────────────────

/**
 * 检查工作区内文件或目录是否存在
 *
 * 规则:入参末尾是 `/` → 检测目录;否则 → 检测文件
 *   - exists('.venv/')              → 必须是目录
 *   - exists('.vscode/config.json') → 必须是文件
 */
export function exists(relPath: string): boolean {
    const full = resolve(relPath);
    if (!full) {return false;}
    try {
        const stat = fs.statSync(full);
        return relPath.endsWith('/') ? stat.isDirectory() : stat.isFile();
    } catch {
        return false;
    }
}

/** run() 的选项 */
export interface RunOptions {
    /** 命令工作目录(相对工作区根),默认工作区根 */
    cwd?: string;
    /**
     * 失败时把子进程的 stderr 打到输出面板,便于定位失败原因
     *
     * 注意:仅用于预期会成功的命令(如 uv venv、git init);
     * 对"失败是正常情况"的探测命令(如 pip show)不要开启,否则会刷屏。
     */
    captureOutput?: boolean;
}

/**
 * 执行命令,返回是否成功(退出码 0)
 *
 * @param command  完整命令字符串
 * @param options  选项,见 {@link RunOptions}
 */
export function run(command: string, options?: RunOptions): boolean {
    const cwd = resolve(options?.cwd ?? '.');
    if (!cwd) {return false;}
    const capture = options?.captureOutput ?? false;
    logger.log(`$ ${command}` + (options?.cwd ? `  (cwd: ${options.cwd})` : ''));
    try {
        execSync(command, {
            cwd,
            // captureOutput 时接管 stdout/stderr,失败后把 stderr 打到日志
            stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'],
            encoding: 'utf8',
        });
        logger.log('  → 成功');
        return true;
    } catch (e: any) {
        logger.error(`命令失败: ${command}`);
        if (capture) {
            const stderr = e.stderr ? Buffer.from(e.stderr).toString('utf8').trim() : '';
            if (stderr) {
                logger.raw('── stderr ──');
                logger.raw(stderr);
            } else {
                logger.raw(`(无输出,退出码 ${e.status ?? '?'})`);
            }
        }
        return false;
    }
}

/**
 * 执行命令并返回 stdout(同步)
 *
 * 与 run() 区别:
 *   - run()      只关心退出码,丢弃所有输出
 *   - runWithOutput() 捕获 stdout 字符串返回,stderr 写入日志
 *
 * 用于诊断:失败时把命令的 stderr 打到输出面板,方便排查
 *
 * @returns 成功返回 stdout 字符串;失败返回 undefined
 */
export function runWithOutput(command: string, cwdRel?: string): string | undefined {
    const cwd = resolve(cwdRel ?? '.');
    if (!cwd) {return undefined;}
    logger.log(`$ ${command}` + (cwdRel ? `  (cwd: ${cwdRel})` : ''));
    try {
        const stdout = execSync(command, {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],   // 捕获 stdout 和 stderr
        });
        const trimmed = stdout.trim();
        // stdout 太长只打前 20 行,避免刷屏
        const lines = trimmed.split('\n');
        if (lines.length <= 20) {
            lines.forEach(l => logger.raw('  ' + l));
        } else {
            lines.slice(0, 20).forEach(l => logger.raw('  ' + l));
            logger.raw(`  ... (共 ${lines.length} 行,已截断)`);
        }
        logger.log('  → 成功');
        return trimmed;
    } catch (e: any) {
        logger.error(`命令失败: ${command}`);
        // 关键:把子进程的 stderr 也打到日志,这是排查问题的金钥匙
        const stderr = e.stderr ? Buffer.from(e.stderr).toString('utf8') : '';
        const stdout = e.stdout ? Buffer.from(e.stdout).toString('utf8') : '';
        if (stdout) {
            logger.raw('── stdout ──');
            logger.raw(stdout);
        }
        if (stderr) {
            logger.raw('── stderr ──');
            logger.raw(stderr);
        }
        if (!stdout && !stderr) {
            logger.raw(`(无输出,退出码 ${e.status ?? '?'})`);
        }
        return undefined;
    }
}

/**
 * 异步执行命令,stdout/stderr 实时逐行打到输出面板
 *
 * 与 runWithOutput 区别:
 *   - runWithOutput 同步阻塞,命令跑完才一次性输出
 *   - runStreaming  异步流式,每出一行立刻显示(用户看得到 pip 下载进度)
 *
 * 适合长任务:pip install、git clone、npm install 等
 *
 * @returns true=退出码 0 / false=失败或被取消
 */
export async function runStreaming(
    command: string,
    cwdRel?: string,
    options?: { shell?: boolean },
): Promise<boolean> {
    const cwd = resolve(cwdRel ?? '.');
    if (!cwd) {return false;}
    logger.log(`$ ${command}` + (cwdRel ? `  (cwd: ${cwdRel})` : ''));

    // 拆出命令名和参数,给 spawn 用
    // 简单实现:把整串交给 shell 执行(Windows 默认 cmd,Unix 默认 /bin/sh)
    // 这样能正确处理带引号的路径,如 ".venv\Scripts\python.exe"
    return new Promise<boolean>(resolve => {
        const child = spawn(command, [], {
            cwd,
            shell: options?.shell ?? true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // stdout / stderr 实时打到输出面板
        const emitLine = (buf: Buffer) => {
            const text = buf.toString('utf8');
            // 按行分割,去掉末尾空行
            const lines = text.split(/\r?\n/);
            // 如果最后一行不完整(没换行符),保留它下次拼接
            // 简化处理:直接全打出去(pip 的进度条会用 \r 覆盖,看起来是连续刷新的)
            lines.forEach(l => {
                if (l.length > 0) {
                    logger.raw('  ' + l);
                }
            });
        };
        child.stdout?.on('data', emitLine);
        child.stderr?.on('data', emitLine);

        child.on('error', err => {
            logger.error(`无法启动命令: ${err.message}`);
            resolve(false);
        });
        child.on('close', code => {
            if (code === 0) {
                logger.log('  → 成功');
                resolve(true);
            } else {
                logger.error(`命令退出码: ${code}`);
                resolve(false);
            }
        });
    });
}

// ─── 文件系统操作(基于 Node 内置 API)──────────────────────

/** 删除文件或目录(递归 + 不存在也不报错) */
export function remove(relPath: string): boolean {
    const full = resolve(relPath);
    if (!full) {return false;}
    try {
        fs.rmSync(full, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

/** 移动/重命名(src 不存在或目标已存在会失败) */
export function move(srcRel: string, destRel: string): boolean {
    const src = resolve(srcRel);
    const dest = resolve(destRel);
    if (!src || !dest) {return false;}
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
        return true;
    } catch {
        return false;
    }
}

/** 列出某个目录下的子目录名(一层) */
export function listSubdirs(relPath: string): string[] {
    const full = resolve(relPath);
    if (!full) {return [];}
    try {
        return fs
            .readdirSync(full, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    } catch {
        return [];
    }
}

/**
 * 创建目录软链接(跨平台)
 *
 * targetRel 可以是相对路径(相对于 link 所在目录解析)或绝对路径
 *
 * 实现说明:
 *   - Linux/Mac:使用 'dir' 类型,原生支持相对路径
 *   - Windows:也使用 'dir' 类型(不用 junction)。junction 要求绝对路径,
 *     而且对相对路径会静默生成无效链接(表现为“一个快捷方式文件”)。
 *     'dir' 类型在 Windows 上需要开发者模式或管理员权限,但路径行为正确。
 */
export function createSymlink(targetRel: string, linkRel: string): boolean {
    const link = resolve(linkRel);
    if (!link) {return false;}
    // target 如果是相对路径,相对于 link 的父目录解析(和 ln -s 行为一致)
    let target: string;
    if (path.isAbsolute(targetRel)) {
        target = targetRel;
    } else {
        const root = getRoot();
        if (!root) {return false;}
        // path.join 会把 ../ 正确解析掉
        target = path.normalize(path.join(path.dirname(link), targetRel));
    }
    try {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        // 如果 link 已经存在(可能是上次失败的残留),先删掉
        try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
        fs.symlinkSync(target, link, 'dir');
        logger.log(`已创建软链接: ${link} → ${target}`);
        return true;
    } catch (e: any) {
        logger.error(`创建软链接失败: ${e.message}`);
        return false;
    }
}

// ─── 网络下载(基于 Node 18+ 的 fetch)─────────────────────

/**
 * 下载文件到工作区内相对路径(自动跟随重定向)
 *
 * @param url         下载地址
 * @param destRelPath 目标相对路径,如 '.tmp/skill.zip'
 */
export async function downloadFile(url: string, destRelPath: string): Promise<boolean> {
    const full = resolve(destRelPath);
    if (!full) {return false;}
    try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const res = await fetch(url, {
            headers: { 'User-Agent': 'astrbot-devkit-in-vscode' },
            redirect: 'follow',
        });
        if (!res.ok || !res.body) {
            logger.error(`HTTP ${res.status} ${res.statusText} ← ${url}`);
            // 对于 4xx/5xx,把响应体前 500 字符也打出来(GitHub API 错误会带 message 字段)
            try {
                const text = await res.text();
                if (text) {
                    logger.raw('── 响应内容(前 500 字符)──');
                    logger.raw(text.slice(0, 500));
                }
            } catch {}
            return false;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(full, buf);
        logger.log(`下载完成: ${buf.length} 字节 → ${destRelPath}`);
        return true;
    } catch (e: any) {
        logger.error(`下载异常(${url}): ${e?.message ?? e}`);
        return false;
    }
}

// ─── 解压(基于 adm-zip,跨平台纯 JS)──────────────────────

/**
 * 解压 zip 到目标目录(跨平台,无需 PowerShell/unzip)
 */
export function extractZip(zipRel: string, destRel: string): boolean {
    const zipPath = resolve(zipRel);
    const destPath = resolve(destRel);
    if (!zipPath || !destPath) {return false;}
    try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(destPath, true);   // true = overwrite
        return true;
    } catch {
        return false;
    }
}

// ─── GitHub release ──────────────────────────────────────

/** GitHub release 信息 */
export interface GitHubRelease {
    tagName: string;
    zipballUrl: string;
}

/**
 * 获取仓库最新 release 信息
 *
 * @param repo 'owner/repo',如 'xunxiing/AstrBot-Skill'
 * @returns 成功返回 release;失败(无 release/网络错误)返回 undefined
 */
export async function getLatestRelease(repo: string): Promise<GitHubRelease | undefined> {
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: {
                'User-Agent': 'astrbot-devkit-in-vscode',
                'Accept': 'application/vnd.github+json',
            },
        });
        if (!res.ok) {return undefined;}
        const json: any = await res.json();
        if (json.tag_name && json.zipball_url) {
            return { tagName: json.tag_name, zipballUrl: json.zipball_url };
        }
        return undefined;
    } catch {
        return undefined;
    }
}

// ─── 待实现 ──────────────────────────────────────────────

/** 我们需要检查设置,然后返回相应的内容 */
export async function CheckSettings() {
}
