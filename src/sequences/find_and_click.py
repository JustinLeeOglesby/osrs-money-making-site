"""Minimal sandbox: find one template on screen, tap it. Nothing else.

Edit TARGET to the template name (without .png) you want to click.
Drop the PNG in templates/<TARGET>.png.

Usage:
    python src/sequences/find_and_click.py
    python src/sequences/find_and_click.py some_other_template   # override at runtime
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from flow import ensure_connected, tap_when_seen

TARGET = "chest"
TIMEOUT = 5.0
THRESHOLD = 0.85


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else TARGET
    ensure_connected()
    print(f"Looking for [{target}] (timeout={TIMEOUT}s, threshold={THRESHOLD})...")
    ok = tap_when_seen(target, timeout=TIMEOUT, threshold=THRESHOLD)
    print("tapped" if ok else "not found")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
