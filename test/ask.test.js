import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    newAskId, buttonId, parseButtonId, parseAskMarker, usesButtons,
    isComplete, finalAnswers, parseReplyAnswers, renderAsk,
} from '../lib/ask.js';
import { writePending, readPending, recordAnswers, removePending } from '../lib/pending.js';

const q1 = { question: '選哪個？', options: [{ label: 'A', description: '甲' }, { label: 'B' }] };
const q2 = { question: '多選', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] };
const mk = (questions) => ({ id: newAskId(), questions, answers: {}, session_id: 'abc12345-0000', cwd: '/p' });

test('buttonId 與 parseButtonId 互為反函式', () => {
    const id = newAskId();
    assert.deepEqual(parseButtonId(buttonId(id, 2, 3)), { id, q: 2, o: 3 });
    assert.equal(parseButtonId('foo'), null);
});

test('parseAskMarker', () => {
    assert.equal(parseAskMarker('x\nask: `0123456789ab`'), '0123456789ab');
    assert.equal(parseAskMarker('沒有'), null);
});

test('usesButtons：僅單選且在限制內', () => {
    assert.equal(usesButtons([q1]), true);
    assert.equal(usesButtons([q1, q2]), false);
    assert.equal(usesButtons([]), false);
    assert.equal(usesButtons([{ question: 'x', options: Array(6).fill({ label: 'a' }) }]), false);
});

test('parseReplyAnswers：編號、多選、自由文字', () => {
    assert.deepEqual(parseReplyAnswers('2', [q1]), { 0: 'B' });
    assert.deepEqual(parseReplyAnswers('我想要別的', [q1]), { 0: '我想要別的' });
    assert.deepEqual(parseReplyAnswers('1\n1,3', [q1, q2]), { 0: 'A', 1: 'X, Z' });
    assert.equal(parseReplyAnswers('9', [q1]), null); // 超出範圍
    assert.equal(parseReplyAnswers('1,2', [q1]), null); // 單選給多個
    assert.equal(parseReplyAnswers('1', [q1, q2]), null); // 行數與題數不符
    assert.equal(parseReplyAnswers('  ', [q1]), null);
});

test('isComplete / finalAnswers', () => {
    const p = mk([q1, q2]);
    assert.equal(isComplete(p), false);
    p.answers = { 0: 'A', 1: 'X, Y' };
    assert.equal(isComplete(p), true);
    assert.deepEqual(finalAnswers(p), { '選哪個？': 'A', 多選: 'X, Y' });
});

test('renderAsk：按鈕、已答題移除按鈕、標記在最前面', () => {
    const p = mk([q1, { question: '第二題', options: [{ label: 'P' }, { label: 'Q' }] }]);
    const open = renderAsk(p);
    assert.equal(open.components.length, 2);
    assert.equal(open.components[0].components[0].custom_id, buttonId(p.id, 0, 0));
    assert.equal(parseAskMarker(open.content), p.id);

    p.answers = { 0: 'A' };
    const half = renderAsk(p);
    assert.equal(half.components.length, 1);
    assert.match(half.content, /→ ✅ A/);

    const done = renderAsk({ ...p, answers: { 0: 'A', 1: 'P' } }, 'done');
    assert.equal(done.components.length, 0);
    assert.equal(parseAskMarker(done.content), null); // 結案後不再被當成待答問題
});

test('renderAsk：含多選時不出按鈕，只能回覆', () => {
    const r = renderAsk(mk([q1, q2]));
    assert.equal(r.components.length, 0);
    assert.match(r.content, /回覆/);
});

test('renderAsk：超長內容仍保留標記', () => {
    const big = { question: 'q'.repeat(5000), options: Array(5).fill({ label: 'l'.repeat(500), description: 'd'.repeat(500) }) };
    const r = renderAsk(mk([big, big, big]));
    assert.ok(r.content.length <= 1850);
    assert.ok(parseAskMarker(r.content));
});

test('pending 檔案讀寫', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pend-'));
    const p = mk([q1]);
    writePending(p, dir);
    assert.equal(readPending(p.id, dir).cwd, '/p');
    assert.deepEqual(recordAnswers(p.id, { 0: 'B' }, dir).answers, { 0: 'B' });
    assert.equal(recordAnswers('nope', { 0: 'B' }, dir), null);
    removePending(p.id, dir);
    assert.equal(readPending(p.id, dir), null);
});
