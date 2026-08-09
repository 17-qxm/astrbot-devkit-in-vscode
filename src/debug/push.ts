// src/debug/push.ts
// 插件打包(打 zip)与上传(含同名插件先删后装的兜底重试)。

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import type { AstrBotClient } from '../api/client.js';
import { describeApiError } from '../api/client.js';
import {
    uploadPluginZip, deletePlugin, resolvePluginId,
} from '../api/plugins.js';
import { getWorkspaceRoot } from '../config/index.js';
import { ZIP_EXCLUDE } from '../constants.js';
import type { PluginWorkspace } from '../config/index.js';
import * as logger from '../logger.js';
import type { ConsoleWriter } from './protocol.js';

/** 打包插件目录为 zip Buffer,并落盘到 .tmp/{name}.zip */
export async function packagePlugin(workspace: PluginWorkspace): Promise<Buffer> {
    const root = getWorkspaceRoot();
    if (!root) {throw new Error('未打开工作区');}
    const dirAbs = path.isAbsolute(workspace.dir)
        ? workspace.dir
        : path.join(root, workspace.dir);
    if (!fs.existsSync(path.join(dirAbs, 'metadata.yaml'))) {
        throw new Error(`${workspace.dir} 不是插件根(缺少 metadata.yaml)`);
    }
    const tmpDir = path.join(root, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, `${workspace.name}.zip`);
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    const zip = new AdmZip();
    addDirToZip(zip, dirAbs, '');
    const buf = zip.toBuffer();
    fs.writeFileSync(zipPath, buf);
    return buf;
}

function addDirToZip(zip: AdmZip, dirAbs: string, relInZip: string): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {return;}
    for (const e of entries) {
        if (isExcluded(e.name, e.isDirectory())) {continue;}
        const full = path.join(dirAbs, e.name);
        const zipPath = relInZip ? `${relInZip}/${e.name}` : e.name;
        if (e.isDirectory()) {
            addDirToZip(zip, full, zipPath);
        } else if (e.isFile()) {
            zip.addLocalFile(full, relInZip);
        }
    }
}

function isExcluded(name: string, isDir: boolean): boolean {
    for (const rule of ZIP_EXCLUDE) {
        if (rule.endsWith('.pyc')) {
            if (!isDir && name.endsWith('.pyc')) {return true;}
        } else if (rule.includes('*')) {
            const re = new RegExp('^' + rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
            if (re.test(name)) {return true;}
        } else {
            if (name === rule) {return true;}
        }
    }
    return false;
}

/**
 * 上传 zip。
 * - 上传前主动检查服务器是否已有同名插件,有则先删除再上传
 *   (AstrBot 对已存在目录会报「安装失败:目录已存在」);
 * - 上传仍失败时再做一次兜底:重新查找同名插件,有则删除重试。
 */
export async function pushPlugin(
    client: AstrBotClient,
    zip: Buffer,
    filename: string,
    pluginName: string,
    write: ConsoleWriter,
): Promise<{ plugin_id?: string; [k: string]: unknown }> {
    // 上传前:同名插件已存在则先删除(覆盖安装 = 先删后装)
    const preExisting = await resolvePluginId(client, pluginName);
    if (preExisting) {
        write('console',
            `检测到同名插件 ${pluginName}(id=${preExisting}),删除后重新安装…\n`);
        await deletePlugin(client, preExisting);
    }
    try {
        return await uploadPluginZip(client, zip, filename);
    } catch (e) {
        const msg = describeApiError(e);
        logger.log(`安装失败(${msg}),做最后一次兜底重试…`);
        write('stderr', `⚠️ 安装失败:${msg},尝试删除残留同名插件后重试…\n`);
        const pluginId = await resolvePluginId(client, pluginName);
        if (!pluginId) {
            write('stderr', '服务器上未找到同名插件,保留原错误\n');
            throw e;
        }
        write('console', `重试:删除同名插件 ${pluginName}(id=${pluginId})后重新上传…\n`);
        await deletePlugin(client, pluginId);
        return await uploadPluginZip(client, zip, filename);
    }
}
