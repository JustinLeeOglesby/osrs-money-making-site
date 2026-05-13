"""Mouse and keyboard input.

pyautogui works for most apps. Some games ignore it because they read DirectInput
scancodes; pydirectinput is the fallback for those. Try pyautogui first.
"""
from __future__ import annotations

import random
import time

import pyautogui
import pydirectinput

pyautogui.FAILSAFE = True  # slam mouse to a corner to abort
pydirectinput.FAILSAFE = True
pydirectinput.PAUSE = 0  # we handle our own timing


def human_sleep(low: float = 0.08, high: float = 0.22) -> None:
    time.sleep(random.uniform(low, high))


def move_to(x: int, y: int, duration: float | None = None) -> None:
    if duration is None:
        duration = random.uniform(0.12, 0.28)
    pyautogui.moveTo(x, y, duration=duration)


def click(x: int, y: int, button: str = "left", *, use_directinput: bool = True) -> None:
    """Click at (x, y). Defaults to pydirectinput because BlueStacks and many
    games ignore pyautogui's synthetic click events but honor DirectInput."""
    move_to(x, y)
    human_sleep(0.04, 0.10)
    if use_directinput:
        pydirectinput.click(x=x, y=y, button=button)
    else:
        pyautogui.click(button=button)


def press(key: str, *, use_directinput: bool = True) -> None:
    if use_directinput:
        pydirectinput.press(key)
    else:
        pyautogui.press(key)
    human_sleep()
