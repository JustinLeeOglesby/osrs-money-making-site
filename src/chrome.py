"""Interact with the BlueStacks window chrome (toolbar/sidebar buttons).

Those buttons live OUTSIDE the Android render area, so ADB taps don't reach
them. We capture the full BlueStacks window with mss, template-match against
the chrome region, then click via pyautogui at Windows screen coordinates.

Templates for this module MUST be cropped from a full-window capture (use
`python src/chrome.py` to save one), not from an ADB capture.
"""
from __future__ import annotations

import os
import random
import sys
import time
from pathlib import Path

import ctypes
from ctypes import wintypes

import cv2
import pyautogui
import win32con
import win32gui

_user32 = ctypes.WinDLL("user32", use_last_error=True)

# --- SendInput definitions ---
# Real synthesized input — what hardware drivers would send. Cannot be filtered
# by application-level message handling.
INPUT_MOUSE = 0
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUT_UNION)]


_SendInput = _user32.SendInput
_SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
_SendInput.restype = wintypes.UINT

_SetCursorPos = _user32.SetCursorPos
_SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
_SetCursorPos.restype = wintypes.BOOL

_GetSystemMetrics = _user32.GetSystemMetrics
_GetSystemMetrics.argtypes = [ctypes.c_int]
_GetSystemMetrics.restype = ctypes.c_int


def _virtual_screen() -> tuple[int, int, int, int]:
    """(left, top, width, height) of the entire virtual screen across all monitors."""
    return (
        _GetSystemMetrics(SM_XVIRTUALSCREEN),
        _GetSystemMetrics(SM_YVIRTUALSCREEN),
        _GetSystemMetrics(SM_CXVIRTUALSCREEN),
        _GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def _to_absolute(screen_x: int, screen_y: int) -> tuple[int, int]:
    """Map physical screen coord to SendInput's 0-65535 virtual coord space."""
    vx, vy, vw, vh = _virtual_screen()
    nx = int(((screen_x - vx) * 65535) / max(vw - 1, 1))
    ny = int(((screen_y - vy) * 65535) / max(vh - 1, 1))
    return nx, ny

from printwin import capture_window_by_title
from screen import grab
from vision import Match, find_template
from window import bring_to_front, find_window

WINDOW_TITLE = os.environ.get("BS_WINDOW_TITLE", "BlueStacks App Player")
CHROME_TEMPLATES_DIR = Path(__file__).parent.parent / "templates" / "chrome"

pyautogui.FAILSAFE = True


def _template_path(name: str) -> str:
    p = Path(name)
    if p.is_absolute() and p.exists():
        return str(p)
    if not name.endswith(".png"):
        name += ".png"
    return str(CHROME_TEMPLATES_DIR / name)


def capture_window():
    """Full BlueStacks window capture (chrome included).

    Uses PrintWindow with PW_RENDERFULLCONTENT for hardware-accelerated content.
    Falls back to mss if PrintWindow's output is mostly black for any reason.
    """
    box = find_window(WINDOW_TITLE)
    try:
        frame = capture_window_by_title(WINDOW_TITLE)
        if frame.mean() < 5:  # essentially black
            print("  (PrintWindow returned near-black frame; falling back to mss)")
            frame = grab(box.as_region())
    except Exception as e:
        print(f"  (PrintWindow failed: {e}; falling back to mss)")
        frame = grab(box.as_region())
    return box, frame


def find_chrome(template: str, *, threshold: float = 0.85) -> tuple[Match, tuple[int, int]] | None:
    """Find a chrome template; returns (match_in_window_coords, screen_xy_of_center)."""
    box, frame = capture_window()
    match = find_template(frame, _template_path(template), threshold=threshold)
    if match is None:
        return None
    screen_x = box.left + match.center[0]
    screen_y = box.top + match.center[1]
    return match, (screen_x, screen_y)


def click_chrome(
    template: str,
    *,
    timeout: float = 5.0,
    poll_interval: float = 0.15,
    threshold: float = 0.85,
    debug: bool = True,
    double: bool = False,
) -> bool:
    """Wait for a chrome button to appear, then click it via pyautogui.

    When debug=True, saves debug_output/chrome_click_<template>.png with the
    detected match drawn on the captured window, so you can verify the bot
    aimed at the right pixel.
    """
    print(f"  [chrome] click_chrome('{template}') starting (timeout={timeout}s, threshold={threshold})")
    deadline = time.monotonic() + timeout
    last_best = 0.0
    polls = 0
    while time.monotonic() < deadline:
        polls += 1
        box, frame = capture_window()
        probe = find_template(frame, _template_path(template), threshold=0.0)
        if probe is not None and probe.confidence > last_best:
            last_best = probe.confidence
        match = probe if (probe is not None and probe.confidence >= threshold) else None
        if match is not None:
            print(f"  [chrome] MATCHED on poll {polls} (conf={match.confidence:.3f})")
            sx, sy = box.left + match.center[0], box.top + match.center[1]
            print(f"  [chrome:{template}] match at window ({match.center[0]},{match.center[1]}) "
                  f"conf={match.confidence:.3f} -> screen ({sx},{sy})")
            if debug:
                _save_click_debug(template, frame, match)
            _real_click(sx, sy, double=double)
            time.sleep(random.uniform(0.06, 0.14))
            return True
        time.sleep(poll_interval)
    print(f"  [chrome:{template}] NOT FOUND within {timeout}s after {polls} polls. "
          f"Best confidence seen: {last_best:.3f} (needed {threshold}).")
    print(f"  --> NO CLICK ATTEMPTED. Either lower threshold or re-crop template.")
    box, frame = capture_window()
    best = find_template(frame, _template_path(template), threshold=0.0)
    if best is not None and debug:
        _save_click_debug(template + "_miss", frame, best)
        print(f"  (best near-miss saved to debug_output/chrome_click_{template}_miss.png)")
    return False


def _get_cursor_pos() -> tuple[int, int]:
    pt = wintypes.POINT()
    _user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def _send_absolute_move(screen_x: int, screen_y: int) -> None:
    nx, ny = _to_absolute(screen_x, screen_y)
    move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    move = _INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=_MOUSEINPUT(
        nx, ny, 0, move_flags, 0, None)))
    _SendInput(1, ctypes.byref(move), ctypes.sizeof(_INPUT))


