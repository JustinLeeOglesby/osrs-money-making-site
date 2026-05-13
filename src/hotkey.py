"""Send keyboard shortcuts to BlueStacks via SendInput.

Way more reliable than image-recognition button clicks — no template matching,
no focus race, no custom-rendered UI to fight. Just press the key BlueStacks
already knows means "stop macro".

Usage:
    from hotkey import send_hotkey
    send_hotkey("f8")
    send_hotkey("ctrl+shift+8")
"""
from __future__ import annotations

import ctypes
import os
import time
from ctypes import wintypes

from window import bring_to_front

WINDOW_TITLE = os.environ.get("BS_WINDOW_TITLE", "BlueStacks App Player")

_user32 = ctypes.WinDLL("user32", use_last_error=True)

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

# Virtual-key codes for common keys (full list at learn.microsoft.com).
_VK = {
    "ctrl": 0x11, "control": 0x11,
    "shift": 0x10,
    "alt": 0x12, "menu": 0x12,
    "win": 0x5B,
    "enter": 0x0D, "return": 0x0D,
    "esc": 0x1B, "escape": 0x1B,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "delete": 0x2E, "del": 0x2E,
    "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    **{f"f{i}": 0x6F + i for i in range(1, 13)},  # F1..F12 -> 0x70..0x7B
}


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUT_UNION)]


_SendInput = _user32.SendInput
_SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
_SendInput.restype = wintypes.UINT


def _vk_for(key: str) -> int:
    key = key.lower().strip()
    if key in _VK:
        return _VK[key]
    if len(key) == 1:
        # Letters and digits: VK code == uppercase ASCII.
        return ord(key.upper())
    raise ValueError(f"Unknown key: {key!r}")


def _key_event(vk: int, key_up: bool) -> None:
    flags = KEYEVENTF_KEYUP if key_up else 0
    inp = _INPUT(type=INPUT_KEYBOARD, u=_INPUT_UNION(ki=_KEYBDINPUT(vk, 0, flags, 0, None)))
    _SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))


def send_hotkey(combo: str, *, focus_bluestacks: bool = True) -> None:
    """Send a hotkey like 'f8' or 'ctrl+shift+8'.

    Presses each modifier down in order, presses the final key, releases all
    in reverse — same as a user would.
    """
    parts = [p.strip() for p in combo.split("+")]
    if focus_bluestacks:
        try:
            bring_to_front(WINDOW_TITLE)
            time.sleep(0.12)
        except Exception as e:
            print(f"  (couldn't focus BlueStacks: {e})")
    vks = [_vk_for(p) for p in parts]
    print(f"  [hotkey] sending {combo}")
    for vk in vks:
        _key_event(vk, key_up=False)
        time.sleep(0.02)
    time.sleep(0.05)
    for vk in reversed(vks):
        _key_event(vk, key_up=True)
        time.sleep(0.02)


if __name__ == "__main__":
    import sys
    combo = sys.argv[1] if len(sys.argv) > 1 else "f8"
    print(f"Sending hotkey '{combo}' to BlueStacks in 2s...")
    time.sleep(2)
    send_hotkey(combo)
    print("Done.")
