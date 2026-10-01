# Claude Discord Bridge

Cross-project, cross-platform Discord integration for Claude Code.

## What this does

1. **Outbound notifications** (`notify.js` + global hooks in
   `~/.claude/settings.json`): whenever Claude Code needs you to confirm a
   plan (permission prompt), asks a multiple-choice question
   (`AskUserQuestion`), hits a usage limit / reset, or finishes a turn
   (`Stop`), Claude Code itself runs this script and it posts a message to
   your Discord channel. No background process required - it only runs when
   Claude Code triggers it, in whichever project you're working in. Wired
   via three hooks: `Notification` (permission prompts, quota events, idle,
   elicitations), `PreToolUse` matched on `AskUserQuestion` (Claude Code's
   `Notification` hook doesn't cover this tool - see
   https://github.com/anthropics/claude-code/issues/28273), and `Stop`
   (end of each turn).

2. **Inbound prompt relay** (`bot.js`, a small always-running Discord bot):
   lets you reply from Discord. You pick which past Claude Code session to
   continue (or start a fresh one in a given project), and everything you
   type after that is sent to `claude --resume <session> -p "<your message>"`
   and the reply is posted back to Discord.

## Setup

1. Create a Discord application + bot at
   https://discord.com/developers/applications -> New Application -> Bot ->
   Reset Token. Under "Privileged Gateway Intents", enable
   **Message Content Intent**.
2. Invite the bot to a server (OAuth2 -> URL Generator -> scope `bot`,
   permission `Send Messages` + `Read Message History`), or just plan to DM it.
3. Get the IDs you need (enable Discord Settings -> Advanced -> Developer
   Mode first):
   - Your own user ID (right-click your name -> Copy User ID)
   - The channel ID you'll use (right-click the channel -> Copy Channel ID) -
     optional if you'll only use DMs
4. `cp .env.example .env` and fill in `DISCORD_BOT_TOKEN`,
   `DISCORD_ALLOWED_USER_ID`, `DISCORD_GUILD_ID`, `DEVICE_NAME`
   (`DISCORD_CHANNEL_ID` 為備援，可留空).
5. `npm install`
6. The `Notification` hook is already wired into your global
   `~/.claude/settings.json` (applies to every project automatically) -
   nothing to do there.
7. Start the bot: `npm start` (or see auto-start setup, once provided).

## Discord commands (bot.js)

每台裝置（bot 行程）有自己的頻道 `claude-<DEVICE_NAME>`，啟動時自動建立（需
**Manage Channels** 權限；沒有權限時退回 `DISCORD_CHANNEL_ID`）。在哪個頻道說話就由
哪台電腦處理，不需要指定裝置。通知也會發到該裝置自己的頻道。

- **回覆**任何通知或 bot 訊息 - 自動接續該訊息所屬的 session（訊息內有
  `session: <id>` 標記），並設為目前使用中的對話。
- `!sessions` - list your most recent Claude Code sessions across every
  project on this machine.
- `!use <number>` - continue the session at that number from the last
  `!sessions` list.
- `!new <project-path>` - start a brand new conversation in that project
  (第一輪完成後自動接續該 session).
- `!usage` - local token usage tally, summed from every session transcript
  under `~/.claude/projects/` (same approach as the community
  [phuryn/claude-usage](https://github.com/phuryn/claude-usage) tool). This
  is **not** the account's official remaining quota - Claude Code has no
  scriptable way to query that (`/usage`/`/cost` are TUI-only slash commands
  and don't work under `-p`/headless mode - confirmed by testing). It's a
  best-effort local token count, labeled as such in the reply.
- `!status` - show what's currently selected.
- `!away on|off` - 離開模式。開啟時，Claude 的 AskUserQuestion 選項會發到這個頻道（附按鈕，也可**回覆**編號／文字作答），
  你的答案會直接回給電腦上正在等待的 Claude Code，不用回到 VSCode 點選。等不到答案（預設 300 秒，`ASK_WAIT_SECONDS`）
  就退回電腦上原本的選項對話框。關閉時（預設）選項直接顯示在電腦上，Discord 只收到通知。
  注意：AskUserQuestion 的 hook 必須是**同步**的（不能加 `async`，timeout 要大於 `ASK_WAIT_SECONDS`），下方設定已是如此。
- Anything else - sent as a prompt to whichever session/project you selected.

## Security

Discord 觸發的對話預設允許 `Edit`、`Write` 與本機 git（status/diff/log/add/commit，**不含 push**），
其餘仍被拒絕；可用 `.env` 的 `CLAUDE_ALLOWED_TOOLS` 調整，`none` 為唯讀。以下為原始說明：

The bot only ever acts on messages from `DISCORD_ALLOWED_USER_ID`. Anyone
else's messages (even in the same channel) are silently ignored. Prompts run
with `--permission-mode dontAsk`, which **denies** anything that would
otherwise need a permission prompt (it does not silently allow everything) -
unattended execution stays safe by default. If you want the bot to be able to
e.g. edit files, you'd need to explicitly broaden that in `bot.js`
(`--allowedTools ...`), which widens what a message from your own Discord
account can do on this machine - do that deliberately, not by default.

## Portability to another Claude account / machine

This whole folder is self-contained:

1. Copy `~/.claude/discord-bridge/` to the other machine's home directory.
2. `npm install` there.
3. Fill in a fresh `.env` with that Discord account/bot's own values.
4. Copy the hooks block below into that machine's `~/.claude/settings.json`
   under the top-level `hooks` key (merge with whatever hooks already exist
   there - don't overwrite the file, and if a `PreToolUse` array already
   exists, add this `AskUserQuestion` matcher object as one more entry in it
   rather than replacing the array):

```json
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "hooks": [
      { "type": "command", "command": "node \"$HOME/.claude/discord-bridge/notify.js\"", "shell": "bash", "timeout": 330 }
    ]
  }
],
"Notification": [
  {
    "hooks": [
      { "type": "command", "command": "node \"$HOME/.claude/discord-bridge/notify.js\"", "shell": "bash", "timeout": 10, "async": true }
    ]
  }
],
"Stop": [
  {
    "hooks": [
      { "type": "command", "command": "node \"$HOME/.claude/discord-bridge/notify.js\"", "shell": "bash", "timeout": 10, "async": true }
    ]
  }
]
```

5. Set up auto-start for `bot.js` for that OS (see auto-start setup, once
   provided).

## Auto-start

- Windows: `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`
- macOS: `chmod +x install-mac.sh && ./install-mac.sh`

Both register the OS's own login-time service manager (Task Scheduler /
launchd) to run `node bot.js` - no extra daemon or third-party service needed.

## Status

- [x] `notify.js` outbound notifications (`Notification`, `PreToolUse`
      /`AskUserQuestion`, `Stop`) - hooks wired globally, tested end-to-end
      with real Discord credentials.
- [x] `bot.js` inbound relay - working, token + Message Content Intent
      verified, invited to the target server.
- [x] `!usage` local token tally - added.
- [x] Windows auto-start (Task Scheduler + hidden VBS launcher, no console
      window) - registered.
- [ ] macOS auto-start (`install-mac.sh`) - written, not yet run (no Mac
      available in this session to test on).
