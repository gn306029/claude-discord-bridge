# 每裝置獨立頻道 + 回覆即接續 session

## 目標
多台電腦（各自登入不同 Claude 帳號）共用同一個 Discord 伺服器。目前每台 bot 都會收到所有訊息，使用者必須用 `!device` 指定裝置，操作麻煩。

目標：每個裝置／帳號擁有自己的頻道；對訊息按「回覆」時，自動接續該訊息所屬的 session。

範圍假設（已確認）：每台電腦跑一個 bot 行程，各自的 `DEVICE_NAME` 不同。同一台電腦跑多個帳號不在本次範圍內。

## 設計

### 1. 每個 profile 一個專屬頻道
- 新增環境變數 `DISCORD_GUILD_ID`（若已設定 `DISCORD_CHANNEL_ID`，可省略，改由該頻道推得 guild）。
- `clientReady` 時，bot 依序決定自己的頻道：
  1. 若 `state._channel.id` 存在且該頻道仍在 guild 內，直接使用；
  2. 否則尋找名為 `claude-<slug(DEVICE_NAME)>` 的文字頻道（轉小寫，非 `[a-z0-9-]` 的字元換成 `-`）；
  3. 找不到就建立（需要 Manage Channels 權限）；
  4. 建立失敗則退回使用 `DISCORD_CHANNEL_ID`，並記錄警告。
- 決定後的頻道 ID 寫入 `state.json` 的 `_channel`，並在記憶體中保存為 `CHANNEL_ID`。
- bot 只處理 `channel.id === CHANNEL_ID` 的訊息（DM 與現況相同，仍允許）。

### 2. 移除裝置路由
刪除 `!devices`、`!device`、`@名稱` / `!名稱` 一次性指定、`targetDevice`、`isTarget`、`BUILTIN_COMMANDS`。回覆開頭的 `🖥️ [裝置]` 標籤保留（成本低，且在同時檢視多個頻道時有用）。

### 3. notify.js
- 頻道 ID 取自 `state.json` 的 `_channel.id`，沒有時退回 `DISCORD_CHANNEL_ID`。hook 每次都是全新行程，所以每次執行都重新讀取。
- 每則帶有 session 的通知，都附上 `session: \`<完整 uuid>\``（原本只有前 8 碼）與專案路徑，方便之後解析。

### 4. 回覆即接續
`handleMessage` 遇到非指令訊息且 `message.reference?.messageId` 存在時：
- 取得被回覆的訊息；作者必須是本 bot（notify.js 用同一個 bot token 發訊，作者同樣是 bot）；
- 用正規表示式 `session: \`([0-9a-f-]{8,36})\`` 取出 session 標記，再用 `lib/sessions.js` 新增的 `findSession(prefix)`（掃描各專案目錄中符合 `<prefix>*.jsonl` 的檔案，回傳 `{sessionId, cwd}`）還原完整 session；
- 這則訊息直接送進該 session，並同時把它設為 `activeSessionId`，之後不按回覆也會接續。
- 被回覆的訊息沒有 session 標記時，走原本的 active session 流程。
- bot 自己執行結果的回覆也加上 `session: \`<id>\`` 頁尾（id 取自 claude JSON 輸出的 `session_id`），所以也能再被回覆。

### 5. 修正 resume 的工作目錄
`buildArgs` 以 session 記錄的 `cwd` 執行 `--resume`，不再固定用 bot 資料夾。若該 `cwd` 在磁碟上不存在，退回 bot 資料夾。`state` 中的 `activeSessionId` 搭配新增的 `activeCwd` 一起儲存。

### 6. 既有指令確認（需維持正常）
`!help`（更新說明文字）、`!sessions`、`!use`、`!new`、`!usage`、`!status`。
- `!sessions` 為每筆清單同時記錄 cwd：`lastList` 改為 `[{sessionId, cwd}]`，舊格式（純字串）仍要能讀。
- `!usage` 的縮排整理。

## 錯誤處理
- 頻道查詢／建立失敗：記錄警告並退回備援頻道，不讓 bot 崩潰。
- 回覆指到無效或找不到的 session：回覆使用者錯誤訊息，不執行。
- 舊版 `state.json` 可正常載入（多餘欄位忽略）。

## 測試
- 單元測試（node:test，不連 Discord）：頻道名稱 slug、session 標記解析、以暫存專案目錄測試 `findSession`、新舊 `lastList` 格式正規化。
- 手動測試：兩台裝置在同一個 guild 各自建立頻道；各頻道內測試 `!sessions`／`!use`／`!status`／`!new`／`!usage`／`!help`；Stop 通知 → 回覆 → 確認在正確的 cwd 接續同一個 session。

## 文件
更新 README（指令、環境變數、Manage Channels 權限說明）、`.env.example`（加入 `DISCORD_GUILD_ID`）與 `!help` 文字。
