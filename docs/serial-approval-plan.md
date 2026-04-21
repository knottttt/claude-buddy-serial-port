# Wired Approval Runbook (USB Serial)

## Goal

Enable a stable wired chain:

`PreToolUse hook -> serial_bridge.py -> device prompt UI -> A/B decision -> allow/deny`

This runbook is Claude-first and also includes Codex activity state inference.

## Files

- `tools/serial_bridge.py`
- `tools/hook_permission.py`
- `tools/buddy_daemon.py`
- `tools/install_autostart.ps1`
- `tools/uninstall_autostart.ps1`
- `tools/start_buddy_silent.vbs`

## Prerequisites

- Python 3.10+
- `pyserial`

Install:

```powershell
pip install pyserial
```

## Manual Start (for debug)

1. Connect device over USB.
2. Ensure no serial monitor holds the COM port (close `pio device monitor`).
3. Start bridge (auto-detect COM):

```powershell
python tools/serial_bridge.py --port auto
```

4. Configure PreToolUse hook (Windows absolute path recommended).

You can still force a fixed COM:

```powershell
python tools/serial_bridge.py --port COM4
```

## Auto Start (Windows plug-and-play)

Install scheduled task (login auto-run, background, no terminal):

```powershell
powershell -ExecutionPolicy Bypass -File tools/install_autostart.ps1 -Port auto -Baud 115200 -Host 127.0.0.1 -HttpPort 19191
```

Run it immediately once:

```powershell
schtasks /Run /TN ClaudeDesktopBuddyDaemon
```

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File tools/uninstall_autostart.ps1
```

Manual silent launch (no terminal window):

```powershell
wscript tools/start_buddy_silent.vbs
```

## Hook Config (Claude)

Edit `~/.claude/settings.json` and add:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "command": "C:/Users/Administrator/AppData/Local/Programs/Python/Python312/python.exe F:/PlatformIO Core/claude-desktop-buddy/tools/hook_permission.py"
      }
    ]
  }
}
```

Notes:
- Use absolute path.
- Prefer forward slashes on Windows to avoid escaping mistakes.
- `hook_permission.py` behavior is unchanged: bridge unreachable => fallback to native approval.

## Quick Test

Send a synthetic approval request:

```powershell
curl -X POST http://127.0.0.1:19191/permission `
  -H "Content-Type: application/json" `
  -d "{\"id\":\"test-01\",\"tool\":\"Bash\",\"hint\":\"ls -la\"}" `
  --max-time 70
```

Expected:
- Device shows prompt.
- Press `A` -> response includes `"decision":"once"`.
- Press `B` -> response includes `"decision":"deny"`.

## Behavior Summary

- Bridge keeps sending live state (`total/running/waiting/msg/entries`) over serial.
- Bridge sends `{"prompt": {...}}` when `/permission` arrives.
- Device returns `{"cmd":"permission","id":"...","decision":"once|deny"}`.
- Bridge returns decision to hook and then sends `{"prompt": null}` to clear UI.
- Hook maps:
  - `once/allow/always` -> `{"decision":"allow"}`
  - `deny` -> `{"decision":"block","reason":"Denied from hardware buddy"}`
- If bridge is unreachable, hook exits quietly and native approval flow continues.

## Troubleshooting

### `serial_unavailable`

Likely causes:
- Wrong COM port.
- Port occupied by monitor process.
- Device unplugged/resetting.

Action:
- Close monitor.
- Replug USB.
- If using daemon with `--port auto`, it should recover automatically.
- If fixed COM mode, restart bridge with correct COM port.

### No prompt on device

Check:
- `/permission` endpoint returns HTTP 200.
- Device firmware still supports `prompt` and `cmd=permission`.
- Bridge console has no serial decode errors.

### Timeout (defaults to 60s)

If no device response within timeout:
- Bridge returns deny.
- Prompt is cleared with `{"prompt": null}`.

### Codex sessions not detected

Codex source path is best-effort: `~/.codex/sessions/**/*.jsonl`.
If missing or format differs, bridge silently ignores it and keeps Claude state working.

## Daemon Health / Logs

- Health API: `http://127.0.0.1:19191/health`
- Daemon status file: `%LOCALAPPDATA%/ClaudeDesktopBuddy/buddy_daemon_status.json`
- Daemon log file: `%LOCALAPPDATA%/ClaudeDesktopBuddy/buddy_daemon.log`
