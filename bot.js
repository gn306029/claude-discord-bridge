import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecentSessions, formatRelativeTime } from './lib/sessions.js';
import { computeUsage, formatUsageReport } from './lib/usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'state.json');

const TOKEN = requireEnv('DISCORD_BOT_TOKEN');
const ALLOWED_USER_ID = requireEnv('DISCORD_ALLOWED_USER_ID');
const ALLOWED_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || null;
const IS_WIN = process.platform === 'win32';
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();
const isTarget = (name) => !!name && name.toLowerCase() === DEVICE_NAME.toLowerCase();
const tag = (text) => `🖥️ **[${DEVICE_NAME}]**\n${text}`;

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[discord-bridge] 缺少必要設定 ${name}，請檢查 .env`);
        process.exit(1);
    }
    return v;
}

let state = {};
if (existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {
        state = {};
    }
}
function saveState() {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function getUserState(userId) {
    if (!state[userId]) state[userId] = { activeSessionId: null, lastList: [] };
    return state[userId];
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
});

client.once('clientReady', () => {
    console.log(`[discord-bridge] 裝置 ${DEVICE_NAME}，已登入為 ${client.user.tag}，等待來自 ${ALLOWED_USER_ID} 的訊息`);
});

client.on('messageCreate', async (message) => {
    try {
        await handleMessage(message);
    } catch (err) {
        console.error('[discord-bridge] handleMessage error', err);
        await message.reply(`❌ 內部錯誤: ${String(err?.message ?? err).slice(0, 500)}`).catch(() => { });
    }
});

async function handleMessage(message) {
    if (message.author.bot) return;

    // 整個安全邊界：只處理這一個 Discord 帳號的訊息
    if (message.author.id !== ALLOWED_USER_ID) return;

    const isDM = message.channel.isDMBased?.() ?? false;
    if (ALLOWED_CHANNEL_ID && !isDM && message.channel.id !== ALLOWED_CHANNEL_ID) return;

    let content = message.content.trim();
    if (!content) return;

    const userState = getUserState(message.author.id);

    // 多裝置路由：每台電腦各跑一份 bot，都會收到同一則訊息，各自判斷是否輪到自己。
    if (content === '!devices') {
        const mark = isTarget(userState.targetDevice) ? '（目前指定）' : '';
        await message.reply(`🖥️ **${DEVICE_NAME}** ${process.platform} ${os.hostname()}${mark}`);
        return;
    }
    if (content.startsWith('!device ')) {
        const name = content.slice(8).trim();
        userState.targetDevice = name;
        saveState();
        if (isTarget(name)) await message.reply(`✅ 已指定由這台（**${DEVICE_NAME}**）執行之後的指令。`);
        return;
    }
    const at = content.match(/^@(\S+)\s+([\s\S]+)$/);
    if (at) {
        if (!isTarget(at[1])) return;
        content = at[2].trim(); // 一次性指定，不改變 !device 的目標
    } else if (!isTarget(userState.targetDevice)) {
        return;
    }
    const origReply = message.reply.bind(message);
    message.reply = (c) => origReply(typeof c === 'string' ? tag(c) : c);

    if (content === '!help') {
        await message.reply(helpText());
        return;
    }

    if (content === '!sessions' || content.startsWith('!sessions ')) {
        const sessions = await listRecentSessions(15);
        userState.lastList = sessions.map((s) => s.sessionId);
        saveState();
        if (sessions.length === 0) {
            await message.reply('找不到任何 session 紀錄。');
            return;
        }
        const lines = sessions.map((s, i) => {
            const idx = i + 1;
            const rel = formatRelativeTime(s.mtime);
            const shortId = s.sessionId.slice(0, 8);
            return `\`${idx}\` ${rel} | ${s.cwd} | "${s.snippet}" (${shortId})`;
        });
        await message.reply(`**最近的 session：**\n${lines.join('\n')}\n\n用 \`!use <編號>\` 選擇要接續的對話。`);
        return;
    }

    if (content.startsWith('!use ')) {
        const idx = parseInt(content.slice(5).trim(), 10);
        if (!idx || idx < 1 || idx > userState.lastList.length) {
            await message.reply('編號無效，請先用 `!sessions` 取得最新清單。');
            return;
        }
        userState.activeSessionId = userState.lastList[idx - 1];
        saveState();
        await message.reply(`已切換到 session \`${userState.activeSessionId.slice(0, 8)}\`，之後的訊息會接續這個對話。`);
        return;
    }

    if (content.startsWith('!new ')) {
        const projectPath = content.slice(5).trim();
        if (!existsSync(projectPath)) {
            await message.reply(`找不到路徑: \`${projectPath}\``);
            return;
        }
        userState.activeSessionId = null;
        userState.pendingNewProject = projectPath;
        saveState();
        await message.reply(`好，下一則訊息會在 \`${projectPath}\` 開啟一個全新的對話。`);
        return;
    }

    if (content === '!usage') {
    const placeholder = await message.reply('⏳ 掃描本機 session 紀錄中...');
    const data = await computeUsage();
    await placeholder.edit(tag(formatUsageReport(data)).slice(0, 1900));
    return;
  }

  if (content === '!status') {
        await message.reply(
            userState.activeSessionId
                ? `目前接續 session \`${userState.activeSessionId.slice(0, 8)}\``
                : userState.pendingNewProject
                    ? `下一則訊息將在 \`${userState.pendingNewProject}\` 開新對話`
                    : '尚未選擇任何對話，請用 `!sessions` + `!use` 或 `!new <路徑>`。',
        );
        return;
    }

    if (content.startsWith('!')) {
        await message.reply('未知指令，輸入 `!help` 查看可用指令。');
        return;
    }

    if (!userState.activeSessionId && !userState.pendingNewProject) {
        await message.reply('尚未選擇對話。請先 `!sessions` 查看清單並 `!use <編號>`，或 `!new <專案路徑>` 開新對話。');
        return;
    }

    const placeholder = await message.reply('⏳ 執行中...');
    const { args, cwd } = buildArgs(userState, content);
    const { ok, text } = await runClaude(args, cwd);

    if (userState.pendingNewProject && ok) {
        userState.pendingNewProject = null;
    }
    saveState();

    await sendChunked(placeholder, ok ? text : `❌ 執行失敗:\n${text}`);
}

