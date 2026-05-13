"""Entry point: screenshot -> find template -> tap via ADB.

Two capture modes:
- CAPTURE_VIA_ADB = True : pull screenshot from Android directly. Slower (~300ms)
  but bypasses BlueStacks window chrome, so match coords ARE Android coords.
  Templates must be cropped from an ADB capture, not a window capture.
- CAPTURE_VIA_ADB = False: fast mss capture of the BlueStacks window, then scale
  to Android coords. Will drift if BlueStacks chrome eats into the window.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import cv2

from adb_input import connect, human_tap, scale_to_android, screencap
from screen import grab
from vision import find_template
from window import find_window

WINDOW_TITLE = "BlueStacks App Player"
TEMPLATE = Path(__file__).parent.parent / "templates" / "chest.png"
THRESHOLD = 0.85
DRY_RUN = False
CAPTURE_VIA_ADB = True


def main() -> int:
    if not TEMPLATE.exists():
        print(f"Missing template: {TEMPLATE}")
        return 1

    print("Capturing in 2s...")
    time.sleep(2)

    if CAPTURE_VIA_ADB:
        connect()
        frame = screencap()
        box = None
    else:
        try:
            box = find_window(WINDOW_TITLE)
        except LookupError as e:
            print(e)
            print("Tip: run `python src/window.py` to list visible window titles.")
            return 1
        print(
            f"Targeting '{box.title}' at ({box.left},{box.top}) {box.width}x{box.height}"
        )
        frame = grab(box.as_region())

    print(f"Frame: {frame.shape[1]}x{frame.shape[0]}")

    match = find_template(frame, str(TEMPLATE), threshold=THRESHOLD)
    if match is None:
        print(f"No match above {THRESHOLD}")
        out = Path(__file__).parent.parent / "debug_output"
        out.mkdir(exist_ok=True)
        cv2.imwrite(str(out / "no_match_frame.png"), frame)
        print(
            f"Wrote {out / 'no_match_frame.png'} so you can inspect what was captured"
        )
        return 1

    print(f"Match at window-local {match.center} (confidence {match.confidence:.3f})")

    debug = frame.copy()
    cv2.rectangle(
        debug,
        (match.x, match.y),
        (match.x + match.w, match.y + match.h),
        (0, 255, 0),
        2,
    )
    out = Path(__file__).parent.parent / "debug_output"
    out.mkdir(exist_ok=True)
    cv2.imwrite(str(out / "match.png"), debug)
    print(f"Wrote {out / 'match.png'}")

    if not DRY_RUN:
        if CAPTURE_VIA_ADB:
            ax, ay = match.center
        else:
            connect()
            ax, ay = scale_to_android(*match.center, box.width, box.height)
        print(f"Tapping Android coord ({ax},{ay})")
        human_tap(ax, ay)

    return 0


if __name__ == "__main__":
    sys.exit(main())
