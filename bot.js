import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecentSessions, formatRelativeTime, findSession } from './lib/sessions.js';
import { computeUsage, formatUsageReport } from './lib/usage.js';
import { channelNameFor, parseSessionMarker, sessionFooter, normalizeList } from './lib/bridge.js';
import { parseAskMarker, parseButtonId, parseReplyAnswers, renderAsk, isComplete } from './lib/ask.js';
import { readPending, recordAnswers } from './lib/pending.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'state.json');

const TOKEN = requireEnv('DISCORD_BOT_TOKEN');
const ALLOWED_USER_ID = requireEnv('DISCORD_ALLOWED_USER_ID');
const FALLBACK_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || null;
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;
const IS_WIN = process.platform === 'win32';
// 從 Discord 觸發的 claude 以 dontAsk 執行：只有明確允許的工具能跑，其餘一律拒絕。
// 預設允許改檔與本機 git（不含 push）；可用 CLAUDE_ALLOWED_TOOLS（逗號分隔）覆寫，設為 none 則全部拒絕。
const DEFAULT_ALLOWED_TOOLS = [
    'Edit', 'Write',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)',
].join(',');
const ALLOWED_TOOLS = (process.env.CLAUDE_ALLOWED_TOOLS ?? DEFAULT_ALLOWED_TOOLS).trim();
// 原生 claude.exe 不需要 shell（用 shell 時訊息中的 & | 等字元會被 cmd 解讀）；
// 只有 npm 安裝的 claude.cmd 才必須經過 shell。
const CLAUDE_NEEDS_SHELL = IS_WIN && (() => {
    try {
        const first = execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
        return /\.(cmd|bat)$/i.test(first);
    } catch { return false; }
})();
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();
const tag = (text) => `🖥️ **[${DEVICE_NAME}]**\n${text}`;

// 本裝置專屬頻道，clientReady 後由 resolveChannel() 決定；在那之前只接受 DM。
let CHANNEL_ID = null;

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[discord-bridge] 缺少必要設定 ${name}，請檢查 .env`);
        process.exit(1);
    }
    return v;
}

// 單一實例鎖：避免重複啟動造成同一則訊息被多個（甚至舊版）行程重複回覆。
const LOCK_FILE = path.join(__dirname, 'bot.lock');
if (existsSync(LOCK_FILE)) {
    const oldPid = parseInt(readFileSync(LOCK_FILE, 'utf8'), 10);
    let alive = false;
    // EPERM 代表行程存在但沒有權限查詢（例如由其他權限啟動），同樣視為仍在執行
    try { process.kill(oldPid, 0); alive = oldPid !== process.pid; } catch (err) { alive = err.code === 'EPERM'; }
    if (alive) {
        console.error(`[discord-bridge] 已有另一個 bot 在執行 (pid ${oldPid})，本行程結束。`);
        process.exit(1);
    }
}
writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => {
    try { if (readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) unlinkSync(LOCK_FILE); } catch { /* ignore */ }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

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
    if (!state[userId]) state[userId] = { activeSessionId: null, activeCwd: null, lastList: [] };
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

client.once('clientReady', async () => {
    console.log(`[discord-bridge] 裝置 ${DEVICE_NAME}，已登入為 ${client.user.tag}，等待來自 ${ALLOWED_USER_ID} 的訊息`);
    try {
        CHANNEL_ID = await resolveChannel();
    } catch (err) {
        console.error('[discord-bridge] 解析專屬頻道失敗', err);
    }
    if (!CHANNEL_ID && FALLBACK_CHANNEL_ID) CHANNEL_ID = FALLBACK_CHANNEL_ID;
    if (CHANNEL_ID) {
        // notify.js 是獨立行程，靠這個檔案得知要發到哪個頻道
        state._channel = { id: CHANNEL_ID, device: DEVICE_NAME };
        saveState();
    }
    console.log(`[discord-bridge] 使用頻道 ${CHANNEL_ID ?? '(無，僅接受 DM)'}`);
});

// 找（或建立）這台裝置專屬的頻道；失敗時回傳 null，交給備援頻道，不讓 bot 崩潰。
async function resolveChannel() {
    let guild = null;
    if (GUILD_ID) {
        guild = await client.guilds.fetch(GUILD_ID);
    } else if (FALLBACK_CHANNEL_ID) {
        const ch = await client.channels.fetch(FALLBACK_CHANNEL_ID).catch(() => null);
        guild = ch?.guild ?? null;
    }
    if (!guild) {
        console.warn('[discord-bridge] 無法判斷 guild，請設定 DISCORD_GUILD_ID 或 DISCORD_CHANNEL_ID');
        return null;
    }
    const channels = await guild.channels.fetch();
    const name = channelNameFor(DEVICE_NAME);
    const saved = state._channel?.device === DEVICE_NAME ? channels.get(state._channel.id) : null;
    if (saved) {
        // 命名規則調整後，順手把既有頻道改成新名稱（失敗就維持原名）
        if (saved.name !== name) await saved.setName(name).catch(() => { });
        return saved.id;
    }

    const existing = channels.find((c) => c && c.type === ChannelType.GuildText && c.name === name);
    if (existing) return existing.id;

    try {
        const created = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            topic: `Claude Code 橋接：${DEVICE_NAME}（${process.platform}）`,
        });
        console.log(`[discord-bridge] 已建立頻道 #${created.name}`);
        return created.id;
    } catch (err) {
        console.warn(`[discord-bridge] 無法建立頻道（缺少 Manage Channels 權限？），改用 DISCORD_CHANNEL_ID：${err.message}`);
        return null;
    }
}

