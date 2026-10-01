# Registers a Windows Scheduled Task that starts the Discord bridge bot
# at logon, hidden (no console window), via a VBS launcher wrapper.
# Run this script once from an elevated PowerShell in this folder:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1

$ErrorActionPreference = 'Stop'

$bridgeDir = $PSScriptRoot
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "找不到 node，請先安裝 Node.js 並確認已加入 PATH。"
    exit 1
}

$wscriptPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbsPath = Join-Path $bridgeDir 'start-hidden.vbs'

$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument "`"$vbsPath`"" -WorkingDirectory $bridgeDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "ClaudeDiscordBridge" `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "已註冊工作排程 'ClaudeDiscordBridge'（背景隱藏執行，不會跳出視窗），下次登入時會自動啟動。"
Write-Host "要立即啟動測試，執行: Start-ScheduledTask -TaskName 'ClaudeDiscordBridge'"
Write-Host "要移除，執行: Unregister-ScheduledTask -TaskName 'ClaudeDiscordBridge' -Confirm:`$false"
