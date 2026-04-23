# Claude Buddy Serial (knottttt fork)

> Fork note: this repository started from the official
> `claude-desktop-buddy`, then evolved into a Windows-first version focused on
> reliability via VS Code + USB serial instead of desktop BLE.

## Showcase

![Claude Buddy Serial showcase](screenshot/image.jpg)

## Why this fork exists

- In my Windows environment, Claude Desktop BLE connectivity with Hardware Buddy was unreliable.
- I replaced the primary connection path with a serial bridge.
- The goal is practical day-to-day stability while preserving the original buddy experience.

## What this fork adds

### 1) VS Code bridge (`vscode-buddy/`)

- Polls both Claude (`~/.claude/projects/**/*.jsonl`) and Codex (`~/.codex/sessions/**/*.jsonl`); picks the most recently active source
- Pushes status to device every 800ms
- Provides a sidebar panel for bridge lifecycle and hardware control

### 2) Hardware controls over serial

- Brightness: `{"set":{"brightness":N}}`, `N=0..4`
- LED: `{"set":{"led":true|false}}`
- Sound: `{"set":{"sound":true|false}}`
- Pet switch: `{"cmd":"species","idx":N}`, `N=0..17`

### 3) Firmware reliability improvements

- Strict `species` validation: only `0..17` (plus `0xFF` GIF sentinel)
- Invalid species rejection with explicit ack:
  `{"ack":"species","ok":false,"reason":"idx_out_of_range"}`
- Reduced NVS writes for batched `set` updates:
  `led/sound` are saved only when values actually change, with a single `settingsSave()`
- Improved shake behavior from clock view: shake exits to pet view and shows dizzy animation

### 4) Panel feedback behavior

- Optimistic UI updates remain (instant visual response on click)
- Send failure or device rejection is logged as `[control] ...`
- A short top alert is shown in the panel for control errors

## Recent fixes

- Fixed false `waiting approval` / `attention` state for long-running normal tool calls.
- Codex tool calls show `busy` (not `attention`) by default; `attention` is only triggered when the call explicitly requests sandboxed permission escalation.
- Prevents unintended LED blinking caused by non-approval command execution.
- Added regression tests in `vscode-buddy/src/activityTracker.test.ts`.

## Quick start

### Firmware

```bash
pio run -t upload
```

### VS Code extension

Install the pre-built VSIX:

```bash
code --install-extension vscode-buddy/claude-buddy-serial-0.1.0.vsix
```

Then reload VS Code, open the `Claude Buddy Serial` panel and click `Start`.

Default serial settings:

- Port: `COM4`
- Baud: `115200`

To build from source instead:

```bash
cd vscode-buddy
npm install
npm run compile
npx vsce package
```

## Project direction

This is a practical fork with Windows usability as first priority:

- stable first
- iterate features second
- keep firmware UX compatibility

---

*彩蛋：在主界面连按三次正面按钮，可以进入隐藏的 ASCII 老虎机小游戏。*
