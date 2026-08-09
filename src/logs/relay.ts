// src/logs/relay.ts
// SSE 日志客户端:连接 logleak 插件的 stream 端点,把服务器日志写入
// 独立的「AstrBot Server」OutputChannel。由侧边栏「接收服务器日志」开关
// 独立控制(现在是否接收),调试会话可顺带启动。见 implementation.md §9。
//
// 不引入额外依赖,用 Node 18+ 原生 fetch 流式读取。

import * as vscode from 'vscode';
import type { AstrBotClient } from '../api/client.js';
import {
    LOGLEAK_SSE_ROUTE,
    SSE_IDLE_TIMEOUT_MS, SSE_RECONNECT_BACKOFF_MS, OUTPUT_CHANNEL_SERVER,
} from '../constants.js';
import * as logger from '../logger.js';

/** 一条服务器日志事件(SSE data 的 JSON) */
interface LogEvent {
    ts?: string;
    level?: string;
    logger?: string;
    message: string;
    /** 心跳事件 */
    type?: string;
}

/**
 * SSE 日志中继器。生命周期:
 *   - start():清空通道 → 连接 SSE → 持续写入
 *   - 断线:按 SSE_RECONNECT_BACKOFF_MS 退避重连,上限由 config.debug.reconnectLimit
 *   - stop():AbortController 终止,停止重连,通道内容保留
 */
export class LogRelay {
    private abort?: AbortController;
    private reconnectTimer?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private reconnectCount = 0;
    private running = false;
    private readonly channel: vscode.OutputChannel;

