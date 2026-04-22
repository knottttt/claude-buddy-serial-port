#!/usr/bin/env python3
"""PreToolUse hook: forward permission requests to local serial bridge.

Behavior:
- If bridge reachable: returns allow/block decision JSON
- If bridge unreachable: exits 0 without output (fallback to native approval)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any

# Tools that are always read-only — auto-allow without waking the hardware.
_SAFE_TOOLS = {"Read", "Glob", "Grep", "WebSearch", "LS", "TodoWrite", "TodoRead",
               "Edit", "Write", "NotebookEdit"}

# Each subcommand (split on && / ;) must match one of these to be considered safe.
_SAFE_PATTERNS = [
    r"^cd\b",
    r"^git\s+(?:log|diff|show|status|branch|remote|fetch|tag|stash(?:\s+list)?)\b",
    r"^curl\s+-s\s+http://127\.0\.0\.1:19191/health",
    r"^npm\s+run\s+(?:compile|watch|build|test|lint)\b",
    r"^npm\s+install\b",
    r"^npx\s+@vscode/vsce\s+package\b",
    r"^code\s+--install-extension\b",
    r"^python(?:3)?\s+--version\b",
    r"^node\s+--version\b",
    r"^pip\s+(?:list|show|freeze)\b",
    r"^ls\b",
    r"^dir\b",
    r"^echo\b",
    r"^cat\b",
    r"^type\b",
]


def _subcommands(command: str) -> list[str]:
    """Split a shell command on && and ; into individual subcommands."""
    return [p.strip() for p in re.split(r"(?:&&|;)", command) if p.strip()]


def _sub_is_safe(sub: str) -> bool:
    return any(re.match(p, sub, re.IGNORECASE) for p in _SAFE_PATTERNS)


def is_safe(payload: dict[str, Any]) -> bool:
    tool = best_tool(payload)
    if tool in _SAFE_TOOLS:
        return True
    if tool != "Bash":
        return False
    tool_input = payload.get("tool_input", {})
    # tool_input may arrive as a dict or as a JSON-encoded string
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except Exception:
            return False
    if not isinstance(tool_input, dict):
        return False
    command = str(tool_input.get("command", "")).strip()
    if not command:
        return False
    subs = _subcommands(command)
    return bool(subs) and all(_sub_is_safe(s) for s in subs)


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return obj if isinstance(obj, dict) else {}


def best_id(payload: dict[str, Any]) -> str:
    for key in ("id", "request_id", "hook_event_id", "event_id"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return f"hook-{uuid.uuid4().hex[:12]}"


def best_tool(payload: dict[str, Any]) -> str:
    for key in ("tool_name", "tool", "name"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return "Tool"


def best_hint(payload: dict[str, Any]) -> str:
    for key in ("tool_input", "input", "command", "args"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip().replace("\n", " ")
        if isinstance(v, dict):
            s = json.dumps(v, ensure_ascii=True)
            if s:
                return s
    return ""


def print_allow() -> None:
    sys.stdout.write('{"decision":"allow"}\n')


def print_block() -> None:
    sys.stdout.write('{"decision":"block","reason":"Denied from hardware buddy"}\n')


def call_bridge(url: str, req: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    body = json.dumps(req, ensure_ascii=True).encode("utf-8")
    request = urllib.request.Request(
        url=url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    obj = json.loads(raw) if raw.strip() else {}
    return obj if isinstance(obj, dict) else {}


def main() -> int:
    parser = argparse.ArgumentParser(description="PreToolUse hook forwarding to local serial bridge")
    parser.add_argument("--url", default="http://127.0.0.1:19191/permission")
    parser.add_argument("--timeout", type=float, default=65.0)
    args = parser.parse_args()

    payload = read_stdin_json()

    if is_safe(payload):
        print_allow()
        return 0

    req = {
        "id": best_id(payload),
        "tool": best_tool(payload)[:20],
        "hint": best_hint(payload)[:43],
        "timeout": 60,
    }

    try:
        resp = call_bridge(args.url, req, args.timeout)
    except urllib.error.URLError:
        return 0  # fallback to native approval
    except TimeoutError:
        return 0
    except Exception:
        return 0

    decision = str(resp.get("decision", "")).strip().lower()
    if decision in ("once", "allow", "always"):
        print_allow()
    elif decision in ("deny", "block"):
        print_block()
    else:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
