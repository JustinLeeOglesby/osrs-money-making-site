"""Sequence primitives: wait for things to appear, then act.

Built on top of adb_input.screencap (Android-native capture) so coords are
ADB-tap-ready with no scaling.
"""
from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np

from adb_input import android_resolution, connect, human_tap, swipe
from adb_input import screencap as _adb_screencap
from fast_capture import screencap_fast
from vision import Match, find_all, find_template

# Toggle: True = mss window capture (~40ms), False = adb screencap (~1000ms).
# Fast path requires BlueStacks window on-screen, unobscured, AND a renderer
# config that lets mss read the pixels. Hardware-accelerated renderers often
# come back as solid black via mss — if that happens, set this to False or
# change BlueStacks Settings -> Graphics -> Renderer.
USE_FAST_CAPTURE = False


def screencap():
    return screencap_fast() if USE_FAST_CAPTURE else _adb_screencap()

TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
DEBUG_DIR = Path(__file__).parent.parent / "debug_output"


def _template_path(name: str) -> str:
    """Accept 'chest' or 'chest.png' or an absolute path."""
    p = Path(name)
    if p.is_absolute() and p.exists():
        return str(p)
    if not name.endswith(".png"):
        name += ".png"
    return str(TEMPLATES_DIR / name)


def wait_for(
    template: str,
    *,
    timeout: float = 10.0,
    poll_interval: float = 0.1,
    threshold: float = 0.85,
) -> Match | None:
    """Poll the screen until `template` appears (or timeout). Returns the Match or None."""
    path = _template_path(template)
    deadline = time.monotonic() + timeout
    attempts = 0
    while time.monotonic() < deadline:
        attempts += 1
        frame = screencap()
        match = find_template(frame, path, threshold=threshold)
        if match is not None:
            print(f"  [{template}] found after {attempts} poll(s) at {match.center} (conf {match.confidence:.2f})")
            return match
        time.sleep(poll_interval)
    print(f"  [{template}] not found within {timeout}s ({attempts} polls)")
    _dump_last_frame(template, frame)
    return None


def tap_when_seen(
    template: str,
    *,
    timeout: float = 10.0,
    poll_interval: float = 0.1,
    threshold: float = 0.85,
    offset: tuple[int, int] = (0, 0),
) -> bool:
    """Wait for `template`, tap its center (plus optional offset). Returns True on success."""
    match = wait_for(template, timeout=timeout, poll_interval=poll_interval, threshold=threshold)
    if match is None:
        return False
    x, y = match.center
    human_tap(x + offset[0], y + offset[1])
    return True


def tap_when_gone(
    disappears: str,
    tap_target: str,
    *,
    timeout: float = 30.0,
    poll_interval: float = 0.1,
    threshold: float = 0.85,
    tap_timeout: float = 5.0,
) -> bool:
    """Wait until `disappears` is no longer on screen, THEN tap `tap_target`.

    Useful when an animation, progress bar, or enemy must vanish before the
    next action is valid. Returns True if both phases succeeded.
    """
    print(f"  watching for [{disappears}] to disappear...")
    if not wait_until_gone(disappears, timeout=timeout, poll_interval=poll_interval, threshold=threshold):
        print(f"  [{disappears}] never disappeared within {timeout}s")
        return False
    print(f"  [{disappears}] gone — tapping [{tap_target}]")
    return tap_when_seen(tap_target, timeout=tap_timeout, threshold=threshold)


def watch(
    *,
    on_appear: dict[str, str] | None = None,
    on_disappear: dict[str, str] | None = None,
    max_triggers: int = 50,
    poll_interval: float = 0.2,
    threshold: float = 0.85,
) -> int:
    """Persistent screen watcher. Fires taps when templates appear/disappear.

    on_appear:    {template_to_watch: template_to_tap_when_it_appears}
    on_disappear: {template_to_watch: template_to_tap_when_it_disappears}

    Each watched template fires once per appear/disappear edge — no repeats
    while the state stays the same. Returns when max_triggers is reached.

    Example:
        watch(
            on_disappear={"enemy_hp_bar": "loot_button"},
            on_appear={"level_up_modal": "close_button"},
        )
    """
    on_appear = on_appear or {}
    on_disappear = on_disappear or {}
    watched = set(on_appear) | set(on_disappear)
    if not watched:
        raise ValueError("watch() needs at least one entry in on_appear or on_disappear")

    state: dict[str, bool] = {}  # template -> currently visible?
    triggers = 0

    print(f"  watching {len(watched)} template(s); max_triggers={max_triggers}")
    while triggers < max_triggers:
        frame = screencap()
        for name in watched:
            path = _template_path(name)
            visible = find_template(frame, path, threshold=threshold) is not None
            was_visible = state.get(name)
            state[name] = visible

            if was_visible is None:
                continue  # first observation — no edge yet

            if visible and not was_visible and name in on_appear:
                print(f"  [{name}] appeared -> tap [{on_appear[name]}]")
                tap_when_seen(on_appear[name], timeout=2.0, threshold=threshold)
                triggers += 1
            elif not visible and was_visible and name in on_disappear:
                print(f"  [{name}] disappeared -> tap [{on_disappear[name]}]")
                tap_when_seen(on_disappear[name], timeout=2.0, threshold=threshold)
                triggers += 1

        time.sleep(poll_interval)

    print(f"  watch() stopped after {triggers} trigger(s)")
    return triggers


