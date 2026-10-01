import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelNameFor, parseSessionMarker, sessionFooter, normalizeList } from '../lib/bridge.js';
import { findSession } from '../lib/sessions.js';

test('channelNameFor 轉成合法頻道名稱', () => {
    assert.equal(channelNameFor('Leo-MacBook Pro.local'), 'claude-leo-macbook-pro-local');
    assert.equal(channelNameFor('家裡 PC'), 'claude-家裡-pc');
    assert.equal(channelNameFor('***'), 'claude-device');
});

test('parseSessionMarker 解析完整與短 id', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    assert.equal(parseSessionMarker(`✅ 完成\nsession: \`${id}\``), id);
    assert.equal(parseSessionMarker('session: `123e4567`'), '123e4567');
    assert.equal(parseSessionMarker('沒有標記'), null);
    assert.equal(parseSessionMarker(undefined), null);
});

test('sessionFooter 可被 parseSessionMarker 還原', () => {
    assert.equal(parseSessionMarker(sessionFooter('abcdef12-0000')), 'abcdef12-0000');
    assert.equal(sessionFooter(null), '');
});

test('normalizeList 相容舊格式', () => {
    assert.deepEqual(normalizeList(['a', { sessionId: 'b', cwd: '/x' }]), [
        { sessionId: 'a', cwd: null },
        { sessionId: 'b', cwd: '/x' },
    ]);
    assert.deepEqual(normalizeList(undefined), []);
});

test('findSession 以前綴找到 session 與 cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    mkdirSync(path.join(root, 'p1'));
    const id = '123e4567-e89b-12d3-a456-426614174000';
    writeFileSync(
        path.join(root, 'p1', `${id}.jsonl`),
        `${JSON.stringify({ cwd: '/work/app', message: { role: 'user', content: 'hi' } })}\n`,
    );
    assert.deepEqual(await findSession('123e4567', root), { sessionId: id, cwd: '/work/app' });
    assert.equal(await findSession('ffffffff', root), null);
    assert.equal(await findSession('123', root), null);
});
