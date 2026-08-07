// src/api/client.ts
// AstrBot OpenAPI 客户端基座。
// 负责:base URL 规范化、统一鉴权(Bearer)、超时、SuccessEnvelope 解包、错误分类。
// 见 design.md §6.1 与 implementation.md §3。

import * as vscode from 'vscode';
import * as logger from '../logger.js';
import type { DevKitConfig } from '../config.js';
import { REQUEST_TIMEOUT_MS, PROBE_TIMEOUT_MS } from '../constants.js';

// ─── 类型 ────────────────────────────────────────────────

export type ConnectionState = 'unconfigured' | 'checking' | 'connected' | 'error';

export type ApiErrorKind =
    | 'UNAUTHORIZED'      // 401:API Key 无效或已撤销
    | 'FORBIDDEN'         // 403:scope 不足
    | 'NOT_FOUND'         // 404
    | 'TIMEOUT'           // 请求超时
    | 'SERVER_ERROR'      // 5xx / 网络异常(ECONNREFUSED 等)
    | 'INVALID_RESPONSE'; // SuccessEnvelope 解包失败

export class ApiError extends Error {
    readonly kind: ApiErrorKind;
    readonly status?: number;
    constructor(kind: ApiErrorKind, message: string, status?: number) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = status;
    }
}

/** AstrBot 统一响应包装(见 design.md §4.1) */
interface SuccessEnvelope {
    status: 'ok' | 'error';
    message: string;
    data?: unknown;
}

export interface AstrBotClient {
    readonly state: ConnectionState;
    /** 规范化后的 base URL,如 http://127.0.0.1:6185 */
    readonly baseUrl: string;
    readonly config: DevKitConfig;
    /** 状态变化回调(供侧边栏刷新) */
    onStateChange: vscode.Event<ConnectionState>;

    /** 探活:GET /api/v1/plugins,成功置 connected;失败置 error 并抛 ApiError */
    connect(timeoutMs?: number): Promise<void>;
    /** 本地置 unconfigured/error,不发请求 */
    disconnect(): void;

    /** 统一请求:拼 baseUrl + path,带 Bearer,解包 SuccessEnvelope */
    request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
    /** multipart 上传 zip:POST /api/v1/plugins/install/upload,字段名 file */
    uploadZip(zipBuffer: Buffer, filename: string): Promise<Record<string, unknown>>;
    /** 配置重建时调用:退役后的状态变化不再对外生效(避免旧配置的连接结果干扰 UI) */
    retire(): void;
}

// ─── base URL 规范化 ─────────────────────────────────────

/**
 * 把 astrbotServer 规范化为完整 URL:
 *   - host:port        → http://host:port
 *   - http(s)://...    → 原样,去末尾 /
 * 非法输入(如空串)抛错。
 */
export function normalizeBaseUrl(server: string): string {
    const s = server.trim();
    if (!s) {throw new ApiError('INVALID_RESPONSE', '服务器地址为空');}
    let url = s;
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
    }
    // 去末尾斜杠(保留协议中的 //)
    while (url.length > 1 && url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    return url;
}

// ─── 实现 ────────────────────────────────────────────────

