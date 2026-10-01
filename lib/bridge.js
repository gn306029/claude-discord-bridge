// 不依賴 Discord / 檔案系統的純函式，方便單元測試。

/** 裝置名稱 -> 頻道名稱（Discord 允許各語言的字母與數字，其餘轉成 -）。 */
export function channelNameFor(deviceName) {
    const slug = String(deviceName).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return `claude-${slug || 'device'}`;
}

/** 從訊息文字中取出 `session: \`<id>\``，回傳 id（或前綴），找不到回傳 null。 */
export function parseSessionMarker(text) {
    const m = /session:\s*`([0-9a-f-]{8,36})`/i.exec(text ?? '');
    return m ? m[1].toLowerCase() : null;
}

export function sessionFooter(sessionId) {
    return sessionId ? `\nsession: \`${sessionId}\`` : '';
}

/** `lastList` 舊格式是 sessionId 字串陣列，新格式是 {sessionId, cwd}。 */
export function normalizeList(list) {
    return (list ?? []).map((e) => (typeof e === 'string' ? { sessionId: e, cwd: null } : e));
}
