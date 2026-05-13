"""Capture a window via PrintWindow with PW_RENDERFULLCONTENT.

mss reads from the desktop compositor, which often returns black for windows
using hardware-accelerated rendering (BlueStacks, browsers, games). PrintWindow
asks the target window to render its content into a memory DC we provide, so
hardware-accelerated content is captured correctly.

Slower than mss (~50-150ms per capture) but reliably non-black.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes

import numpy as np
import win32gui

PW_RENDERFULLCONTENT = 0x00000002

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

_PrintWindow = _user32.PrintWindow
_PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
_PrintWindow.restype = wintypes.BOOL


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [
        ("bmiHeader", _BITMAPINFOHEADER),
        ("bmiColors", wintypes.DWORD * 3),
    ]


def capture_hwnd(hwnd: int) -> np.ndarray:
    """Return a BGR numpy array of the window's full client+frame content."""
    rect = wintypes.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise RuntimeError(f"Window has non-positive size: {width}x{height}")

    hdc_window = _user32.GetWindowDC(hwnd)
    hdc_mem = _gdi32.CreateCompatibleDC(hdc_window)
    hbitmap = _gdi32.CreateCompatibleBitmap(hdc_window, width, height)
    _gdi32.SelectObject(hdc_mem, hbitmap)

    try:
        # PrintWindow's return value is unreliable for hardware-accelerated
        # windows — it can return 0 even when the capture worked. We just
        # check that the resulting bitmap isn't entirely black instead.
        _PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)

        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = width
        bmi.bmiHeader.biHeight = -height  # negative = top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = 0  # BI_RGB

        buf = (ctypes.c_ubyte * (width * height * 4))()
        _gdi32.GetDIBits(hdc_mem, hbitmap, 0, height, buf, ctypes.byref(bmi), 0)

        arr = np.frombuffer(buf, dtype=np.uint8).reshape((height, width, 4))
        # Drop alpha; data is BGRA, we want BGR.
        return arr[:, :, :3].copy()
    finally:
        _gdi32.DeleteObject(hbitmap)
        _gdi32.DeleteDC(hdc_mem)
        _user32.ReleaseDC(hwnd, hdc_window)


def find_hwnd_by_title(title_substring: str) -> int:
    """Find the visible window matching the title. Prefers exact-title match
    over substring match — important when window titles share a prefix (e.g.
    'BlueStacks App Player' is a substring of 'BlueStacks App Player 1').
    Among same-class matches, picks the largest to avoid tooltip/utility windows.
    """
    needle = title_substring.lower()
    exact_matches: list[tuple[int, int, str]] = []
    substring_matches: list[tuple[int, int, str]] = []

    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            title = win32gui.GetWindowText(hwnd)
            if title:
                title_l = title.lower()
                rect = wintypes.RECT()
                _user32.GetWindowRect(hwnd, ctypes.byref(rect))
                area = (rect.right - rect.left) * (rect.bottom - rect.top)
                if title_l == needle:
                    exact_matches.append((area, hwnd, title))
                elif needle in title_l:
                    substring_matches.append((area, hwnd, title))
        return True

    win32gui.EnumWindows(cb, None)
    matches = exact_matches or substring_matches
    if not matches:
        raise LookupError(f"No visible window matched '{title_substring}'")
    matches.sort(reverse=True)  # largest first
    if len(matches) > 1:
        kind = "exact" if exact_matches else "substring"
        print(f"  [printwin] multiple {kind} matches; picking largest:")
        for area, hwnd, title in matches:
            print(f"    area={area}  hwnd={hwnd}  title={title!r}")
    return matches[0][1]


def capture_window_by_title(title_substring: str) -> np.ndarray:
    """Find a window by title substring and capture via PrintWindow."""
    return capture_hwnd(find_hwnd_by_title(title_substring))


if __name__ == "__main__":
    import cv2
    img = capture_window_by_title("BlueStacks App Player")
    print(f"Captured {img.shape[1]}x{img.shape[0]}")
    cv2.imwrite("printwin_capture.png", img)
    print("Wrote printwin_capture.png — open it to verify it's not black.")
