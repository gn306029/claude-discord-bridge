#!/usr/bin/env node
// Invoked by Claude Code's `Notification` hook (see ~/.claude/settings.json).
// Reads the hook payload from stdin and forwards it to Discord. Runs async
// from the hook, so it must never block or throw in a way that affects the
// Claude Code session - always exit 0.
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);
// 明確指定 .env 路徑：hook 的 cwd 是專案目錄，不能依賴 dotenv/config 的預設查找
config({ path: path.join(__dirname, '.env') });

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
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
  // hook on tool_name === "AskUserQuestion" - never block/alter the tool).
  if (hookEvent === 'PreToolUse' && payload.tool_name === 'AskUserQuestion') {
    await postToDiscord(formatAskUserQuestion(payload));
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
  if (payload.session_id) lines.push(`session: \`${payload.session_id.slice(0, 8)}\``);

  await postToDiscord(lines.join('\n'));
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
  return lines.join('\n');
}

function formatStop(payload) {
  const lines = ['**✅ Claude 已完成這輪工作**'];
  if (payload.cwd) lines.push(`專案: \`${payload.cwd}\``);
  if (payload.session_id) lines.push(`session: \`${payload.session_id.slice(0, 8)}\``);
  return lines.join('\n');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 5000); // never hang waiting on stdin
  });
}

async function postToDiscord(content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('[discord-bridge] Discord API error', res.status, await res.text());
    }
  } catch (err) {
    console.error('[discord-bridge] failed to post notification', err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  console.error('[discord-bridge] notify.js unexpected error', err?.message ?? err);
});
