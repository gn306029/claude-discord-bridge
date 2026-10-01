import { readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyTotals() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0 };
}

function addUsage(bucket, usage) {
  bucket.inputTokens += usage.input_tokens ?? 0;
  bucket.outputTokens += usage.output_tokens ?? 0;
  bucket.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  bucket.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  bucket.turns += 1;
}

/**
 * Best-effort local token usage tally, built the same way community tools
 * (e.g. phuryn/claude-usage) do it: by summing `message.usage` on every
 * assistant-type JSONL record under ~/.claude/projects/. This is NOT the
 * same as the account's official plan usage limit / remaining quota -
 * Claude Code exposes no scriptable way to query that. These are raw token
 * counts only, no cost estimate (we don't have reliable local pricing data
 * to avoid quoting a wrong dollar figure).
 */
export async function computeUsage() {
  const now = Date.now();
  const todayByModel = new Map();
  const allByModel = new Map();

  let projectDirs;
  try {
    projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PROJECTS_DIR, d.name));
  } catch {
    return { todayByModel, allByModel };
  }

  for (const dir of projectDirs) {
    let entries;
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      const isToday = now - stat.mtimeMs < DAY_MS;
      await scanFile(fullPath, isToday, todayByModel, allByModel);
    }
  }

  return { todayByModel, allByModel };
}

async function scanFile(filePath, isToday, todayByModel, allByModel) {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;
      const model = obj.message.model ?? 'unknown';
      if (!allByModel.has(model)) allByModel.set(model, emptyTotals());
      addUsage(allByModel.get(model), obj.message.usage);
      if (isToday) {
        if (!todayByModel.has(model)) todayByModel.set(model, emptyTotals());
        addUsage(todayByModel.get(model), obj.message.usage);
      }
    }
  } catch {
    // ignore unreadable/partial files - best effort only
  } finally {
    rl.close();
  }
}

export function formatUsageReport({ todayByModel, allByModel }) {
  const fmt = (n) => n.toLocaleString('en-US');
  const section = (title, byModel) => {
    if (byModel.size === 0) return `**${title}**\n（無資料）`;
    const lines = [...byModel.entries()].map(([model, t]) => {
      return `${model}: 輸入 ${fmt(t.inputTokens)} / 輸出 ${fmt(t.outputTokens)} / 快取寫入 ${fmt(t.cacheCreationTokens)} / 快取讀取 ${fmt(t.cacheReadTokens)}（${t.turns} 回合）`;
    });
    return `**${title}**\n${lines.join('\n')}`;
  };
  return [
    section('今日 (近 24 小時內修改過的 session)', todayByModel),
    section('累計 (本機所有 session)', allByModel),
    '',
    '⚠️ 這是從本機 session 紀錄檔加總的 token 數量估算，不是官方帳務/額度剩餘資料（Claude Code 目前沒有提供可腳本化查詢額度的方式）。',
  ].join('\n\n');
}