def wait_until_gone(
    template: str,
    *,
    timeout: float = 10.0,
    poll_interval: float = 0.1,
    threshold: float = 0.85,
) -> bool:
    """Block until `template` is NO LONGER on screen. Useful after taps that
    trigger loading screens or animations. Returns True if it disappeared."""
    path = _template_path(template)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = screencap()
        if find_template(frame, path, threshold=threshold) is None:
            return True
        time.sleep(poll_interval)
    return False


def _dump_last_frame(label: str, frame: np.ndarray) -> None:
    DEBUG_DIR.mkdir(exist_ok=True)
    safe = "".join(c if c.isalnum() else "_" for c in label)
    path = DEBUG_DIR / f"missed_{safe}.png"
    cv2.imwrite(str(path), frame)
    print(f"  (saved last frame to {path})")


def ensure_connected() -> None:
    """Call once at the top of a flow to make sure ADB is alive."""
    connect()


# ---------- Movement / navigation ----------

def pan(direction: str, distance_frac: float = 0.4, duration_ms: int = 250) -> None:
    """Pan the view/camera by swiping. Direction is the direction the *content*
    moves; i.e. 'right' drags screen left-to-right to reveal what was off the left.

    distance_frac is fraction of screen size (0.0-1.0).
    """
    aw, ah = android_resolution()
    cx, cy = aw // 2, ah // 2
    dx = round(aw * distance_frac / 2)
    dy = round(ah * distance_frac / 2)
    vectors = {
        "right": (cx - dx, cy, cx + dx, cy),   # to reveal more on the left, swipe right
        "left":  (cx + dx, cy, cx - dx, cy),
        "down":  (cx, cy - dy, cx, cy + dy),
        "up":    (cx, cy + dy, cx, cy - dy),
    }
    if direction not in vectors:
        raise ValueError(f"direction must be one of {list(vectors)}")
    x1, y1, x2, y2 = vectors[direction]
    swipe(x1, y1, x2, y2, duration_ms=duration_ms)


def find_by_panning(
    template: str,
    directions: list[str],
    *,
    max_pans: int = 6,
    per_pan_timeout: float = 0.6,
    threshold: float = 0.85,
) -> Match | None:
    """Look for `template`; if not found, pan in each direction and look again.

    `directions` is the cycle to try, e.g. ['right', 'down', 'left', 'up']
    for a search-spiral. Returns the Match or None.
    """
    match = wait_for(template, timeout=per_pan_timeout, threshold=threshold)
    if match is not None:
        return match
    for i in range(max_pans):
        direction = directions[i % len(directions)]
        print(f"  panning {direction} (attempt {i + 1}/{max_pans})")
        pan(direction)
        time.sleep(0.3)  # let the view settle
        match = wait_for(template, timeout=per_pan_timeout, threshold=threshold)
        if match is not None:
            return match
    return None


