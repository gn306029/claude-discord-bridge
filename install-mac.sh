#!/usr/bin/env bash
# Installs a macOS LaunchAgent that starts the Discord bridge bot at login.
# Run this once:
#   chmod +x install-mac.sh && ./install-mac.sh
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo "找不到 node，請先安裝 Node.js 並確認已加入 PATH。" >&2
  exit 1
fi

LABEL="com.claude.discord-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_GUI="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$BRIDGE_DIR/bot.js</string>
  </array>
  <key>WorkingDirectory</key><string>$BRIDGE_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BRIDGE_DIR/bot.log</string>
  <key>StandardErrorPath</key><string>$BRIDGE_DIR/bot.error.log</string>
</dict>
</plist>
EOF

# Extended attributes (e.g. a quarantine flag) on the plist can make launchd
# refuse it with a bare "Input/output error" - strip them defensively.
xattr -c "$PLIST" 2>/dev/null || true

if ! plutil -lint "$PLIST" >/dev/null; then
  echo "產生的 plist 語法有誤，請把這個錯誤回報給 Claude。" >&2
  exit 1
fi

# Clear any stale registration from a previous failed attempt, then load.
# "Could not find" from bootout here is expected/harmless when nothing was
# loaded yet - it is not treated as a failure.
if [ "$(id -u)" -eq 0 ]; then
  echo "請不要用 sudo 執行：LaunchAgent 必須安裝在你自己的登入帳號底下。" >&2
  exit 1
fi

# 先把舊的服務和任何手動啟動的 bot.js 都清掉，避免重複行程。
launchctl bootout "$UID_GUI/$LABEL" >/dev/null 2>&1 || true
launchctl unload "$PLIST" >/dev/null 2>&1 || true
pkill -f "$BRIDGE_DIR/bot.js" >/dev/null 2>&1 || true
pkill -f "node bot.js" >/dev/null 2>&1 || true
rm -f "$BRIDGE_DIR/bot.lock"
sleep 2
launchctl enable "$UID_GUI/$LABEL" >/dev/null 2>&1 || true

if ! launchctl bootstrap "$UID_GUI" "$PLIST"; then
  echo "bootstrap 失敗，改用 launchctl load -w 重試..." >&2
  if ! launchctl load -w "$PLIST"; then
    echo "launchctl 載入失敗，請把上面的錯誤訊息回報給 Claude（不要假設這樣就是裝好了）。" >&2
    exit 1
  fi
fi

if ! launchctl list | grep -q "$LABEL"; then
  echo "bootstrap 沒有回報錯誤，但 launchctl list 看不到 $LABEL，請檢查 $BRIDGE_DIR/bot.error.log" >&2
  exit 1
fi

echo "已安裝並啟動 LaunchAgent：$PLIST"
echo "下次登入會自動啟動；要立刻重啟可執行:"
echo "  launchctl kickstart -k $UID_GUI/$LABEL"
echo "要移除:"
echo "  launchctl bootout $UID_GUI/$LABEL && rm \"$PLIST\""
