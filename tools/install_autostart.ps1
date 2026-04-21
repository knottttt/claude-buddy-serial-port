param(
  [string]$Port = "auto",
  [int]$Baud = 115200,
  [string]$Host = "127.0.0.1",
  [int]$HttpPort = 19191
)

$ErrorActionPreference = "Stop"
$taskName = "ClaudeDesktopBuddyDaemon"
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$daemonPath = Join-Path $toolsDir "buddy_daemon.py"

if (!(Test-Path $daemonPath)) {
  throw "buddy_daemon.py not found: $daemonPath"
}

$pythonwCmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
if ($pythonwCmd) {
  $pythonExe = $pythonwCmd.Source
} else {
  $pythonCmd = Get-Command python.exe -ErrorAction SilentlyContinue
  if (!$pythonCmd) { throw "python/pythonw not found in PATH" }
  $pythonExe = $pythonCmd.Source
}

$arg = "`"$daemonPath`" --port $Port --baud $Baud --host $Host --http-port $HttpPort"
$action = New-ScheduledTaskAction -Execute $pythonExe -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Description "Desktop Buddy daemon auto-start" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "Installed scheduled task: $taskName"
Write-Host "Run now: schtasks /Run /TN $taskName"
