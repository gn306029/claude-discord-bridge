// bot.js 與 notify.js（hook）是不同行程，靠 pending/<id>.json 交換「問題」與「答案」。
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pending');

const file = (id, dir) => path.join(dir, `${id}.json`);

export function writePending(pending, dir = DEFAULT_DIR) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file(pending.id, dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(pending));
    renameSync(tmp, file(pending.id, dir)); // 原子替換，避免對方讀到寫一半的檔案
}

export function readPending(id, dir = DEFAULT_DIR) {
    try {
        return JSON.parse(readFileSync(file(id, dir), 'utf8'));
    } catch {
        return null;
    }
}

/** 記錄一題或多題的答案（answers: { 題號: 答案 }），回傳更新後的 pending；不存在回傳 null。 */
export function recordAnswers(id, answers, dir = DEFAULT_DIR) {
    const pending = readPending(id, dir);
    if (!pending) return null;
    pending.answers = { ...(pending.answers ?? {}), ...answers };
    writePending(pending, dir);
    return pending;
}

export function removePending(id, dir = DEFAULT_DIR) {
    try { unlinkSync(file(id, dir)); } catch { /* 已不存在 */ }
}