def _send_move_and_click(screen_x: int, screen_y: int) -> None:
    """Smoothly move the cursor toward (screen_x, screen_y), hover, click.
    Real users don't teleport — some apps filter teleport-then-click as
    synthetic input. This walks the cursor along an interpolated path."""
    start_x, start_y = _get_cursor_pos()
    steps = 18
    print(f"  [chrome] smooth move from ({start_x},{start_y}) -> ({screen_x},{screen_y}) in {steps} steps")
    for i in range(1, steps + 1):
        t = i / steps
        # Ease-out so the cursor slows as it arrives (more human-looking).
        eased = 1 - (1 - t) ** 2
        ix = round(start_x + (screen_x - start_x) * eased)
        iy = round(start_y + (screen_y - start_y) * eased)
        # Add tiny random jitter except at the final step.
        if i < steps:
            ix += random.randint(-1, 1)
            iy += random.randint(-1, 1)
        _send_absolute_move(ix, iy)
        time.sleep(random.uniform(0.008, 0.018))
    # Land exactly on target.
    _send_absolute_move(screen_x, screen_y)
    # Hover so any hover-state UI updates before the click.
    time.sleep(random.uniform(0.12, 0.20))
    down = _INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=_MOUSEINPUT(
        0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, None)))
    up = _INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=_MOUSEINPUT(
        0, 0, 0, MOUSEEVENTF_LEFTUP, 0, None)))
    _SendInput(1, ctypes.byref(down), ctypes.sizeof(_INPUT))
    time.sleep(random.uniform(0.06, 0.12))
    _SendInput(1, ctypes.byref(up), ctypes.sizeof(_INPUT))


def _real_click(screen_x: int, screen_y: int, *, double: bool = False) -> None:
    """Original chrome-click: just pyautogui move + click. No focus, no alt-tap,
    no SendInput. This is the FIRST version that fired the button at all
    (intermittently). Restored verbatim per user request.
    """
    print(f"  [chrome] _real_click targeting screen ({screen_x},{screen_y})")
    time.sleep(random.uniform(0.04, 0.10))
    pyautogui.moveTo(screen_x, screen_y, duration=random.uniform(0.10, 0.20))
    pyautogui.click()
    if double:
        time.sleep(random.uniform(0.06, 0.10))
        pyautogui.click()
    time.sleep(random.uniform(0.06, 0.14))
    print(f"  [chrome] {'double-' if double else ''}click via pyautogui complete")


def _save_click_debug(label: str, frame, match) -> None:
    out = Path(__file__).parent.parent / "debug_output"
    out.mkdir(exist_ok=True)
    debug_img = frame.copy()
    cv2.rectangle(
        debug_img,
        (match.x, match.y),
        (match.x + match.w, match.y + match.h),
        (0, 255, 0),
        2,
    )
    cv2.drawMarker(debug_img, match.center, (0, 0, 255), cv2.MARKER_CROSS, 20, 2)
    safe = "".join(c if c.isalnum() else "_" for c in label)
    path = out / f"chrome_click_{safe}.png"
    cv2.imwrite(str(path), debug_img)
    print(f"  (debug image: {path})")


if __name__ == "__main__":
    CHROME_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    box, frame = capture_window()
    print(f"Window: '{box.title}' ({box.left},{box.top}) {box.width}x{box.height}")
    out = Path(__file__).parent.parent / "window_capture.png"
    cv2.imwrite(str(out), frame)
    print(f"Wrote {out} — crop toolbar buttons from this into templates/chrome/")
    print(f"Templates dir: {CHROME_TEMPLATES_DIR}")

    if len(sys.argv) > 1:
        # Test a chrome click: `python src/chrome.py settings`
        click_chrome(sys.argv[1])
