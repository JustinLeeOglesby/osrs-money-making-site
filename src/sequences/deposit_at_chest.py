"""Example sequence: walk up to a chest, open it, deposit inventory, close.

Each step waits for visual confirmation before acting. If any step times out,
the sequence bails and writes the last frame to debug_output/.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `python src/sequences/deposit_at_chest.py` to import siblings.
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow import (
    ensure_connected,
    tap_all_visible,
    tap_until_gone,
    tap_when_seen,
    wait_for,
    wait_until_gone,
)


def run() -> bool:
    ensure_connected()

    steps = [
        ("Click All Herbs", lambda: tap_all_visible("herb", threshold=0.90)),
        # ("Wait for menu",    lambda: wait_for("deposit_inventory", timeout=5) is not None),
        # ("Second Step Tap Here", lambda: tap_when_seen("tap_here_play", timeout=20)),
        # # ("Confirm closed", lambda: wait_until_gone("deposit_inventory", timeout=5)),
        # ("Open bag", lambda: tap_when_seen("bag_closed", timeout=5)),
    ]

    for label, step in steps:
        print(f"-> {label}")
        if not step():
            print(f"   FAILED at: {label}")
        return False
    print("Sequence complete.")
    return True


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
