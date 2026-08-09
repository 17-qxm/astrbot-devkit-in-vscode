// src/config/validate.ts
// 配置校验与 v1→v2 迁移/规整。

import { CONFIG_VERSION } from '../constants.js';
import type { DebugSettings, DevKitConfig, PluginWorkspace } from './types.js';
import { DEFAULT_DEBUG } from './types.js';

/**
 * v1→v2 迁移:补齐 debug 块(默认值)、条目 active 字段,升级版本号。
 * 未知版本按 v2 处理。保证返回的对象字段齐全、可直接使用。
 */
export function normalizeConfig(raw: unknown): DevKitConfig {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const debugRaw = (obj.debug ?? {}) as Record<string, unknown>;
    const debug: DebugSettings = {
        stopAction: asEnum(debugRaw.stopAction, ['ask', 'disable', 'keep'], DEFAULT_DEBUG.stopAction),
        reloadAfterPush: asEnum(debugRaw.reloadAfterPush, ['ask', 'always', 'never'], DEFAULT_DEBUG.reloadAfterPush),
        receiveLogs: typeof debugRaw.receiveLogs === 'boolean' ? debugRaw.receiveLogs : DEFAULT_DEBUG.receiveLogs,
        reconnectLimit: typeof debugRaw.reconnectLimit === 'number' ? debugRaw.reconnectLimit : DEFAULT_DEBUG.reconnectLimit,
    };
    const ws = Array.isArray(obj.pluginWorkspaces) ? (obj.pluginWorkspaces as unknown[])
        .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
        .map(w => ({
            dir: String(w.dir ?? ''),
            name: String(w.name ?? ''),
            version: String(w.version ?? ''),
            active: typeof w.active === 'boolean' ? w.active : false,
        }))
        .filter(w => w.dir && w.name && w.version) as PluginWorkspace[]
        : [];
    return {
        version: CONFIG_VERSION,
        astrbotServer: typeof obj.astrbotServer === 'string' ? obj.astrbotServer : '',
        astrbotAPIkey: typeof obj.astrbotAPIkey === 'string' ? obj.astrbotAPIkey : '',
        autoConnect: typeof obj.autoConnect === 'boolean' ? obj.autoConnect : true,
        debug,
        pluginWorkspaces: ws,
    };
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback;
}

// ─── 校验 ────────────────────────────────────────────────

const SERVER_PATTERN = /^(https?:\/\/)?[a-zA-Z0-9.\-]+(:[0-9]+)?(\/.*)?$/;

/**
 * 校验配置,返回错误列表(空 = 合法)。规则见 design.md §5.4。
 */
export function validateConfig(config: DevKitConfig): string[] {
    const errors: string[] = [];
    if (!config.astrbotServer) {
        errors.push('astrbotServer 为空');
    } else if (!SERVER_PATTERN.test(config.astrbotServer)) {
        errors.push(`astrbotServer 格式不合法:${config.astrbotServer}(支持 host:port 或 http(s)://…)`);
    }
    // 注:TODO §15.5 提到 abk_ 前缀待真实服务器放宽,这里只在非空时做弱校验
    if (!config.astrbotAPIkey) {
        errors.push('astrbotAPIkey 为空,请在 AstrBot WebUI 创建 API Key');
    }
    if (config.debug.reconnectLimit < 0) {
        errors.push('debug.reconnectLimit 不能为负');
    }
    if (config.pluginWorkspaces) {
        const activeCount = config.pluginWorkspaces.filter(w => w.active).length;
        if (activeCount > 1) {
            errors.push(`pluginWorkspaces 中 active=true 的条目超过一个(${activeCount} 个),运行时将取第一个作为活跃插件`);
        }
        const names = config.pluginWorkspaces.map(w => w.name);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        if (dup.length) {
            errors.push(`pluginWorkspaces 存在重名插件:${[...new Set(dup)].join(', ')}`);
        }
    }
    return errors;
}
