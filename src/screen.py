"""Screen capture helpers built on mss (fast multi-monitor screenshots)."""
from __future__ import annotations

import mss
import numpy as np


def grab(region: dict | None = None) -> np.ndarray:
    """Capture the screen (or a region) and return a BGR numpy array.

    region example: {"top": 100, "left": 200, "width": 800, "height": 600}
    If region is None, captures the primary monitor.
    """
    with mss.MSS() as sct:
        target = region if region is not None else sct.monitors[1]
        raw = sct.grab(target)
        img = np.array(raw)  # BGRA
        return img[:, :, :3]  # drop alpha -> BGR (OpenCV's native order)


if __name__ == "__main__":
    import sys
    import cv2
    from window import find_window

    title = sys.argv[1] if len(sys.argv) > 1 else "BlueStacks App Player"
    try:
        box = find_window(title)
        print(f"Targeting '{box.title}' at ({box.left},{box.top}) {box.width}x{box.height}")
        frame = grab(box.as_region())
    except LookupError as e:
        print(f"{e}\nFalling back to primary monitor.")
        frame = grab()

    print(f"Captured {frame.shape[1]}x{frame.shape[0]} frame")
    cv2.imwrite("capture.png", frame)
    print("Wrote capture.png")
