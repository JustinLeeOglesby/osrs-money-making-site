"""Isolated test: try clicking a chrome template a few times.

Usage:
    python src/sequences/test_chrome_click.py                  # default: stop_macro
    python src/sequences/test_chrome_click.py home             # target by name
    python src/sequences/test_chrome_click.py stop_macro 5     # try 5 times

Each attempt:
- captures the BlueStacks window
- locates the template
- saves a debug image with the click target overlaid
- fires the click
- waits 1.5s so you can watch what happens
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from chrome import click_chrome


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else "stop_macro"
    attempts = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    double = "--double" in sys.argv

    template_file = Path(__file__).parent.parent.parent / "templates" / "chrome" / f"{target}.png"
    if not template_file.exists():
        print(f"Missing template: {template_file}")
        print(f"Drop a PNG of the chrome button at that path, then re-run.")
        return 1

    print(f"Testing chrome click for [{target}] x{attempts}")
    print("Make sure BlueStacks is visible. Starting in 2s...")
    time.sleep(2)

    successes = 0
    for i in range(1, attempts + 1):
        print(f"\n--- attempt {i}/{attempts} ---")
        ok = click_chrome(target, timeout=3.0, double=double)
        if ok:
            successes += 1
            print(f"  reported: clicked")
        else:
            print(f"  reported: not found / failed")
        time.sleep(1.5)

    print(f"\nDone. {successes}/{attempts} attempts reported success.")
    print(f"Check debug_output/chrome_click_{target}.png to verify the click target.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(130)
