#!/usr/bin/env python3
"""Windows background daemon for serial_bridge.

- Starts serial_bridge.py in background
- Restarts on crash
- Polls /health and exposes status in local files
- Optional tray icon when pystray + pillow are installed
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

try:
    from PIL import Image, ImageDraw
    import pystray

    HAS_TRAY = True
except Exception:
    HAS_TRAY = False

APP_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "ClaudeDesktopBuddy"
LOG_PATH = APP_DIR / "buddy_daemon.log"
STATUS_PATH = APP_DIR / "buddy_daemon_status.json"
HEALTH_URL_TEMPLATE = "http://{host}:{port}/health"
POLL_SECS = 1.5
RESTART_DELAY_SECS = 2.0


class Logger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, msg: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
        with self.lock:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        if sys.stdout:
            print(line)


class TrayController:
    def __init__(self, stop_evt: threading.Event, logger: Logger) -> None:
        self.stop_evt = stop_evt
        self.logger = logger
        self._icon: Optional[Any] = None
        self._thread: Optional[threading.Thread] = None
        self._state = "waiting_device"
        self._attention = False
        self._blink = False
        self._status_text = "Starting..."

    def _make_image(self, color: tuple[int, int, int]) -> Any:
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse((6, 6, 58, 58), fill=color + (255,))
        draw.ellipse((20, 20, 44, 44), fill=(255, 255, 255, 230))
        return img

    def _pick_color(self) -> tuple[int, int, int]:
        if self._attention:
            self._blink = not self._blink
            return (255, 120, 200) if self._blink else (250, 250, 250)
        if self._state == "connected":
            return (90, 200, 120)
        if self._state == "error":
            return (220, 90, 90)
        return (235, 190, 80)

    def _menu(self) -> Any:
        return pystray.Menu(
            pystray.MenuItem(lambda item: f"Status: {self._status_text}", None, enabled=False),
            pystray.MenuItem("Open Log", self._on_open_log),
            pystray.MenuItem("Exit", self._on_exit),
        )

    def _on_open_log(self, icon: Any, item: Any) -> None:
        _ = (icon, item)
        try:
            os.startfile(str(LOG_PATH))  # type: ignore[attr-defined]
        except Exception as exc:
            self.logger.log(f"[tray] open log failed: {exc}")

    def _on_exit(self, icon: Any, item: Any) -> None:
        _ = (icon, item)
        self.stop_evt.set()
        try:
            icon.stop()
        except Exception:
            pass

    def _run_icon(self) -> None:
        if not HAS_TRAY:
            return
        icon = pystray.Icon("desktop-buddy-daemon")
        self._icon = icon
        icon.title = "Desktop Buddy Daemon"
        icon.icon = self._make_image(self._pick_color())
        icon.menu = self._menu()
        icon.run()

    def start(self) -> None:
        if not HAS_TRAY:
            self.logger.log("[tray] pystray/pillow not installed; tray disabled")
            return
        self._thread = threading.Thread(target=self._run_icon, name="tray-icon", daemon=True)
        self._thread.start()

    def update(self, state: str, attention: bool, status_text: str) -> None:
        self._state = state
        self._attention = attention
        self._status_text = status_text
        if self._icon is None:
            return
        try:
            self._icon.icon = self._make_image(self._pick_color())
            self._icon.title = f"Desktop Buddy: {status_text}"
            self._icon.update_menu()
        except Exception:
            pass

    def stop(self) -> None:
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Background daemon for serial_bridge.py")
    parser.add_argument("--port", default="auto", help="COM port or auto")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=19191)
    parser.add_argument("--permission-timeout", type=float, default=60.0)
    return parser.parse_args()


def read_health(host: str, http_port: int, timeout_s: float = 1.2) -> Optional[dict[str, Any]]:
    url = HEALTH_URL_TEMPLATE.format(host=host, port=http_port)
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.URLError:
        return None
    except Exception:
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def write_status_file(payload: dict[str, Any]) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def make_child_cmd(args: argparse.Namespace) -> list[str]:
    bridge_path = Path(__file__).resolve().parent / "serial_bridge.py"
    return [
        sys.executable,
        str(bridge_path),
        "--port",
        str(args.port),
        "--baud",
        str(args.baud),
        "--host",
        str(args.host),
        "--http-port",
        str(args.http_port),
        "--permission-timeout",
        str(args.permission_timeout),
    ]


def main() -> int:
    args = parse_args()
    logger = Logger(LOG_PATH)
    stop_evt = threading.Event()
    tray = TrayController(stop_evt, logger)

    def on_signal(sig: int, frame: Any) -> None:
        _ = (sig, frame)
        stop_evt.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    tray.start()
    logger.log("[daemon] starting")
    cmd = make_child_cmd(args)
    logger.log(f"[daemon] child cmd: {' '.join(cmd)}")
    child: Optional[subprocess.Popen[str]] = None

    try:
        while not stop_evt.is_set():
            if child is None or child.poll() is not None:
                if child is not None:
                    logger.log(f"[daemon] child exited with code {child.poll()}, restarting")
                    time.sleep(RESTART_DELAY_SECS)
                child = subprocess.Popen(
                    cmd,
                    cwd=str(Path(__file__).resolve().parent.parent),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
                logger.log(f"[daemon] child started pid={child.pid}")

            health = read_health(args.host, args.http_port)
            status = "waiting_device"
            status_text = "waiting_device"
            attention = False
            if health is None:
                status = "waiting_device"
                status_text = "bridge starting..."
            else:
                if health.get("serial_connected"):
                    status = "connected"
                    status_text = "connected"
                else:
                    status = "waiting_device"
                    status_text = "waiting_device"
                mode = str(health.get("mode", ""))
                attention = mode == "attention"
                if attention:
                    status_text = "attention"

            write_status_file(
                {
                    "ok": True,
                    "timestamp": int(time.time()),
                    "status": status,
                    "status_text": status_text,
                    "attention": attention,
                    "host": args.host,
                    "http_port": args.http_port,
                    "port": args.port,
                    "log_path": str(LOG_PATH),
                }
            )
            tray.update(status, attention, status_text)
            time.sleep(POLL_SECS)
    finally:
        logger.log("[daemon] stopping")
        tray.stop()
        if child is not None and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=5)
            except Exception:
                try:
                    child.kill()
                except Exception:
                    pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