// 按下問題訊息上的選項按鈕。多台裝置共用同一個 bot token，所以只處理自己頻道的互動。
client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.isButton() || interaction.channelId !== CHANNEL_ID) return;
        const b = parseButtonId(interaction.customId);
        if (!b) return;
        if (interaction.user.id !== ALLOWED_USER_ID) {
            await interaction.reply({ content: '你沒有權限操作這個按鈕。', ephemeral: true });
            return;
        }
        const pending = readPending(b.id);
        const label = pending?.questions[b.q]?.options?.[b.o]?.label;
        if (!pending || label === undefined) {
            await interaction.update({ content: tag('⌛ 這個問題已逾時或已處理，請回電腦上作答。'), components: [] });
            return;
        }
        const updated = recordAnswers(b.id, { [b.q]: label }) ?? pending;
        const view = renderAsk(updated, isComplete(updated) ? 'done' : 'open');
        await interaction.update({ content: tag(view.content), components: view.components });
    } catch (err) {
        console.error('[discord-bridge] interactionCreate error', err);
    }
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
    if (!isDM && message.channel.id !== CHANNEL_ID) return;

    const content = message.content.trim();
    if (!content) return;

    const userState = getUserState(message.author.id);

    const origReply = message.reply.bind(message);
    message.reply = (c) => origReply(typeof c === 'string' ? tag(c) : c);

    if (content === '!help') {
        await message.reply(helpText());
        return;
    }

    if (content === '!sessions' || content.startsWith('!sessions ')) {
        const sessions = await listRecentSessions(15);
        userState.lastList = sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.realCwd }));
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
        const list = normalizeList(userState.lastList);
        if (!idx || idx < 1 || idx > list.length) {
            await message.reply('編號無效，請先用 `!sessions` 取得最新清單。');
            return;
        }
        userState.activeSessionId = list[idx - 1].sessionId;
        userState.activeCwd = list[idx - 1].cwd;
        userState.pendingNewProject = null;
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
        userState.activeCwd = null;
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

    if (content === '!away' || content.startsWith('!away ')) {
        const arg = content.slice(5).trim().toLowerCase();
        if (arg === 'on' || arg === 'off') {
            state._away = arg === 'on';
            saveState();
        } else if (arg) {
            await message.reply('用法：`!away on`、`!away off` 或 `!away` 查看目前狀態。');
            return;
        }
        await message.reply(
            state._away
                ? `🚶 離開模式：**開**。Claude 的選項會發到這裡等你作答（最長 ${process.env.ASK_WAIT_SECONDS || 300} 秒，逾時才回到電腦上的對話框）。`
                : '🖥️ 離開模式：**關**。選項直接顯示在電腦上，Discord 只收到通知。',
        );
        return;
    }

    if (content === '!status') {
        await message.reply(
            userState.activeSessionId
                ? `目前接續 session \`${userState.activeSessionId.slice(0, 8)}\`${userState.activeCwd ? `（${userState.activeCwd}）` : ''}`
                : userState.pendingNewProject
                    ? `下一則訊息將在 \`${userState.pendingNewProject}\` 開新對話`
                    : '尚未選擇任何對話，請用 `!sessions` + `!use`、`!new <路徑>`，或直接回覆某則通知。',
        );
        return;
    }

    if (content.startsWith('!')) {
        await message.reply('未知指令，輸入 `!help` 查看可用指令。');
        return;
    }

    // 回覆某則通知／bot 訊息時，依該訊息內的 session 標記決定要接續哪個對話。
    if (message.reference?.messageId) {
        const ref = await message.fetchReference().catch(() => null);
        const fromBot = !!ref && ref.author.id === client.user.id;

        // 回覆「等待作答的問題」：把回覆當成答案交給正在等待的 hook，不送進 claude。
        const askId = fromBot ? parseAskMarker(ref.content) : null;
        const pending = askId ? readPending(askId) : null;
        if (pending && !isComplete(pending)) {
            const answers = parseReplyAnswers(content, pending.questions);
            if (!answers) {
                await message.reply('格式不符。單題：回覆編號或文字；多題：每題一行；多選用逗號（如 `1,3`）。');
                return;
            }
            const done = recordAnswers(askId, answers);
            if (done) {
                const view = renderAsk(done, 'done');
                await ref.edit({ content: tag(view.content), components: [] }).catch(() => { });
                await message.react('✅').catch(() => { });
            }
            return;
        }

        const marker = fromBot ? parseSessionMarker(ref.content) : null;
        if (marker) {
            const found = await findSession(marker);
            if (!found) {
                await message.reply(`找不到 session \`${marker.slice(0, 8)}\`（紀錄可能已刪除）。`);
                return;
            }
            userState.activeSessionId = found.sessionId;
            userState.activeCwd = found.cwd;
            userState.pendingNewProject = null;
            saveState();
        }
    }

    if (!userState.activeSessionId && !userState.pendingNewProject) {
        await message.reply('尚未選擇對話。請先 `!sessions` 查看清單並 `!use <編號>`，或 `!new <專案路徑>` 開新對話，或直接回覆某則通知。');
        return;
    }

    const placeholder = await message.reply('⏳ 執行中...');
    const { args, cwd } = buildArgs(userState, content);
    const { ok, text, sessionId } = await runClaude(args, cwd);

    if (ok && sessionId) {
        // 新對話第一輪完成後，之後的訊息自動接續同一個 session
        if (userState.pendingNewProject) userState.activeCwd = userState.pendingNewProject;
        userState.activeSessionId = sessionId;
        userState.pendingNewProject = null;
    }
    saveState();

    await sendChunked(placeholder, ok ? text : `❌ 執行失敗:\n${text}`, ok ? sessionId : null);
}

