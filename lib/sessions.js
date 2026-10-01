import { readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// The JSONL transcript format is internal to Claude Code and can change
// between versions, so every line parse here is best-effort and must
// never throw - a summary is a convenience, not something to depend on.
async function peekSummary(filePath) {
  const result = { cwd: null, snippet: null };
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
  let lines = 0;
  try {
    for await (const line of rl) {
      lines += 1;
      if (lines > 40) break;
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!result.cwd && typeof obj.cwd === 'string') {
        result.cwd = obj.cwd;
      }
      if (!result.snippet) {
        const role = obj.message?.role ?? obj.role ?? obj.type;
        const content = obj.message?.content ?? obj.content;
        if (role === 'user' && content) {
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.find((c) => typeof c?.text === 'string')?.text
              : null;
          if (text) result.snippet = text.replace(/\s+/g, ' ').trim().slice(0, 60);
        }
      }
      if (result.cwd && result.snippet) break;
    }
  } catch {
    // ignore unreadable/partial files
  } finally {
    rl.close();
  }
  return result;
}

/**
 * Lists the most recently modified Claude Code sessions across every
 * project on this machine, newest first.
 */
export async function listRecentSessions(limit = 15) {
  let projectDirs;
  try {
    projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PROJECTS_DIR, d.name));
  } catch {
    return [];
  }

  const files = [];
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
      files.push({
        sessionId: entry.replace(/\.jsonl$/, ''),
        fullPath,
        mtime: stat.mtimeMs,
        encodedDir: path.basename(dir),
      });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const top = files.slice(0, limit);

  const results = [];
  for (const f of top) {
    const summary = await peekSummary(f.fullPath);
    results.push({
      sessionId: f.sessionId,
      mtime: f.mtime,
      cwd: summary.cwd ?? f.encodedDir,
      snippet: summary.snippet ?? '(無法預覽內容)',
    });
  }
  return results;
}

export function formatRelativeTime(ms) {
  const diffSec = Math.max(0, (Date.now() - ms) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分鐘前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小時前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}
