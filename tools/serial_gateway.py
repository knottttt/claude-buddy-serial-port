#!/usr/bin/env python3
"""Thin serial I/O gateway — communicates with VS Code extension via stdin/stdout.

stdin  → JSON lines received from extension → written to serial port
stdout → JSON lines read from serial port   → forwarded to extension
stderr → diagnostic messages (not parsed by extension)

Special stdout lines emitted by this script (not from device):
  {"status":"connected","port":"<port>"}
  {"status":"disconnected"}
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import time
from typing import Optional

import serial
from serial import SerialException
from serial.tools import list_ports

RECONNECT_SECS = 1.0
AUTO_PORT = "auto"

USB_HINTS = ("m5", "m5stick", "cp210", "ch340", "wch", "usb serial",
             "silicon labs", "uart", "esp32")

PRIORITY_VIDPID = {
    (0x10C4, 0xEA60),  # CP210x
    (0x1A86, 0x7523),  # CH340
    (0x303A, 0x1001),  # ESP32-S3 USB-JTAG
}


def choose_auto_port() -> Optional[str]:
    ports = list(list_ports.comports())
    if not ports:
        return None

    def score(p):
        text = " ".join(str(x).lower() for x in (
            getattr(p, "device", ""), getattr(p, "name", ""),
            getattr(p, "description", ""), getattr(p, "manufacturer", ""),
            getattr(p, "hwid", ""),
        ))
        if "bluetooth" in text:
            return -1
        base = 0
        if any(h in text for h in USB_HINTS):
            base += 2
        vid = getattr(p, "vid", None)
        pid = getattr(p, "pid", None)
        if isinstance(vid, int) and isinstance(pid, int):
            base += 6 if (vid, pid) in PRIORITY_VIDPID else 1
        return base

    ranked = sorted(ports, key=score, reverse=True)
    top = ranked[0]
    return str(top.device) if score(top) > 0 else None


def emit_status(status: str, **kwargs) -> None:
    obj = {"status": status, **kwargs}
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def serial_reader(ser: serial.Serial, stop: threading.Event) -> None:
    buf = b""
    while not stop.is_set():
        try:
            chunk = ser.read(256)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", errors="replace").strip()
                if text.startswith("{"):
                    sys.stdout.write(text + "\n")
                    sys.stdout.flush()
        except SerialException:
            break
        except Exception:
            break


def stdin_reader(ser: serial.Serial, stop: threading.Event) -> None:
    for raw in sys.stdin:
        if stop.is_set():
            break
        line = raw.strip()
        if not line:
            continue
        try:
            ser.write((line + "\n").encode("utf-8"))
        except SerialException:
            break
        except Exception:
            break
    stop.set()


def connect(port_arg: str, baud: int) -> Optional[serial.Serial]:
    port = port_arg if port_arg != AUTO_PORT else choose_auto_port()
    if not port:
        print("[gateway] no suitable port found", file=sys.stderr)
        return None
    try:
        ser = serial.Serial(
            port, baud,
            timeout=0.3,
            write_timeout=1.0,
            dsrdtr=False,
            rtscts=False,
        )
        ser.dtr = False
        ser.rts = False
        print(f"[gateway] connected: {port} @ {baud}", file=sys.stderr)
        emit_status("connected", port=port)
        return ser
    except SerialException as e:
        print(f"[gateway] failed to open {port}: {e}", file=sys.stderr)
        return None


def main() -> None:
    # Make stdout line-buffered so extension receives lines immediately.
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, line_buffering=True)

    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", default=AUTO_PORT)
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()

    while True:
        ser = connect(args.port, args.baud)
        if ser is None:
            time.sleep(RECONNECT_SECS)
            continue

        stop = threading.Event()
        t_read = threading.Thread(target=serial_reader, args=(ser, stop), daemon=True)
        t_stdin = threading.Thread(target=stdin_reader, args=(ser, stop), daemon=True)
        t_read.start()
        t_stdin.start()

        # Wait until one thread signals stop (serial error or stdin EOF).
        stop.wait()
        try:
            ser.close()
        except Exception:
            pass
        emit_status("disconnected")
        print("[gateway] disconnected, reconnecting...", file=sys.stderr)

        # If stdin closed, exit entirely.
        if not t_stdin.is_alive() or sys.stdin.closed:
            break

        time.sleep(RECONNECT_SECS)


if __name__ == "__main__":
    main()
