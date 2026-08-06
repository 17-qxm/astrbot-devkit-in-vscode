// src/logger.ts
// 全局日志通道:extension.ts 在 activate 时调用 initLogger() 初始化,
// 之后 tool.ts / main.ts 都可以用 log() / show() / error() 写日志。

import * as vscode from 'vscode';

const CHANNEL_NAME = 'AstrBot DevKit';

let channel: vscode.OutputChannel | undefined;

/**
 * 初始化全局日志通道(由 extension.ts 的 activate 调用一次)
 *
 * @param context 扩展上下文,用于自动 dispose
 */
export function initLogger(context: vscode.ExtensionContext): void {
    if (channel) {
        return;     // 已初始化,防止重复
    }
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    context.subscriptions.push(channel);
}

/** 确保日志通道已初始化(未初始化时静默丢弃,不会抛错) */
function ensure(): vscode.OutputChannel | undefined {
    return channel;
}

/** 普通日志(带时间戳) */
export function log(message: string): void {
    const ch = ensure();
    if (!ch) {return;}
    const ts = new Date().toISOString().slice(11, 19);   // HH:MM:SS
    ch.appendLine(`[${ts}] ${message}`);
}

/** 错误日志(红色高亮 ERROR 前缀) */
export function error(message: string): void {
    const ch = ensure();
    if (!ch) {return;}
    const ts = new Date().toISOString().slice(11, 19);
    ch.appendLine(`[${ts}] ❌ ERROR: ${message}`);
}

/**
 * 写一行原始文本(不加时间戳前缀),用于打印命令输出等
 */
export function raw(text: string): void {
    ensure()?.appendLine(text);
}

/**
 * 在输出面板里画一条分隔线,方便区分多次运行
 */
export function separator(title = ''): void {
    ensure()?.appendLine('');
    ensure()?.appendLine(`──────────────────────────────────────────────${title ? '  ' + title : ''}`);
}

/**
 * 显示输出面板(等价于用户点"输出"标签选中本通道)
 *
 * @param preserveFocus true=不抢焦点(让用户继续看编辑器)
 */
export function show(preserveFocus = true): void {
    ensure()?.show(preserveFocus);
}

/**
 * 清空日志(通常在 InitEnv 开始时调用)
 */
export function clear(): void {
    ensure()?.clear();
}
