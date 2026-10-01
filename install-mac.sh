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

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "已安裝並啟動 LaunchAgent：$PLIST"
echo "下次登入會自動啟動；要立刻重啟可執行:"
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "要移除:"
echo "  launchctl unload \"$PLIST\" && rm \"$PLIST\""
