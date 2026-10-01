// AskUserQuestion 轉送到 Discord 所需的純函式（不碰 Discord / 檔案系統，方便測試）。
import { randomBytes } from 'node:crypto';

export const newAskId = () => randomBytes(6).toString('hex');

export const buttonId = (id, qi, oi) => `ask:${id}:${qi}:${oi}`;

export function parseButtonId(s) {
    const m = /^ask:([0-9a-f]{12}):(\d+):(\d+)$/.exec(s ?? '');
    return m ? { id: m[1], q: Number(m[2]), o: Number(m[3]) } : null;
}

/** 訊息內 `ask: \`<id>\`` 標記，用來辨識「這是一則等待回答的問題」。 */
export function parseAskMarker(text) {
    const m = /ask:\s*`([0-9a-f]{12})`/.exec(text ?? '');
    return m ? m[1] : null;
}

/** 全部都是單選且數量在 Discord 按鈕限制內，才用按鈕；否則只能用回覆作答。 */
export function usesButtons(questions) {
    return questions.length > 0
        && questions.length <= 4
        && questions.every((q) => !q.multiSelect && (q.options?.length ?? 0) >= 1 && q.options.length <= 5);
}

export function isComplete(pending) {
    return pending.questions.every((_, i) => pending.answers?.[i] !== undefined);
}

/** hook 要回給 Claude Code 的 answers：{ 問題文字: 答案 }。 */
export function finalAnswers(pending) {
    const out = {};
    pending.questions.forEach((q, i) => { out[q.question] = pending.answers[i]; });
    return out;
}

/**
 * 解析使用者的回覆文字。每個問題一行（只有一題時整段文字視為該題答案）。
 * 一行若全是編號（可用 , 、 空白分隔）就對應成選項名稱，否則視為自由文字（Other）。
 * 格式不符回傳 null；成功回傳 { 題號: 答案 }。
 */
export function parseReplyAnswers(text, questions) {
    const raw = (text ?? '').trim();
    if (!raw) return null;
    const lines = questions.length === 1 ? [raw] : raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length !== questions.length) return null;
    const answers = {};
    for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const opts = q.options ?? [];
        if (/^\d+(\s*[,，、\s]\s*\d+)*$/.test(lines[i])) {
            const idxs = lines[i].split(/[,，、\s]+/).map(Number);
            if (idxs.some((n) => n < 1 || n > opts.length)) return null;
            if (idxs.length > 1 && !q.multiSelect) return null;
            answers[i] = idxs.map((n) => opts[n - 1].label).join(', ');
        } else {
            answers[i] = lines[i];
        }
    }
    return answers;
}

const HEADERS = {
    open: '**🙋 Claude 需要你確認（AskUserQuestion）**',
    done: '**✅ 已回答，已交回給電腦上的對話**',
    timeout: '**⏱️ 逾時，請回電腦上的對話框作答**',
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 產生 Discord 訊息內容與按鈕。標記放在最前面，避免超長被截斷。 */
export function renderAsk(pending, status = 'open') {
    const lines = [HEADERS[status] ?? HEADERS.open];
    if (pending.cwd) lines.push(`專案: \`${pending.cwd}\``);
    if (pending.session_id) lines.push(`session: \`${pending.session_id}\``);
    if (status === 'open') lines.push(`ask: \`${pending.id}\``);
    const buttons = status === 'open' && usesButtons(pending.questions);
    pending.questions.forEach((q, i) => {
        lines.push('', `**${i + 1}. ${clip(q.question ?? '', 300)}**`);
        (q.options ?? []).forEach((o, j) => {
            lines.push(`\`${j + 1}\` ${clip(o.label ?? '', 80)}${o.description ? `：${clip(o.description, 120)}` : ''}`);
        });
        const a = pending.answers?.[i];
        if (a !== undefined) lines.push(`→ ✅ ${clip(String(a), 200)}`);
    });
    if (status === 'open') {
        lines.push('', buttons
            ? '點按鈕作答，或**回覆**這則訊息（編號，或直接輸入文字）。'
            : '請**回覆**這則訊息作答：編號（多選用逗號，如 `1,3`）或直接輸入文字；多題時每題一行。');
    }
    const components = [];
    if (buttons) {
        pending.questions.forEach((q, i) => {
            if (pending.answers?.[i] !== undefined) return;
            components.push({
                type: 1,
                components: q.options.map((o, j) => ({
                    type: 2,
                    style: 2,
                    label: clip(`${j + 1}. ${o.label ?? ''}`, 80),
                    custom_id: buttonId(pending.id, i, j),
                })),
            });
        });
    }
    return { content: clip(lines.join('\n'), 1850), components };
}
