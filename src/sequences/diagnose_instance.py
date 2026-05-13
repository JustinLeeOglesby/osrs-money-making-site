"""Sanity check a BlueStacks instance: captures one frame via ADB and writes
it to disk. Lets you verify ADB is actually talking to the right emulator and
that templates have a chance of matching.

Run with env vars set, e.g.:
    $env:BS_ADB_DEVICE="127.0.0.1:5565"; $env:BS_WINDOW_TITLE="BlueStacks App Player 1"; `
        .\.venv\Scripts\python.exe src\sequences\diagnose_instance.py

Or invoke without env to test the default (player_0).

For each adb-listed device, also prints whether it's connected.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import cv2

from adb_input import ADB_PATH, DEVICE, android_resolution, connect, screencap

PROJECT_ROOT = Path(__file__).parent.parent.parent


def main() -> int:
    print(f"BS_ADB_DEVICE   = {os.environ.get('BS_ADB_DEVICE')!r}")
    print(f"BS_WINDOW_TITLE = {os.environ.get('BS_WINDOW_TITLE')!r}")
    print(f"Resolved DEVICE = {DEVICE!r}")
    print(f"ADB_PATH        = {ADB_PATH!r}")

    print("\n--- adb devices (full list) ---")
    out = subprocess.run([ADB_PATH, "devices"], capture_output=True, text=True)
    print(out.stdout.strip())
    if out.stderr.strip():
        print(f"stderr: {out.stderr.strip()}")

    print(f"\n--- connecting to {DEVICE} ---")
    try:
        connect()
        w, h = android_resolution()
        print(f"Android resolution: {w}x{h}")
    except Exception as e:
        print(f"ERROR: {e}")
        return 1

    print("\n--- capturing one frame ---")
    frame = screencap()
    out_path = PROJECT_ROOT / f"diagnose_{DEVICE.replace(':', '_').replace('.', '_')}.png"
    cv2.imwrite(str(out_path), frame)
    print(f"Wrote {out_path}")
    print("Open it to verify it shows the expected emulator's screen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
