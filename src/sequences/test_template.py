"""Quick sanity check: does a template match the current screen?

Usage:
    python src/sequences/test_template.py green_hide
    python src/sequences/test_template.py chest 5      # 5 polls 0.5s apart

Prints best confidence each poll and saves a debug image to
debug_output/test_<name>.png with a green box on the best match.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import cv2

from flow import ensure_connected, screencap
from vision import find_template

PROJECT_ROOT = Path(__file__).parent.parent.parent


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python src/sequences/test_template.py <template_name> [polls]")
        return 1
    name = sys.argv[1]
    polls = int(sys.argv[2]) if len(sys.argv) > 2 else 1

    template_path = PROJECT_ROOT / "templates" / f"{name}.png"
    if not template_path.exists():
        print(f"Missing template: {template_path}")
        return 1

    ensure_connected()
    out_dir = PROJECT_ROOT / "debug_output"
    out_dir.mkdir(exist_ok=True)

    for i in range(1, polls + 1):
        frame = screencap()
        best = find_template(frame, str(template_path), threshold=0.0)
        if best is None:
            print(f"[{i}/{polls}] no template result at all (template load issue?)")
        else:
            print(f"[{i}/{polls}] best confidence: {best.confidence:.3f}  at ({best.center[0]},{best.center[1]})")
            debug = frame.copy()
            cv2.rectangle(
                debug,
                (best.x, best.y),
                (best.x + best.w, best.y + best.h),
                (0, 255, 0),
                2,
            )
            cv2.putText(
                debug,
                f"{name} conf={best.confidence:.3f}",
                (best.x, max(20, best.y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0),
                2,
            )
            path = out_dir / f"test_{name}.png"
            cv2.imwrite(str(path), debug)
            if i == 1:
                print(f"  debug image: {path}")
        if i < polls:
            time.sleep(0.5)

    return 0


if __name__ == "__main__":
    sys.exit(main())
