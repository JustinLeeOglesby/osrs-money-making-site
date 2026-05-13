"""Find a window by title and translate window-local coords to screen coords.

Used to capture and click just inside BlueStacks (or any specific window)
instead of the entire desktop.
"""
from __future__ import annotations

from dataclasses import dataclass

import ctypes
from ctypes import wintypes

import pygetwindow as gw
import win32gui

_DWMWA_EXTENDED_FRAME_BOUNDS = 9
_dwmapi = ctypes.WinDLL("dwmapi")


def _visible_bounds(hwnd: int) -> tuple[int, int, int, int]:
    """Return (left, top, right, bottom) of the window's visible area,
    excluding Windows' invisible resize-border padding."""
    rect = wintypes.RECT()
    _dwmapi.DwmGetWindowAttribute(
        wintypes.HWND(hwnd),
        ctypes.c_uint(_DWMWA_EXTENDED_FRAME_BOUNDS),
        ctypes.byref(rect),
        ctypes.sizeof(rect),
    )
    return rect.left, rect.top, rect.right, rect.bottom


@dataclass
class WindowBox:
    title: str
    left: int
    top: int
    width: int
    height: int

    def as_region(self) -> dict:
        """Region dict in the shape mss.grab() expects."""
        return {"top": self.top, "left": self.left, "width": self.width, "height": self.height}

    def to_screen(self, x: int, y: int) -> tuple[int, int]:
        """Translate window-local (x, y) to absolute screen coords for clicking."""
        return self.left + x, self.top + y


def find_window(title_substring: str) -> WindowBox:
    """Find a visible window matching `title_substring` (case-insensitive).

    Prefers an EXACT title match before falling back to substring match. This
    matters for multi-instance BlueStacks: 'BlueStacks App Player' is a
    substring of 'BlueStacks App Player 1', so a naive substring search would
    grab the wrong window depending on z-order.

    Uses DWM extended frame bounds so the box matches the visible window, not
    the invisible resize-border that GetWindowRect reports on Win10/11.
    """
    needle = title_substring.lower()
    exact_match = None
    substring_match = None
    for w in gw.getAllWindows():
        if not (w.title and w.visible and w.width > 0):
            continue
        title_l = w.title.lower()
        if title_l == needle and exact_match is None:
            exact_match = w
        elif needle in title_l and substring_match is None:
            substring_match = w
    winner = exact_match or substring_match
    if winner is None:
        raise LookupError(f"No visible window matched '{title_substring}'")
    hwnd = win32gui.FindWindow(None, winner.title)
    if hwnd:
        left, top, right, bottom = _visible_bounds(hwnd)
        return WindowBox(title=winner.title, left=left, top=top,
                         width=right - left, height=bottom - top)
    return WindowBox(title=winner.title, left=winner.left, top=winner.top,
                     width=winner.width, height=winner.height)


def bring_to_front(title_substring: str) -> None:
    """Focus the window so input events land in it.

    Works around Windows' SetForegroundWindow restrictions by:
    1. Restoring the window if minimized.
    2. Briefly pressing Alt — Windows grants foreground rights to the calling
       process for ~1 second after any user input, which our Alt tap satisfies.
    """
    import win32con

    box = find_window(title_substring)
    hwnd = win32gui.FindWindow(None, box.title)
    if not hwnd:
        return

    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)

    # The Alt-key trick — grants this process foreground rights.
    ctypes.windll.user32.keybd_event(0x12, 0, 0, 0)        # Alt down
    ctypes.windll.user32.keybd_event(0x12, 0, 0x0002, 0)   # Alt up
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception as e:
        print(f"  (SetForegroundWindow failed: {e})")


if __name__ == "__main__":
    # Quick check: list every visible window so you know what title to target.
    for w in gw.getAllWindows():
        if w.title and w.visible and w.width > 100:
            print(f"{w.width:>5}x{w.height:<5}  {w.title}")