export function createClient(
    config: DevKitConfig,
    onStateChange?: (s: ConnectionState) => void,
): AstrBotClient {
    const emitter = new vscode.EventEmitter<ConnectionState>();
    let state: ConnectionState = 'unconfigured';
    let retired = false;
    let pendingConnect: Promise<void> | undefined;

    const setState = (s: ConnectionState) => {
        if (retired) {return;}
        if (s === state) {return;}
        state = s;
        emitter.fire(s);
        onStateChange?.(s);
    };

    const baseUrl = (() => {
        try { return normalizeBaseUrl(config.astrbotServer); }
        catch { return ''; }
    })();

    const doRequest = async <T>(
        path: string,
        init: RequestInit = {},
        timeoutMs = REQUEST_TIMEOUT_MS,
    ): Promise<T> => {
        if (!baseUrl) {
            throw new ApiError('INVALID_RESPONSE', '服务器地址未配置或非法');
        }
        const ac = new AbortController();
        // timeoutMs <= 0 表示不设超时(如大文件上传);否则按指定毫秒数中止
        const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
        const headers = new Headers(init.headers);
        // 默认带 Bearer;调用方也可显式覆盖(日志流 relay 走独立 fetch,不走这里)
        if (!headers.has('Authorization') && config.astrbotAPIkey) {
            headers.set('Authorization', `Bearer ${config.astrbotAPIkey}`);
        }
        try {
            const resp = await fetch(baseUrl + path, { ...init, headers, signal: ac.signal });
            return await unwrap<T>(resp);
        } catch (e) {
            if (e instanceof ApiError) {throw e;}
            if ((e as Error)?.name === 'AbortError') {
                throw new ApiError('TIMEOUT', `请求超时(${timeoutMs}ms):${path}`);
            }
            // fetch 网络层错误:DNS 失败、ECONNREFUSED、服务器未启动
            const msg = (e as Error)?.message ?? String(e);
            throw new ApiError('SERVER_ERROR', friendlyNetworkError(msg, baseUrl));
        } finally {
            if (timer) {clearTimeout(timer);}
        }
    };

    return {
        get state() { return state; },
        get baseUrl() { return baseUrl; },
        config,
        onStateChange: emitter.event,

        /** 配置重建后调用:旧 client 的连接结果不再更新状态/UI */
        retire(): void {
            retired = true;
        },

        async connect(timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
            if (!baseUrl) {
                setState('unconfigured');
                throw new ApiError('INVALID_RESPONSE', '服务器地址未配置或非法');
            }
            // 已连接则直接返回;并发调用复用同一个进行中的连接,避免重复请求/通知
            if (state === 'connected') {return;}
            if (pendingConnect) {return pendingConnect;}
            setState('checking');
            pendingConnect = (async () => {
                await doRequest<unknown>('/api/v1/plugins?include_reserved=false', { method: 'GET' }, timeoutMs);
                setState('connected');
                logger.log(`已连接 AstrBot 服务器:${baseUrl}`);
            })().catch(e => {
                setState('error');
                throw e;
            }).finally(() => {
                pendingConnect = undefined;
            });
            return pendingConnect;
        },

        disconnect() {
            setState('unconfigured');
        },

        request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
            return doRequest<T>(path, init ?? {}, timeoutMs);
        },

        async uploadZip(zipBuffer: Buffer, filename: string): Promise<Record<string, unknown>> {
            const fd = new FormData();
            fd.append('file', new Blob([zipBuffer]), filename);
            // multipart 不手动设 Content-Type,交给 fetch 自动带 boundary
            return doRequest<Record<string, unknown>>(
                '/api/v1/plugins/install/upload',
                { method: 'POST', body: fd },
                0,   // 上传可能较慢,关闭超时
            );
        },
    };
}

// ─── 解包 ────────────────────────────────────────────────

async function unwrap<T>(resp: Response): Promise<T> {
    const status = resp.status;
    // 非 2xx:根据状态码分类抛错(优先返回服务器 message)
    if (status === 401) {throw await failFromResponse(resp, 'UNAUTHORIZED', 'API Key 无效或已撤销');}
    if (status === 403) {throw await failFromResponse(resp, 'FORBIDDEN', 'scope 不足,请在 WebUI 给 Key 添加相应权限');}
    if (status === 404) {throw await failFromResponse(resp, 'NOT_FOUND', '资源不存在(端点可能不被此 AstrBot 版本支持)');}
    if (status >= 500) {throw await failFromResponse(resp, 'SERVER_ERROR', `服务器错误(${status})`);}
    if (status >= 400) {throw await failFromResponse(resp, 'INVALID_RESPONSE', `请求失败(${status})`);}

    // 2xx:解包 SuccessEnvelope
    let body: unknown;
    try {
        body = await resp.json();
    } catch {
        // 部分端点可能返回非 JSON(如 204);宽松处理为空数据
        return undefined as T;
    }
    // 兼容:有时 data 直接就是结果(无包装)。识别包装要看是否含 status 字段且为字符串。
    if (body && typeof body === 'object' && 'status' in body) {
        const env = body as SuccessEnvelope;
        if (env.status === 'ok') {
            return env.data as T;
        }
        const msg = env.message || '服务器返回错误状态';
        throw new ApiError('INVALID_RESPONSE', msg, status);
    }
    // 无包装:原样返回
    return body as T;
}

async function failFromResponse(resp: Response, kind: ApiErrorKind, fallback: string): Promise<never> {
    let msg = fallback;
    try {
        const body = await resp.json() as SuccessEnvelope | { detail?: string; message?: string };
        const m = (body && typeof body === 'object') ?
            ((body as SuccessEnvelope).message ?? (body as { detail?: string }).detail) : undefined;
        if (m) {msg = m;}
    } catch {}
    throw new ApiError(kind, msg, resp.status);
}

/** 把 fetch 的原始网络错误信息转成人话,便于在通知里给出可操作建议 */
function friendlyNetworkError(msg: string, baseUrl: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('econnrefused') || lower.includes('connect econnrefused')) {
        return `无法连接到服务器 ${baseUrl}(服务器可能未启动)`;
    }
    if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
        return `域名解析失败:${baseUrl}(地址可能有误)`;
    }
    if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('self-signed')) {
        return `SSL 证书校验失败:${baseUrl}(自签证书场景请确认服务器 TLS 配置)`;
    }
    return msg;
}

/** 把 ApiError 转成给用户看的提示文案 */
export function describeApiError(e: unknown): string {
    if (e instanceof ApiError) {
        return `[${e.kind}] ${e.message}`;
    }
    return (e as Error)?.message ?? String(e);
}