def joystick_move(direction: str, hold_ms: int = 1500, joystick_center: tuple[int, int] | None = None) -> None:
    """Hold a virtual joystick in `direction` for `hold_ms`. Approximates a
    sustained touch via long swipe — works for most joystick UIs.

    joystick_center defaults to bottom-left quadrant; pass exact coords once
    you know where your game puts the stick.
    """
    aw, ah = android_resolution()
    if joystick_center is None:
        joystick_center = (aw // 5, ah - ah // 5)
    cx, cy = joystick_center
    reach = min(aw, ah) // 12  # how far to push the stick
    vectors = {
        "right": (cx + reach, cy),
        "left":  (cx - reach, cy),
        "down":  (cx, cy + reach),
        "up":    (cx, cy - reach),
    }
    if direction not in vectors:
        raise ValueError(f"direction must be one of {list(vectors)}")
    tx, ty = vectors[direction]
    swipe(cx, cy, tx, ty, duration_ms=hold_ms)


def tap_to_walk(x: int, y: int) -> None:
    """For tap-to-move games: tap a point in the world to walk there."""
    human_tap(x, y)


def tap_until_gone(
    template: str,
    *,
    max_taps: int = 30,
    between_taps: float = 0.25,
    threshold: float = 0.85,
    timeout_per_find: float = 1.5,
    confirm_cleared_timeout: float = 2.0,
    same_spot_radius: int = 25,
) -> int:
    """Tap one instance of `template`, wait for THAT instance to disappear,
    then look for the next. Avoids double-tapping the same item when the game
    hasn't yet processed the previous tap.

    same_spot_radius: a new match within this many pixels of the last tap is
        treated as the same item (still being processed) — we wait instead of
        re-tapping.
    confirm_cleared_timeout: how long to wait for the tapped spot to clear
        before giving up and moving on.

    Returns the number of taps performed.
    """
    path = _template_path(template)
    taps = 0
    last_tap: tuple[int, int] | None = None

    for _ in range(max_taps):
        frame = screencap()
        match = find_template(frame, path, threshold=threshold)

        # If we just tapped and the only match is still in the same spot,
        # the game hasn't processed the tap yet — wait for it to clear.
        if match is not None and last_tap is not None:
            dx = match.center[0] - last_tap[0]
            dy = match.center[1] - last_tap[1]
            if dx * dx + dy * dy <= same_spot_radius * same_spot_radius:
                deadline = time.monotonic() + confirm_cleared_timeout
                while time.monotonic() < deadline:
                    time.sleep(0.1)
                    frame = screencap()
                    m2 = find_template(frame, path, threshold=threshold)
                    if m2 is None:
                        match = None
                        break
                    ddx = m2.center[0] - last_tap[0]
                    ddy = m2.center[1] - last_tap[1]
                    if ddx * ddx + ddy * ddy > same_spot_radius * same_spot_radius:
                        match = m2  # a different instance, fine to tap
                        break

        if match is None:
            # Brief re-look in case the next item is mid-animation in.
            deadline = time.monotonic() + timeout_per_find
            while time.monotonic() < deadline:
                frame = screencap()
                match = find_template(frame, path, threshold=threshold)
                if match is not None:
                    break
                time.sleep(0.1)
            if match is None:
                break

        x, y = match.center
        human_tap(x, y)
        last_tap = (x, y)
        taps += 1
        time.sleep(between_taps)

    print(f"  [{template}] tapped {taps}x until gone")
    return taps


def tap_all_visible(
    template: str,
    *,
    threshold: float = 0.85,
    between_taps: float = 0.1,
    overlap_frac: float = 0.5,
) -> int:
    """Find every instance of `template` in the CURRENT frame, then tap each.
    Use only when positions don't shift between taps (static UI grids).

    Deduplicates clustered matches via non-maximum suppression sized to the
    template — a new candidate is dropped if its center falls within
    `overlap_frac * template_size` of any already-kept match.

    Returns the number of taps performed.
    """
    path = _template_path(template)
    frame = screencap()
    matches = find_all(frame, path, threshold=threshold)
    if not matches:
        # Probe lower thresholds to figure out *why* nothing matched.
        from vision import find_template as _ft
        best = _ft(frame, path, threshold=0.0)
        best_conf = best.confidence if best else 0.0
        print(f"  [{template}] no matches at threshold {threshold}  "
              f"(best single match confidence: {best_conf:.3f})")
        _dump_last_frame(f"tap_all_{template}", frame)
        return 0

    tw, th = matches[0].w, matches[0].h
    sep_x = tw * overlap_frac
    sep_y = th * overlap_frac

    kept: list[Match] = []
    for m in sorted(matches, key=lambda mm: -mm.confidence):
        if all(
            abs(m.center[0] - k.center[0]) > sep_x or abs(m.center[1] - k.center[1]) > sep_y
            for k in kept
        ):
            kept.append(m)

    print(f"  [{template}] tapping {len(kept)} unique instance(s) (from {len(matches)} raw matches)")
    for m in kept:
        human_tap(*m.center)
        time.sleep(between_taps)
    return len(kept)