    constructor(
        private readonly client: AstrBotClient,
        channel?: vscode.OutputChannel,
    ) {
        this.channel = channel ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_SERVER);
    }

    get isRunning(): boolean { return this.running; }

    /** 获取关联的输出通道(extension 注册 OpenServerLogs 命令时复用) */
    get outputChannel(): vscode.OutputChannel { return this.channel; }

    /**
     * 启动日志流:清空通道并弹出,连接 SSE。
     * @param clearFirst 是否先清空通道历史(默认 true;侧边栏开关开启时传 false 保留历史)
     * @returns true=已启动;false=连接失败(鉴权失败/插件未就绪)
     */
    async start(clearFirst = true): Promise<boolean> {
        // 先停掉可能存在的旧会话
        this.stopInternal(false);

        this.running = true;
        this.reconnectCount = 0;
        if (clearFirst) {this.channel.clear();}
        this.channel.appendLine(`── AstrBot 服务器日志(${this.client.baseUrl})──`);
        this.channel.show(true);
        logger.log('启动 SSE 日志流');

        // 先同步探测首次连接:成功打开才返回 true,失败如实返回 false(后台会自动重连,可能自愈)
        const reader = await this.openStream();
        if (!this.running) {return false;}
        if (!reader) {
            void this.connectLoop();
            return false;
        }
        this.reconnectCount = 0;
        // 读取交给后台;流断开后由重连循环接管
        void this.readLoop(reader).then(() => {
            if (this.running) {
                void this.connectLoop();
            }
        });
        return true;
    }

    /** 断开 SSE,停止重连;通道内容保留不清除 */
    stop(): void {
        this.stopInternal(true);
    }

    /** dispose:停止一切并释放通道 */
    dispose(): void {
        this.stopInternal(true);
        this.channel.dispose();
    }

    // ─── 内部 ────────────────────────────────────────────

    private stopInternal(announce: boolean): void {
        this.running = false;
        if (this.abort) {
            try { this.abort.abort(); } catch {}
            this.abort = undefined;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        if (announce) {
            logger.log('停止 SSE 日志流');
        }
    }

    /** 连接 + 自动重连循环 */
    private async connectLoop(): Promise<void> {
        const limit = this.client.config.debug.reconnectLimit;
        while (this.running) {
            const ok = await this.connectOnce();
            if (!this.running) {break;}
            if (ok) {
                // 成功建立过连接(收到过数据)后断开:连续失败计数清零,继续重连。
                // 语义:reconnectLimit = 连续建连失败次数上限(默认 5);
                // 服务端正常关流(如插件 reload)不会计入失败。
                this.reconnectCount = 0;
            }
            if (this.reconnectCount >= limit) {
                this.channel.appendLine('⚠️ 日志连接已断开,已达重连上限,请重新 Debug');
                logger.error('日志重连达上限,停止');
                this.running = false;
                break;
            }
            const backoff = SSE_RECONNECT_BACKOFF_MS[
                Math.min(this.reconnectCount, SSE_RECONNECT_BACKOFF_MS.length - 1)
            ];
            this.channel.appendLine(`⚠️ 连接断开,${Math.round(backoff / 1000)} 秒后重连…(第 ${this.reconnectCount + 1}/${limit} 次)`);
            this.reconnectCount++;
            // 延迟重连,期间可被 stop 中断
            await this.delay(backoff);
        }
    }

    /** 单次连接:返回是否成功建立了连接(收到过数据则算连接成功) */
    private async connectOnce(): Promise<boolean> {
        const reader = await this.openStream();
        if (!reader) {return false;}
        // 流已打开:阻塞读取直到断开(空闲超时/服务端关闭/stop 均在此结束)
        await this.readLoop(reader);
        return true;
    }

    /**
     * 打开 SSE 流(fetch 成功且响应正常)。
     * 返回 reader 表示可读取;失败返回 undefined(原因已写入日志通道)。
     */
    private async openStream(): Promise<ReadableStreamDefaultReader<Uint8Array> | undefined> {
        const url = this.client.baseUrl + LOGLEAK_SSE_ROUTE;
        this.abort = new AbortController();
        try {
            const resp = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/event-stream',
                    // v0.2.0 起:全局鉴权接管,只需 OpenAPI 的 Bearer key
                    'Authorization': `Bearer ${this.client.config.astrbotAPIkey}`,
                },
                signal: this.abort.signal,
            });
            if (!resp.ok || !resp.body) {
                const hint = resp.status === 401
                    ? 'AstrBot API Key(astrbotAPIkey)不匹配或缺失'
                    : resp.status === 404
                        ? '日志投射插件未安装或 AstrBot 版本过低(需 v4.24+)'
                        : `HTTP ${resp.status} ${resp.statusText}`;
                this.channel.appendLine(`⚠️ 日志连接失败:${hint}`);
                return undefined;
            }
            return resp.body.getReader();
        } catch (e) {
            if (!this.running) {return undefined;}
            const name = (e as Error)?.name;
            if (name === 'AbortError') {return undefined;}
            this.channel.appendLine(`⚠️ 日志连接异常:${(e as Error)?.message ?? e}`);
            return undefined;
        }
    }

    /** 持续读取已打开的流,直到断开/被停止;结束前清理空闲定时器 */
    private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
        const decoder = new TextDecoder();
        let buffer = '';
        this.resetIdleTimer();
        try {
            while (this.running) {
                const { done, value } = await reader.read();
                if (done) {break;}
                buffer += decoder.decode(value, { stream: true });
                // SSE 以空行分隔事件;按 \n\n 切(也兼容 \r\n\r\n)
                let sep: number;
                while ((sep = this.findEventBoundary(buffer)) >= 0) {
                    const rawEvent = buffer.slice(0, sep);
                    buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
                    this.handleEvent(rawEvent);
                    this.resetIdleTimer();
                }
            }
        } catch (e) {
            if (this.running && (e as Error)?.name !== 'AbortError') {
                this.channel.appendLine(`⚠️ 日志读取异常:${(e as Error)?.message ?? e}`);
            }
        } finally {
            if (this.idleTimer) {clearTimeout(this.idleTimer); this.idleTimer = undefined;}
        }
    }

    /** 找到事件边界(\n\n 或 \r\n\r\n)的位置,无则 -1 */
    private findEventBoundary(buf: string): number {
        const i = buf.search(/\r?\n\r?\n/);
        return i;
    }

    /** 解析并输出一条 SSE 事件 */
    private handleEvent(rawEvent: string): void {
        // 取所有 data: 行拼接(SSE 规范:多个 data: 行用 \n 连接)
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
            const m = /^data:\s?(.*)$/.exec(line);
            if (m) {dataLines.push(m[1]);}
        }
        if (dataLines.length === 0) {return;}
        const payload = dataLines.join('\n');
        let evt: LogEvent;
        try {
            evt = JSON.parse(payload);
        } catch {
            // 非 JSON:data 原样输出一行
            this.channel.appendLine(payload);
            return;
        }
        // 心跳
        if (evt.type === 'ping') {return;}
        this.writeEvent(evt);
    }

    /** 按 AstrBot 日志格式输出:[HH:MM:SS] [LEVEL] logger message */
    private writeEvent(evt: LogEvent): void {
        const ts = evt.ts ? this.formatTs(evt.ts) : this.nowTs();
        const level = (evt.level ?? 'INFO').padEnd(5);
        const loggerName = evt.logger ?? '';
        const prefix = loggerName ? `[${ts}] [${level}] ${loggerName}` : `[${ts}] [${level}]`;
        // message 可能多行:首行带前缀,后续行原样
        const lines = (evt.message ?? '').split(/\r?\n/);
        if (lines.length <= 1) {
            this.channel.appendLine(`${prefix} ${lines[0] ?? ''}`);
        } else {
            this.channel.appendLine(`${prefix} ${lines[0]}`);
            for (let i = 1; i < lines.length; i++) {
                this.channel.appendLine(lines[i]);
            }
        }
    }

    private nowTs(): string {
        return new Date().toISOString().slice(11, 19);   // HH:MM:SS
    }

    private formatTs(iso: string): string {
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) {return iso;}
            return d.toTimeString().slice(0, 8);
        } catch {
            return iso;
        }
    }

    /** 重置空闲超时定时器:超时则主动断开当前连接,触发重连 */
    private resetIdleTimer(): void {
        if (this.idleTimer) {clearTimeout(this.idleTimer);}
        this.idleTimer = setTimeout(() => {
            if (this.running) {
                this.channel.appendLine('⚠️ 60 秒未收到数据,判定为断线,尝试重连…');
                if (this.abort) {try { this.abort.abort(); } catch {}}
            }
        }, SSE_IDLE_TIMEOUT_MS);
    }

    private delay(ms: number): Promise<void> {
        return new Promise<void>(resolve => {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                resolve();
            }, ms);
        });
    }
}
