// src/debug/protocol.ts
// DAP 类型与骨架:onDidSendMessage / respond / event / output。
// 业务子类(AstrBotDebugAdapter)实现 handleMessage 等具体协议命令。

import * as vscode from 'vscode';

/** DAP 请求(DebugProtocolMessage 的细分类型,vscode 命名空间未导出,本地定义) */
export interface DapRequest {
    seq: number;
    type: 'request';
    command: string;
    arguments?: unknown;
}

/** DAP 响应 */
export interface DapResponse {
    seq: number;
    type: 'response';
    request_seq: number;
    success: boolean;
    command: string;
    body?: unknown;
    message?: string;
}

/** DAP 事件 */
export interface DapEvent {
    seq: number;
    type: 'event';
    event: string;
    body?: unknown;
}

/** 写调试控制台一行的回调类型(供 push/logleak 复用) */
export type ConsoleWriter = (category: 'stdout' | 'stderr' | 'console', text: string) => void;

/** DAP 骨架:管理消息序列号、发送响应/事件/输出 */
export abstract class DapBase implements vscode.DebugAdapter {
    private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.sendEmitter.event;
    private seq = 0;

    /** 子类实现具体的协议命令分发 */
    abstract handleMessage(message: vscode.DebugProtocolMessage): void;

    dispose(): void {
        this.sendEmitter.dispose();
    }

    protected nextSeq(): number { return ++this.seq; }

    protected respond(
        request: DapRequest,
        body?: unknown,
        success = true,
        message = '',
    ): void {
        const resp: DapResponse = {
            type: 'response',
            seq: this.nextSeq(),
            request_seq: request.seq,
            success,
            command: request.command,
        };
        if (body !== undefined) {resp.body = body;}
        if (message) {resp.message = message;}
        this.sendEmitter.fire(resp);
    }

    protected event(event: string, body?: unknown): void {
        const e: DapEvent = {
            type: 'event',
            seq: this.nextSeq(),
            event,
        };
        if (body !== undefined) {e.body = body;}
        this.sendEmitter.fire(e);
    }

    /** 写一行到调试控制台(Debug Console) */
    protected output(category: 'stdout' | 'stderr' | 'console', text: string): void {
        this.event('output', { category, output: text });
    }
}
