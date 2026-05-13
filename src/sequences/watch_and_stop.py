"""Watcher: keep scanning Android for TRIGGER; when seen, click stop_macro chrome button.

Edit TRIGGER to point at any template you've cropped into templates/.
Drop the chrome stop button template at templates/chrome/stop_macro.png.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import cv2

from chrome import click_chrome
from flow import ensure_connected, screencap
from vision import find_template

PROJECT_ROOT = Path(__file__).parent.parent.parent

# Per-instance scoping. When the GUI launches this script for a specific
# BlueStacks instance it sets BS_INSTANCE_NAME (and BS_ADB_DEVICE,
# BS_WINDOW_TITLE consumed by adb_input/chrome). Defaults keep single-instance
# behavior identical.
INSTANCE_NAME = os.environ.get("BS_INSTANCE_NAME", "default")
LOG_DIR = PROJECT_ROOT / "logs"
LOG_FILE_NAME = f"watch_and_stop_{INSTANCE_NAME}.log"
STOPS_DIR = PROJECT_ROOT / "debug_output" / "stops" / INSTANCE_NAME


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _log(msg: str, log_file: Path) -> None:
    line = f"[{_ts()}] {msg}"
    print(line)
    with log_file.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _log_separator(log_file: Path, label: str) -> None:
    """Write a visually distinct banner so sessions are easy to scan for."""
    bar = "=" * 72
    with log_file.open("a", encoding="utf-8") as f:
        f.write(f"\n{bar}\n=== {label} @ {_ts()}\n{bar}\n")


def _save_stop_frame(frame, trigger: str, reason: str) -> Path:
    STOPS_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{trigger}_{reason}.png"
    path = STOPS_DIR / fname
    cv2.imwrite(str(path), frame)
    return path


# Each entry: (template_name, absent_timeout_seconds) or
#             (template_name, absent_timeout_seconds, threshold)
# If threshold is omitted, DEFAULT_THRESHOLD is used.
TRIGGERS = [
    ("chest", 20.0, 0.8),
    # ("green_hide", 20.0),
    # ("ran_herb", 20.0, 0.9),
]

MODE = "absent"  # "seen"  -> fire when ANY trigger appears
# "absent" -> fire when ANY trigger is missing for its own timeout
DEFAULT_THRESHOLD = 0.8
POLL_INTERVAL = 0.2
COUNTDOWN_INTERVAL = 2.0  # seconds between absence countdown prints


def _fire_stop(
    reason_tag: str, trigger_name: str, frame, log_file: Path, detail: str
) -> None:
    saved = _save_stop_frame(frame, trigger_name, reason_tag)
    _log(
        f"TRIGGER [{trigger_name}] {detail} -> stop_macro. frame={saved.name}", log_file
    )
    click_chrome("stop_macro")
    _log("stop_macro click fired", log_file)
    _log_separator(log_file, "SESSION END (triggered)")


def main() -> int:
    ensure_connected()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / LOG_FILE_NAME
    _log_separator(log_file, f"SESSION START [{INSTANCE_NAME}]")
    adb_device = os.environ.get("BS_ADB_DEVICE", "127.0.0.1:5555")
    window_title = os.environ.get("BS_WINDOW_TITLE", "BlueStacks App Player")
    _log(f"instance={INSTANCE_NAME} adb={adb_device} window={window_title!r}", log_file)

    # Resolve template paths, thresholds, and validate up front.
    triggers: list[dict] = []
    for entry in TRIGGERS:
        if len(entry) == 2:
            name, timeout = entry
            threshold = DEFAULT_THRESHOLD
        elif len(entry) == 3:
            name, timeout, threshold = entry
        else:
            _log(f"ABORT: bad TRIGGERS entry {entry!r}", log_file)
            _log_separator(log_file, "SESSION END (bad config)")
            return 1
        path = PROJECT_ROOT / "templates" / f"{name}.png"
        if not path.exists():
            _log(f"ABORT: missing trigger template: {path}", log_file)
            _log_separator(log_file, "SESSION END (template missing)")
            return 1
        triggers.append(
            {
                "name": name,
                "path": str(path),
                "timeout": timeout,
                "threshold": threshold,
                "last_seen": time.monotonic(),
                "was_visible": None,
                "last_countdown_print": 0.0,
                "best_conf_seen": 0.0,
            }
        )

    if MODE not in ("seen", "absent"):
        _log(f"ABORT: unknown MODE {MODE!r} (use 'seen' or 'absent')", log_file)
        _log_separator(log_file, "SESSION END (bad config)")
        return 1

    summary = ", ".join(
        f"{t['name']}({t['timeout']:.0f}s @ thr={t['threshold']})" for t in triggers
    )
    _log(f"STARTED watching {summary} mode={MODE}", log_file)

    poll_count = 0
    while True:
        frame = screencap()
        poll_count += 1
        now = time.monotonic()

        for tr in triggers:
            best = find_template(frame, tr["path"], threshold=0.0)
            conf = best.confidence if best is not None else 0.0
            visible = conf >= tr["threshold"]
            if conf > tr["best_conf_seen"]:
                tr["best_conf_seen"] = conf

            # Per-trigger diagnostic every ~5s while not matching.
            if not visible and poll_count % max(1, int(5.0 / POLL_INTERVAL)) == 0:
                print(
                    f"  [diag:{tr['name']}] polls={poll_count}, "
                    f"best conf seen={tr['best_conf_seen']:.3f} (threshold={tr['threshold']})"
                )
                if best is not None:
                    out_dir = PROJECT_ROOT / "debug_output" / INSTANCE_NAME
                    out_dir.mkdir(parents=True, exist_ok=True)
                    debug_img = frame.copy()
                    cv2.rectangle(
                        debug_img,
                        (best.x, best.y),
                        (best.x + best.w, best.y + best.h),
                        (0, 0, 255),
                        2,
                    )
                    cv2.putText(
                        debug_img,
                        f"{tr['name']} best conf={conf:.3f}",
                        (best.x, max(20, best.y - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 0, 255),
                        2,
                    )
                    cv2.imwrite(
                        str(out_dir / f"watch_{tr['name']}_best.png"), debug_img
                    )
                    cv2.imwrite(str(out_dir / f"watch_{tr['name']}_frame.png"), frame)

            if MODE == "seen":
                if visible:
                    _fire_stop(
                        "seen",
                        tr["name"],
                        frame,
                        log_file,
                        f"seen (conf={conf:.3f})",
                    )
                    return 0

            else:  # absent
                if visible:
                    if tr["was_visible"] is not True:
                        if tr["was_visible"] is False:
                            gone_for = now - tr["last_seen"]
                            _log(
                                f"[{tr['name']}] seen again (was missing for {gone_for:.1f}s) — timer reset",
                                log_file,
                            )
                        else:
                            _log(f"[{tr['name']}] seen — timer reset", log_file)
                    tr["last_seen"] = now
                else:
                    gone_for = now - tr["last_seen"]
                    remaining = tr["timeout"] - gone_for
                    if tr["was_visible"] is True:
                        _log(
                            f"[{tr['name']}] no longer visible — countdown started ({tr['timeout']:.0f}s)",
                            log_file,
                        )
                        tr["last_countdown_print"] = now
                    elif now - tr["last_countdown_print"] >= COUNTDOWN_INTERVAL:
                        print(
                            f"  [{tr['name']}] still missing — {remaining:.1f}s until stop"
                        )
                        tr["last_countdown_print"] = now

                    if gone_for >= tr["timeout"]:
                        _fire_stop(
                            "absent",
                            tr["name"],
                            frame,
                            log_file,
                            f"missing for {gone_for:.1f}s",
                        )
                        return 0

            tr["was_visible"] = visible

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOG_DIR / LOG_FILE_NAME
        with log_file.open("a", encoding="utf-8") as f:
            f.write(f"[{_ts()}] ABORTED by user (Ctrl+C)\n")
        _log_separator(log_file, f"SESSION END (aborted) [{INSTANCE_NAME}]")
        print("\nAborted.")
        sys.exit(130)
