"""Walk the BlueStacks UI Automation tree and print every control.

UIA exposes controls through Windows' accessibility API. If the stop_macro
button shows up here as a Button (or any clickable control) with a useful
Name/AutomationId, we can invoke it via Invoke() — which BlueStacks' synthetic-
input filter typically can't block.

If the dump shows only the top-level window and nothing inside, BlueStacks' Qt
UI is opaque to UIA and this approach won't work either.
"""
from __future__ import annotations

import sys

import uiautomation as auto

WINDOW_TITLE_SUBSTRING = "BlueStacks App Player"


def find_bluestacks_windows():
    """Find every top-level window whose title contains 'BlueStacks'."""
    matches = []
    for child in auto.GetRootControl().GetChildren():
        if child.Name and "bluestacks" in child.Name.lower():
            matches.append(child)
    return matches


def find_bluestacks_window():
    """Find the BlueStacks App Player window specifically."""
    for child in auto.GetRootControl().GetChildren():
        if child.Name and WINDOW_TITLE_SUBSTRING.lower() in child.Name.lower():
            return child
    return None


def walk(control, depth: int = 0, max_depth: int = 12) -> None:
    if depth > max_depth:
        return
    indent = "  " * depth
    name = repr(control.Name) if control.Name else ""
    auto_id = control.AutomationId or ""
    cls = control.ClassName or ""
    print(f"{indent}{control.ControlTypeName} {name}  AutomationId={auto_id!r}  Class={cls!r}")
    for child in control.GetChildren():
        walk(child, depth + 1, max_depth)


def main() -> int:
    bs_windows = find_bluestacks_windows()
    if not bs_windows:
        print("No BlueStacks windows found by UIA.")
        return 1
    print(f"Found {len(bs_windows)} BlueStacks window(s):")
    for w in bs_windows:
        print(f"  - {w.Name!r}  Class={w.ClassName!r}")
    print()
    for w in bs_windows:
        print(f"=== Tree for {w.Name!r} ===")
        walk(w)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
