#!/usr/bin/env node
// Invoked by Claude Code's `Notification` hook (see ~/.claude/settings.json).
// Reads the hook payload from stdin and forwards it to Discord. Runs async
// from the hook, so it must never block or throw in a way that affects the
// Claude Code session - always exit 0.
import { config } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newAskId, renderAsk, isComplete, finalAnswers } from './lib/ask.js';
import { writePending, readPending, removePending } from './lib/pending.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);
// 明確指定 .env 路徑：hook 的 cwd 是專案目錄，不能依賴 dotenv/config 的預設查找
config({ path: path.join(__dirname, '.env') });

const TOKEN = process.env.DISCORD_BOT_TOKEN;
// bot 啟動時會把本裝置專屬頻道寫進 state.json；讀不到才退回 .env 的備援頻道
const CHANNEL_ID = readBotState()._channel?.id ?? process.env.DISCORD_CHANNEL_ID;
const ASK_WAIT_SECONDS = Number(process.env.ASK_WAIT_SECONDS) || 300;
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();
const SKIP_TYPES = new Set(
  (process.env.NOTIFY_SKIP_TYPES ?? 'idle_prompt').split(',').map((s) => s.trim()).filter(Boolean),
);

const LABELS = {
  permission_prompt: '🔐 需要你確認（權限 / 計畫）',
  idle_prompt: '💤 Claude 已完成，等待你的輸入',
  quota_auto_resume_fired: '✅ 用量已重置，任務自動繼續',
  quota_auto_resume_stale: '⏸️ 用量已重置，但電腦睡眠過久，需要你手動按 Enter 繼續',
  quota_auto_resume_disabled: '⚠️ 等待用量重置結束，但未自動繼續',
  elicitation_dialog: '📝 MCP 需要你輸入資訊',
  elicitation_url_dialog: '📝 MCP 需要你開啟連結確認',
  agent_needs_input: '🙋 子代理需要輸入',
  agent_completed: '✅ 子代理已完成',
};

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // nothing usable
  }

  if (!TOKEN || !CHANNEL_ID) {
    console.error('[discord-bridge] DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID 未設定，跳過通知');
    return;
  }

  const hookEvent = payload.hook_event_name;

  // AskUserQuestion has no Notification-hook coverage upstream, so we
  // forward it from PreToolUse instead (settings.json only matches this
  // hook on tool_name === "AskUserQuestion").
  // 離開模式（Discord 的 !away on）：同步等待 Discord 作答並替 Claude Code 回答；
  // 否則只是通知，不攔截，選項照常顯示在電腦上。
  if (hookEvent === 'PreToolUse' && payload.tool_name === 'AskUserQuestion') {
    if (readBotState()._away === true) await askViaDiscord(payload);
    else await postToDiscord(formatAskUserQuestion(payload));
    return;
  }

  if (hookEvent === 'Stop') {
    await postToDiscord(formatStop(payload));
    return;
  }

  const type = payload.notification_type;
  if (type && SKIP_TYPES.has(type)) return;

  const label = LABELS[type] ?? `🔔 ${type ?? '通知'}`;
  const lines = [`**${label}**`];
  if (payload.message) lines.push(payload.message);
  if (payload.cwd) lines.push(`專案: \`${payload.cwd}\``);
  if (payload.session_id) lines.push(`session: \`${payload.session_id}\``);

  await postToDiscord(lines.join('\n'));
}

// bot 寫的 state.json：_channel（專屬頻道）與 _away（離開模式）
function readBotState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

// 把問題發到 Discord 並等待答案（按鈕或回覆，由 bot.js 寫入 pending 檔）。
// 有答案就輸出 hook 決定，讓 Claude Code 直接採用；逾時或失敗則什麼都不輸出，
// 交還給電腦上原本的選項對話框。
async function askViaDiscord(payload) {
  const questions = payload.tool_input?.questions ?? [];
  if (questions.length === 0) return;
  const pending = { id: newAskId(), questions, answers: {}, session_id: payload.session_id, cwd: payload.cwd };
  writePending(pending);
  const first = renderAsk(pending);
  const msg = await postToDiscord(first.content, first.components);
  if (!msg?.id) {
    removePending(pending.id);
    return;
  }
  const deadline = Date.now() + ASK_WAIT_SECONDS * 1000;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = readPending(pending.id);
      if (cur && isComplete(cur)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...payload.tool_input, answers: finalAnswers(cur) },
          },
        }));
        return;
      }
    }
    const final = renderAsk(readPending(pending.id) ?? pending, 'timeout');
    await editDiscord(msg.id, final.content, final.components);
  } finally {
    removePending(pending.id);
  }
}

function formatAskUserQuestion(payload) {
  const questions = payload.tool_input?.questions ?? [];
  const lines = ['**🙋 Claude 需要你確認（AskUserQuestion）**'];
  if (payload.cwd) lines.push(`專案: \`${payload.cwd}\``);
  for (const q of questions) {
    lines.push(`\n**${q.question ?? ''}**`);
    for (const opt of q.options ?? []) {
      lines.push(`- ${opt.label}${opt.description ? `：${opt.description}` : ''}`);
    }
  }
  if (questions.length === 0) lines.push('（無法解析問題內容，請回到終端機查看）');
  if (payload.session_id) lines.push(`session: \`${payload.session_id}\``);
  return lines.join('\n');
}

function formatStop(payload) {
  const lines = ['**✅ Claude 已完成這輪工作**'];
  if (payload.cwd) lines.push(`專案: \`${payload.cwd}\``);
  if (payload.session_id) lines.push(`session: \`${payload.session_id}\``);
  const summary = getLastAssistantText(payload);
  if (summary) {
    const max = 1900 - lines.join('\n').length - DEVICE_NAME.length - 40;
    lines.push('', summary.length > max ? `${summary.slice(0, max)}…` : summary);
  }
  return lines.join('\n');
}

// Stop payload carries last_assistant_message on recent Claude Code versions;
// fall back to scanning the transcript JSONL for the last assistant text.
function getLastAssistantText(payload) {
  if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
    return payload.last_assistant_message.trim();
  }
  try {
    if (!payload.transcript_path) return '';
    const rows = fs.readFileSync(payload.transcript_path, 'utf8').split('\n');
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(rows[i]); } catch { continue; }
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        : typeof content === 'string' ? content.trim() : '';
      if (text) return text;
    }
  } catch {
    // transcript unreadable - send notification without summary
  }
  return '';
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    // 讀完就清掉保險計時器，否則同步 hook 每次都要白等 5 秒才結束
    const guard = setTimeout(() => resolve(data), 5000); // never hang waiting on stdin
    const finish = () => { clearTimeout(guard); resolve(data); };
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// 回傳 Discord 訊息物件（失敗回傳 null）。components 為按鈕列。
function postToDiscord(content, components) {
  return callDiscord('POST', `/channels/${CHANNEL_ID}/messages`, content, components);
}

function editDiscord(messageId, content, components) {
  return callDiscord('PATCH', `/channels/${CHANNEL_ID}/messages/${messageId}`, content, components);
}

async function callDiscord(method, apiPath, content, components) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const body = { content: `🖥️ **[${DEVICE_NAME}]**\n${content}`.slice(0, 1900) };
    if (components) body.components = components;
    const res = await fetch(`https://discord.com/api/v10${apiPath}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('[discord-bridge] Discord API error', res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('[discord-bridge] failed to post notification', err?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  console.error('[discord-bridge] notify.js unexpected error', err?.message ?? err);
});
