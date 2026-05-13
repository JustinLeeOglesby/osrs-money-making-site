"""Fast capture path: mss window grab -> crop chrome -> scale to Android coords.

~15-30ms per frame vs ~1000ms for `adb screencap`. Output is dimensionally
identical to `adb_input.screencap()`, so the same templates work either way.

How it works:
- The BlueStacks window contains the Android render plus a sidebar/toolbar.
- Android aspect ratio is known (from `adb shell wm size`).
- We fit the Android aspect inside the window (anchored top-left) to find the
  render rect, crop to it, then resize to the Android resolution.

Calibration: if taps drift after switching to this, re-run
`python src/fast_capture.py` — it saves a debug image with the detected
render rect overlaid so you can verify it matches the Android display area.
"""

from __future__ import annotations

import os
import time
from functools import lru_cache

import cv2
import numpy as np

from adb_input import android_resolution
from screen import grab
from window import find_window

WINDOW_TITLE = os.environ.get("BS_WINDOW_TITLE", "BlueStacks App Player")


_cached_window_size: tuple[int, int] | None = None


@lru_cache(maxsize=1)
def _render_geometry() -> tuple[int, int, int, int, int, int]:
    """Locate the Android render rect inside the BlueStacks window by aligning
    an ADB reference frame against an mss window capture (template-match).

    Returns (crop_x, crop_y, crop_w, crop_h, android_w, android_h). Cached.
    """
    from adb_input import connect, screencap as adb_screencap

    box = find_window(WINDOW_TITLE)
    aw, ah = android_resolution()
    connect()
    reference = adb_screencap()  # Android-resolution truth frame
    window_img = grab(box.as_region())

    # Downscale the reference to plausible render sizes (by height) and find
    # which scale matches best inside the window capture.
    aspect = aw / ah
    best = (-1.0, 0, 0, 0, 0)  # (score, x, y, w, h)
    for render_h in range(max(50, box.height // 2), box.height + 1, 4):
        render_w = round(render_h * aspect)
        if render_w > box.width:
            continue
        resized = cv2.resize(
            reference, (render_w, render_h), interpolation=cv2.INTER_AREA
        )
        result = cv2.matchTemplate(window_img, resized, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        if score > best[0]:
            best = (score, loc[0], loc[1], render_w, render_h)

    score, cx, cy, cw, ch = best
    print(f"  calibrated render rect: ({cx},{cy}) {cw}x{ch}  match={score:.3f}")
    if score < 0.5:
        print("  WARNING: low calibration confidence — fast capture may be misaligned.")
    return cx, cy, cw, ch, aw, ah


def screencap_fast() -> np.ndarray:
    """Capture the Android render area via mss and scale to Android coords."""
    global _cached_window_size
    box = find_window(WINDOW_TITLE)
    # Auto-recalibrate if the window was resized since the last capture.
    if _cached_window_size != (box.width, box.height):
        if _cached_window_size is not None:
            print(f"  (window resized {_cached_window_size} -> ({box.width},{box.height}); recalibrating)")
        _render_geometry.cache_clear()
        _cached_window_size = (box.width, box.height)
    raw = grab(box.as_region())
    cx, cy, cw, ch, aw, ah = _render_geometry()
    cropped = raw[cy : cy + ch, cx : cx + cw]
    if cropped.shape[1] == aw and cropped.shape[0] == ah:
        return cropped
    return cv2.resize(cropped, (aw, ah), interpolation=cv2.INTER_AREA)


def reset_geometry_cache() -> None:
    """Call after resizing the BlueStacks window."""
    _render_geometry.cache_clear()


if __name__ == "__main__":
    # Benchmark and write a calibration image with the detected render rect.
    from adb_input import connect, screencap as adb_screencap

    connect()
    cx, cy, cw, ch, aw, ah = _render_geometry()
    print(f"Window render rect: ({cx},{cy}) {cw}x{ch}  ->  Android {aw}x{ah}")

    # Warm up
    screencap_fast()
    N = 10
    t0 = time.perf_counter()
    for _ in range(N):
        screencap_fast()
    fast_ms = (time.perf_counter() - t0) * 1000 / N
    print(f"fast capture: {fast_ms:6.1f} ms/frame  (x{N} avg)")

    fast_frame = screencap_fast()
    adb_frame = adb_screencap()
    cv2.imwrite("fast_capture.png", fast_frame)
    cv2.imwrite("adb_capture.png", adb_frame)
    print(
        "Wrote fast_capture.png (mss path) and adb_capture.png (adb path) — visually compare"
    )