function buildArgs(userState, prompt) {
    const common = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
    if (userState.activeSessionId) {
        return { args: ['--resume', userState.activeSessionId, ...common, prompt], cwd: __dirname };
    }
    return { args: [...common, prompt], cwd: userState.pendingNewProject };
}

function runClaude(args, cwd) {
    return new Promise((resolve) => {
        execFile(
            'claude',
            args,
            { cwd, shell: IS_WIN, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    resolve({ ok: false, text: (stderr || err.message || '未知錯誤').slice(0, 1800) });
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    resolve({ ok: true, text: parsed.result ?? stdout, sessionId: parsed.session_id });
                } catch {
                    resolve({ ok: true, text: stdout.slice(0, 1800) });
                }
            },
        );
    });
}

async function sendChunked(placeholderMessage, text) {
    const chunks = [];
    let remaining = tag(text || '(沒有輸出)');
    while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 1900));
        remaining = remaining.slice(1900);
    }
    await placeholderMessage.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i += 1) {
        await placeholderMessage.channel.send(chunks[i]);
    }
}

function helpText() {
    return [
        '**可用指令**',
        '`!devices` - 列出所有在線裝置（每台各回一則）',
        '`!device <名稱>` - 指定之後由哪台電腦執行（其他台會忽略訊息）',
        '`@<名稱> <指令或文字>` - 只這一次交給指定電腦，例如 `@home !sessions`',
        '`!sessions` - 列出最近的對話',
        '`!use <編號>` - 接續 !sessions 清單中的某個對話',
        '`!new <專案路徑>` - 在指定專案開新對話',
        '`!usage` - 查看本機 token 用量統計（估算，非官方額度資料）',
        '`!status` - 查看目前接續的對話',
        '直接傳文字 - 送給目前選擇的對話當作新 prompt',
    ].join('\n');
}

client.login(TOKEN);
