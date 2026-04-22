#!/usr/bin/env python3
"""USB serial bridge with hardware permission approval.

Features:
- Pushes live state to device over JSONL
- Accepts HTTP POST /permission and forwards prompt to device
- Receives {"cmd":"permission","id","decision"} from device
- Supports Claude + Codex log sources for state inference
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import queue
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

import serial
from serial import SerialException
from serial.tools import list_ports

STALE_SECS = 5.0
SLEEP_SECS = 30.0
STATE_POLL_SECS = 0.8
RECONNECT_SECS = 1.0
DEFAULT_HTTP_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 19191
AUTO_PORT = "auto"
AUTO_PORT_LOG_INTERVAL_SECS = 5.0

USB_HINTS = (
    "m5",
    "m5stick",
    "cp210",
    "ch340",
    "wch",
    "usb serial",
    "silicon labs",
    "uart",
    "esp32",
)

PRIORITY_VIDPID = {
    (0x10C4, 0xEA60),  # CP210x
    (0x1A86, 0x7523),  # CH340
    (0x303A, 0x1001),  # ESP32-S3 USB-JTAG/serial (common)
}


def now_ts() -> float:
    return time.time()


def iso_to_ts(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def looks_like_tool_use(obj: Any) -> bool:
    if isinstance(obj, dict):
        t = obj.get("type")
        if t in ("tool_use", "tool-call", "tool_call", "function_call"):
            return True
        if "tool_use_id" in obj or "tool_name" in obj:
            return True
        for v in obj.values():
            if looks_like_tool_use(v):
                return True
        return False
    if isinstance(obj, list):
        return any(looks_like_tool_use(v) for v in obj)
    return False


def looks_like_tool_result(obj: Any) -> bool:
    if isinstance(obj, dict):
        t = obj.get("type")
        if t in ("tool_result", "tool-output", "tool_output", "function_result"):
            return True
        if "tool_use_id" in obj and ("content" in obj or "output" in obj):
            return True
        for v in obj.values():
            if looks_like_tool_result(v):
                return True
        return False
    if isinstance(obj, list):
        return any(looks_like_tool_result(v) for v in obj)
    return False


def read_tail_lines(path: Path, max_lines: int = 120, max_bytes: int = 512 * 1024) -> list[str]:
    try:
        size = path.stat().st_size
    except OSError:
        return []
    take = min(size, max_bytes)
    try:
        with path.open("rb") as f:
            f.seek(max(0, size - take))
            blob = f.read()
    except OSError:
        return []
    text = blob.decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return lines[-max_lines:]


def choose_auto_port() -> Optional[str]:
    ports = list(list_ports.comports())
    if not ports:
        return None

    def score(p: Any) -> tuple[int, float]:
        text = " ".join(
            str(x).lower()
            for x in (
                getattr(p, "device", ""),
                getattr(p, "name", ""),
                getattr(p, "description", ""),
                getattr(p, "manufacturer", ""),
                getattr(p, "hwid", ""),
            )
        )
        base = 0
        if "bluetooth" in text:
            return (-1, 0.0)
        if any(h in text for h in USB_HINTS):
            base += 2
        vid = getattr(p, "vid", None)
        pid = getattr(p, "pid", None)
        if isinstance(vid, int) and isinstance(pid, int):
            if (vid, pid) in PRIORITY_VIDPID:
                base += 6
            else:
                base += 1
        return (base, 0.0)

    ranked = sorted(ports, key=score, reverse=True)
    if not ranked:
        return None
    top = ranked[0]
    top_score, _ = score(top)
    if top_score <= 0:
        return None
    return str(top.device)


@dataclass
class SourceSnapshot:
    name: str
    active_ts: float
    mode: str  # idle | busy | attention | sleep
    detail: str


class LogSource:
    def __init__(self, name: str, pattern: str) -> None:
        self.name = name
        self.pattern = os.path.expanduser(pattern)

    def snapshot(self) -> Optional[SourceSnapshot]:
        files = glob.glob(self.pattern, recursive=True)
        if not files:
            return None
        newest = max((Path(p) for p in files), key=lambda p: p.stat().st_mtime)
        lines = read_tail_lines(newest)
        if not lines:
            return None

        last_ts: Optional[float] = None
        mode = "idle"
        detail = f"{self.name}: idle"

        for line in reversed(lines):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            event_ts = iso_to_ts(obj.get("timestamp")) or iso_to_ts(obj.get("created_at")) or newest.stat().st_mtime
            role = obj.get("role") or obj.get("sender") or obj.get("author")
            if isinstance(role, dict):
                role = role.get("role")
            role = str(role).lower() if role is not None else ""

            if looks_like_tool_use(obj) and role in ("assistant", "model", "agent", ""):
                age = now_ts() - event_ts
                mode = "attention" if age > STALE_SECS else "busy"
                detail = f"{self.name}: tool_use"
                last_ts = event_ts
                break
            if looks_like_tool_result(obj) and role in ("user", "tool", "system", ""):
                mode = "busy"
                detail = f"{self.name}: tool_result"
                last_ts = event_ts
                break
            if role in ("assistant", "model", "agent", "user"):
                mode = "idle"
                detail = f"{self.name}: active"
                last_ts = event_ts
                break

        if last_ts is None:
            last_ts = newest.stat().st_mtime
            mode = "idle"
            detail = f"{self.name}: file-active"

        if now_ts() - last_ts > SLEEP_SECS:
            mode = "sleep"
            detail = f"{self.name}: sleep"

        return SourceSnapshot(self.name, last_ts, mode, detail)


class ClaudeSource(LogSource):
    def __init__(self) -> None:
        super().__init__("claude", "~/.claude/projects/**/*.jsonl")


class CodexSource(LogSource):
    def __init__(self) -> None:
        super().__init__("codex", "~/.codex/sessions/**/*.jsonl")

    def snapshot(self) -> Optional[SourceSnapshot]:
        try:
            return super().snapshot()
        except Exception:
            # Codex session format is not stable/documented; fail open.
            return None


class SerialRef:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ser: Optional[serial.Serial] = None

    def get(self) -> Optional[serial.Serial]:
        with self._lock:
            return self._ser

    def replace(self, ser: Optional[serial.Serial]) -> Optional[serial.Serial]:
        old = None
        with self._lock:
            old = self._ser
            self._ser = ser
        if old is not None and old is not ser:
            try:
                try:
                    old.dtr = False
                    old.rts = False
                except Exception:
                    pass
                old.close()
            except Exception:
                pass
        return old

    def close_if_same(self, ser: serial.Serial) -> None:
        with self._lock:
            if self._ser is ser:
                self._ser = None
                try:
                    try:
                        ser.dtr = False
                        ser.rts = False
                    except Exception:
                        pass
                    ser.close()
                except Exception:
                    pass

    def write_line(self, obj: dict[str, Any]) -> bool:
        payload = (json.dumps(obj, ensure_ascii=True) + "\n").encode("utf-8")
        ser = self.get()
        if ser is None:
            return False
        try:
            ser.write(payload)
            ser.flush()
            return True
        except SerialException:
            self.close_if_same(ser)
            return False


class PermissionBroker:
    @dataclass
    class PendingItem:
        q: queue.Queue[str]
        tool: str
        hint: str
        created_ts: float

    def __init__(self, serial_ref: SerialRef) -> None:
        self._serial_ref = serial_ref
        self._lock = threading.Lock()
        self._pending: dict[str, PermissionBroker.PendingItem] = {}

    def request(self, req_id: str, tool: str, hint: str, timeout_s: float) -> str:
        q: queue.Queue[str] = queue.Queue(maxsize=1)
        with self._lock:
            self._pending[req_id] = PermissionBroker.PendingItem(
                q=q,
                tool=tool,
                hint=hint,
                created_ts=now_ts(),
            )

        wrote = self._serial_ref.write_line({"prompt": {"id": req_id, "tool": tool, "hint": hint}})
        if not wrote:
            with self._lock:
                self._pending.pop(req_id, None)
            return "serial_unavailable"

        decision = "deny"
        try:
            decision = q.get(timeout=timeout_s)
        except queue.Empty:
            decision = "deny"
        finally:
            self._serial_ref.write_line({"prompt": None})
            with self._lock:
                self._pending.pop(req_id, None)
        return decision

    def resolve(self, req_id: str, raw_decision: str) -> bool:
        dec = str(raw_decision).strip().lower()
        if dec in ("allow", "once", "always"):
            mapped = "once"
        else:
            mapped = "deny"
        with self._lock:
            item = self._pending.get(req_id)
        if item is None:
            return False
        try:
            item.q.put_nowait(mapped)
            return True
        except queue.Full:
            return False

    def waiting_count(self) -> int:
        with self._lock:
            return len(self._pending)

    def current_prompt(self) -> Optional[dict[str, str]]:
        with self._lock:
            if not self._pending:
                return None
            req_id, item = min(self._pending.items(), key=lambda kv: kv[1].created_ts)
            return {"id": req_id, "tool": item.tool, "hint": item.hint}


class BridgeState:
    def __init__(self, serial_ref: SerialRef, broker: PermissionBroker) -> None:
        self.serial_ref = serial_ref
        self.broker = broker
        self.sources = [ClaudeSource(), CodexSource()]
        self.stop_evt = threading.Event()
        self.last_mode = "sleep"

    def best_snapshot(self) -> Optional[SourceSnapshot]:
        snaps: list[SourceSnapshot] = []
        for src in self.sources:
            try:
                snap = src.snapshot()
            except Exception:
                snap = None
            if snap is not None:
                snaps.append(snap)
        if not snaps:
            return None
        snaps.sort(key=lambda s: s.active_ts, reverse=True)
        return snaps[0]

    def build_payload(self) -> dict[str, Any]:
        waiting = self.broker.waiting_count()
        snap = self.best_snapshot()
        mode = "sleep"
        msg = "No Claude/Codex activity"
        total = 0
        running = 0
        waiting_n = waiting

        if snap is not None:
            age = now_ts() - snap.active_ts
            if age > SLEEP_SECS:
                mode = "sleep"
                msg = f"{snap.name}: sleeping"
            else:
                mode = snap.mode
                msg = snap.detail
                total = 1
                if mode in ("busy", "attention"):
                    running = 1
        if waiting > 0:
            mode = "attention"
            total = max(total, 1)
            running = 0
            waiting_n = waiting
            msg = f"awaiting approval ({waiting})"

        self.last_mode = mode
        payload = {
            "total": total,
            "running": running,
            "waiting": waiting_n,
            "msg": msg[:23],
            "entries": [msg[:88]],
        }
        pr = self.broker.current_prompt()
        if pr is not None:
            payload["prompt"] = pr
        return payload


def serial_connector(port_arg: str, baud: int, serial_ref: SerialRef, stop_evt: threading.Event) -> None:
    last_auto_log_ts = 0.0
    while not stop_evt.is_set():
        if serial_ref.get() is not None:
            time.sleep(RECONNECT_SECS)
            continue
        port = port_arg
        if port_arg.lower() == AUTO_PORT:
            port = choose_auto_port() or ""
            if not port:
                if now_ts() - last_auto_log_ts >= AUTO_PORT_LOG_INTERVAL_SECS:
                    print("[serial] waiting for device (auto port detect)")
                    last_auto_log_ts = now_ts()
                time.sleep(RECONNECT_SECS)
                continue
        try:
            ser = serial.Serial(
                port=port,
                baudrate=baud,
                timeout=0.3,
                write_timeout=0.3,
                dsrdtr=False,
                rtscts=False,
            )
            # Best-effort: avoid toggling control lines that can reset boards.
            try:
                ser.dtr = False
                ser.rts = False
            except Exception:
                pass
            serial_ref.replace(ser)
            print(f"[serial] connected: {port} @ {baud}")
        except SerialException as exc:
            print(f"[serial] connect failed: {exc}")
            time.sleep(RECONNECT_SECS)


def serial_reader(serial_ref: SerialRef, broker: PermissionBroker, stop_evt: threading.Event) -> None:
    while not stop_evt.is_set():
        ser = serial_ref.get()
        if ser is None:
            time.sleep(0.2)
            continue
        try:
            raw = ser.readline()
            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("{"):
                continue
            obj = json.loads(line)
            if obj.get("cmd") != "permission":
                continue
            req_id = str(obj.get("id", ""))
            dec = str(obj.get("decision", "deny"))
            if not req_id:
                continue
            broker.resolve(req_id, dec)
        except (SerialException, OSError):
            serial_ref.close_if_same(ser)
        except json.JSONDecodeError:
            continue


def state_writer(state: BridgeState) -> None:
    while not state.stop_evt.is_set():
        payload = state.build_payload()
        state.serial_ref.write_line(payload)
        time.sleep(STATE_POLL_SECS)


def make_handler(state: BridgeState, timeout_s: float):
    class Handler(BaseHTTPRequestHandler):
        server_version = "serial-bridge/1.0"

        def _send_json(self, code: int, obj: dict[str, Any]) -> None:
            body = (json.dumps(obj, ensure_ascii=True) + "\n").encode("utf-8")
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # client disconnected before response (e.g. hook process killed)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "serial_connected": state.serial_ref.get() is not None,
                        "waiting": state.broker.waiting_count(),
                        "mode": state.last_mode,
                    },
                )
                return
            self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/permission":
                self._send_json(404, {"ok": False, "error": "not_found"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                self._send_json(400, {"ok": False, "error": "empty_body"})
                return
            try:
                raw = self.rfile.read(length)
                req = json.loads(raw.decode("utf-8"))
            except Exception:
                self._send_json(400, {"ok": False, "error": "bad_json"})
                return

            req_id = str(req.get("id", "")).strip()
            if not req_id:
                self._send_json(400, {"ok": False, "error": "missing_id"})
                return
            tool = str(req.get("tool", "Tool"))[:20]
            hint = str(req.get("hint", ""))[:43]
            wait_s = float(req.get("timeout", timeout_s))
            wait_s = max(1.0, min(wait_s, 300.0))

            decision = state.broker.request(req_id, tool, hint, wait_s)
            if decision == "serial_unavailable":
                self._send_json(503, {"ok": False, "id": req_id, "decision": "deny", "error": "serial_unavailable"})
                return
            self._send_json(200, {"ok": True, "id": req_id, "decision": decision})

        def log_message(self, format: str, *args: Any) -> None:
            _ = (format, args)

    return Handler


def run_http(state: BridgeState, host: str, port: int, timeout_s: float) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(state, timeout_s))
    t = threading.Thread(target=server.serve_forever, name="http-server", daemon=True)
    t.start()
    print(f"[http] listening on http://{host}:{port}")
    return server


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="USB serial bridge with hardware approval")
    parser.add_argument("port", nargs="?", default=AUTO_PORT, help="Serial port, e.g. COM4, or auto")
    parser.add_argument("--port", dest="port_opt", help="Override serial port, e.g. COM4 or auto")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--host", default=DEFAULT_HTTP_HOST)
    parser.add_argument("--http-port", type=int, default=DEFAULT_HTTP_PORT)
    parser.add_argument("--permission-timeout", type=float, default=60.0)
    args = parser.parse_args()
    if args.port_opt:
        args.port = args.port_opt
    if not isinstance(args.port, str) or not args.port.strip():
        args.port = AUTO_PORT
    return args


def main() -> int:
    args = parse_args()
    serial_ref = SerialRef()
    broker = PermissionBroker(serial_ref)
    state = BridgeState(serial_ref, broker)

    connector = threading.Thread(
        target=serial_connector, args=(args.port, args.baud, serial_ref, state.stop_evt), name="serial-connector", daemon=True
    )
    reader = threading.Thread(target=serial_reader, args=(serial_ref, broker, state.stop_evt), name="serial-reader", daemon=True)
    writer = threading.Thread(target=state_writer, args=(state,), name="state-writer", daemon=True)

    connector.start()
    reader.start()
    writer.start()
    server = run_http(state, args.host, args.http_port, args.permission_timeout)

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        state.stop_evt.set()
        server.shutdown()
        ser = serial_ref.get()
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
