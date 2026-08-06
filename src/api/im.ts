// src/api/im.ts
// 消息推送 API:POST /api/v1/im/messages、GET /api/v1/im/bots。
// 见 implementation.md §5 与 design.md §4.2。

import type { AstrBotClient } from './client.js';

/** 消息段类型(复用官方 type 枚举) */
export interface MessageSegment {
    type: 'plain' | 'reply' | 'image' | 'record' | 'file' | 'video';
    /** plain 文本 */
    text?: string;
    /** image/record/file/video 的附件 ID */
    attachment_id?: string;
    /** reply 的原消息 ID */
    message_id?: string;
    /** reply 的引用文本 */
    selected_text?: string;
    [k: string]: unknown;
}

export interface UmoInfo {
    id: string;
    [k: string]: unknown;
}

/**
 * POST /api/v1/im/messages。
 * message 支持纯文本字符串或消息段数组。
 */
export async function sendMessage(
    client: AstrBotClient,
    umo: string,
    message: string | MessageSegment[],
): Promise<void> {
    await client.request<unknown>(
        '/api/v1/im/messages',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ umo, message }),
        },
    );
}

/** GET /api/v1/im/bots — 列出可用平台/UMO,供命令里提供选择 */
export async function listBots(client: AstrBotClient): Promise<UmoInfo[]> {
    const data = await client.request<UmoInfo[] | { bots?: UmoInfo[] }>(
        '/api/v1/im/bots',
    );
    return Array.isArray(data) ? data : (data?.bots ?? []);
}
