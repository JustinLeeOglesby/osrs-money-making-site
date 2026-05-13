"""Send input to BlueStacks via ADB (Android Debug Bridge).

Bypasses Windows input entirely — BlueStacks can't filter these events because
they originate inside Android. Slower than pyautogui (~30-80ms per tap) but
rock-solid reliable.

Coordinates are Android-internal (the resolution shown by `adb shell wm size`),
NOT Windows screen coords. Use `scale_to_android()` to convert from a match
position inside a screenshot of the BlueStacks window.
"""

from __future__ import annotations

import os
import random
import shutil
import subprocess
import time
from functools import lru_cache

import cv2
import numpy as np

# Override with env var if adb isn't on PATH, e.g.:
#   $env:ADB_PATH = "C:\Users\you\platform-tools\adb.exe"
ADB_PATH = os.environ.get("ADB_PATH") or shutil.which("adb") or "adb"
# BS_ADB_DEVICE wins over ADB_DEVICE so the multi-instance GUI can scope each
# subprocess; ADB_DEVICE kept for backward compat with single-instance use.
DEVICE = os.environ.get("BS_ADB_DEVICE") or os.environ.get("ADB_DEVICE", "127.0.0.1:5555")


def _adb(*args: str, capture: bool = False) -> bytes:
    cmd = [ADB_PATH, "-s", DEVICE, *args]
    result = subprocess.run(cmd, capture_output=True, check=True)
    return result.stdout if capture else b""


def connect() -> None:
    """Ensure the ADB server can see the BlueStacks device."""
    subprocess.run([ADB_PATH, "connect", DEVICE], capture_output=True, check=True)


@lru_cache(maxsize=1)
def android_resolution() -> tuple[int, int]:
    """Return (width, height) of the Android display inside BlueStacks."""
    out = _adb("shell", "wm", "size", capture=True).decode().strip()
    # Output looks like: "Physical size: 1600x900"
    size = out.split(":")[-1].strip()
    w, h = size.split("x")
    return int(w), int(h)


def scale_to_android(
    x: int, y: int, window_width: int, window_height: int
) -> tuple[int, int]:
    """Map a window-local pixel coord to Android-internal coords."""
    aw, ah = android_resolution()
    return round(x * aw / window_width), round(y * ah / window_height)


def tap(x: int, y: int) -> None:
    """Tap Android coords (x, y). Coords are pre-scaled — use scale_to_android first."""
    _adb("shell", "input", "tap", str(x), str(y))


def swipe(x1: int, y1: int, x2: int, y2: int, duration_ms: int = 200) -> None:
    _adb(
        "shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration_ms)
    )


def key(keycode: str) -> None:
    """Send an Android keycode, e.g. 'KEYCODE_BACK' or '4' (back)."""
    _adb("shell", "input", "keyevent", keycode)


def screencap_png() -> np.ndarray:
    """Slow path: screencap -p (PNG-encoded). ~250-400ms. Use as fallback."""
    png_bytes = _adb("exec-out", "screencap", "-p", capture=True)
    arr = np.frombuffer(png_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("screencap returned no decodable image")
    return img


# Cached after first successful raw capture to skip header probing.
_RAW_HEADER_SIZE: int | None = None


def screencap() -> np.ndarray:
    """Fast path: raw screencap (no PNG). ~80-120ms, ~3x faster than -p.

    Android writes a small header (12 or 16 bytes depending on version)
    followed by RGBA pixel data. We auto-detect the header size on first call.
    """
    global _RAW_HEADER_SIZE
    raw = _adb("exec-out", "screencap", capture=True)
    if len(raw) < 16:
        # Output too small to be a real frame — emulator might be off-display.
        return screencap_png()

    # First 12 bytes are always: width, height, format (LE uint32).
    header = np.frombuffer(raw[:16], dtype="<u4")
    width, height = int(header[0]), int(header[1])

    if _RAW_HEADER_SIZE is None:
        # Probe: try 12-byte header first; if pixel count is wrong, try 16.
        for hdr in (12, 16):
            expected = width * height * 4
            if len(raw) - hdr == expected:
                _RAW_HEADER_SIZE = hdr
                break
        else:
            # No header size matched — fall back to PNG path permanently for this run.
            print("  (raw screencap header didn't match; falling back to PNG)")
            return screencap_png()

    pixels = np.frombuffer(raw[_RAW_HEADER_SIZE:], dtype=np.uint8)
    if pixels.size != width * height * 4:
        # Format changed mid-run (unlikely); re-probe next call.
        _RAW_HEADER_SIZE = None
        return screencap_png()

    img = pixels.reshape((height, width, 4))
    # Android gives RGBA; OpenCV wants BGR.
    return cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)


def human_tap(x: int, y: int) -> None:
    """Tap with a small randomized delay to look less robotic."""
    time.sleep(random.uniform(0.04, 0.12))
    tap(x, y)
    time.sleep(random.uniform(0.06, 0.18))


if __name__ == "__main__":
    connect()
    w, h = android_resolution()
    print(f"Android display: {w}x{h}")
    print("Taking screenshot via ADB...")
    img = screencap()
    cv2.imwrite("adb_capture.png", img)
    print(f"Wrote adb_capture.png ({img.shape[1]}x{img.shape[0]})")