function buildArgs(userState, prompt) {
    const common = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'];
    // 必須用 = 連接，否則 --allowedTools（可接多個值）會把後面的 prompt 吃掉
    if (ALLOWED_TOOLS && ALLOWED_TOOLS !== 'none') common.push(`--allowedTools=${ALLOWED_TOOLS}`);
    if (userState.activeSessionId) {
        // session 依專案目錄存放，必須在原本的 cwd 下才找得到
        const cwd = userState.activeCwd && existsSync(userState.activeCwd) ? userState.activeCwd : __dirname;
        return { args: ['--resume', userState.activeSessionId, ...common, prompt], cwd };
    }
    return { args: [...common, prompt], cwd: userState.pendingNewProject };
}

function runClaude(args, cwd) {
    return new Promise((resolve) => {
        const child = execFile(
            'claude',
            args,
            { cwd, shell: CLAUDE_NEEDS_SHELL, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
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
        child.stdin.end(); // 不關閉的話 claude 會等 3 秒 stdin 才開始
    });
}

async function sendChunked(placeholderMessage, text, sessionId) {
    // 每個分段都附上 session 標記，回覆任何一段都能接續對話
    const footer = sessionFooter(sessionId);
    const size = 1800 - footer.length;
    const body = tag(text || '(沒有輸出)');
    const chunks = [];
    for (let i = 0; i < body.length; i += size) chunks.push(body.slice(i, i + size) + footer);
    await placeholderMessage.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i += 1) {
        await placeholderMessage.channel.send(chunks[i]);
    }
}

function helpText() {
    return [
        '**可用指令**（每台裝置有自己的頻道，直接在該頻道操作即可）',
        '`!sessions` - 列出最近的對話',
        '`!use <編號>` - 接續 !sessions 清單中的某個對話',
        '`!new <專案路徑>` - 在指定專案開新對話',
        '`!usage` - 查看本機 token 用量統計（估算，非官方額度資料）',
        '`!status` - 查看目前接續的對話',
        '`!away on|off` - 離開模式：開啟時 Claude 的選項會發到這裡等你作答（按鈕或回覆），關閉時直接在電腦上選',
        '直接傳文字 - 送給目前選擇的對話當作新 prompt',
        '**回覆**某則通知或 bot 訊息 - 自動接續該訊息所屬的對話',
    ].join('\n');
}

client.login(TOKEN);
