"""Tkinter GUI for watch_and_stop, with one tab per BlueStacks instance.

Each tab spawns a separate watch_and_stop.py subprocess scoped to its instance
(via env vars: BS_INSTANCE_NAME, BS_ADB_DEVICE, BS_WINDOW_TITLE). Independent
Start/Stop, independent live log, independent log file on disk.
"""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import scrolledtext, ttk

PROJECT_ROOT = Path(__file__).parent.parent
PYTHON_EXE = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"
WATCHER_SCRIPT = PROJECT_ROOT / "src" / "sequences" / "watch_and_stop.py"

# Add or remove instances here. `name` becomes the log-file suffix and tab label.
INSTANCES = [
    {
        "name": "player_0",
        "adb_device": "127.0.0.1:5555",
        "window_title": "BlueStacks App Player",
    },
    {
        "name": "player_1",
        "adb_device": "127.0.0.1:5565",
        "window_title": "BlueStacks App Player 1",
    },
]


class InstancePanel:
    """One tab's worth of UI + subprocess management for a single instance."""

    def __init__(self, parent: tk.Widget, config: dict) -> None:
        self.config = config
        self.process: subprocess.Popen | None = None
        self.output_queue: queue.Queue[str] = queue.Queue()

        self.frame = tk.Frame(parent)

        top = tk.Frame(self.frame)
        top.pack(fill="x", padx=8, pady=8)

        info = (f"instance={config['name']}  "
                f"adb={config['adb_device']}  "
                f"window={config['window_title']!r}")
        tk.Label(top, text=info, font=("Segoe UI", 9), fg="gray30").pack(side="left")

        controls = tk.Frame(self.frame)
        controls.pack(fill="x", padx=8)

        tk.Label(controls, text="Status:", font=("Segoe UI", 10)).pack(side="left")
        self.status_var = tk.StringVar(value="Stopped")
        self.status_label = tk.Label(controls, textvariable=self.status_var,
                                     font=("Segoe UI", 10, "bold"), fg="gray")
        self.status_label.pack(side="left", padx=(4, 16))

        self.start_btn = tk.Button(controls, text="Start", width=10, command=self.start)
        self.start_btn.pack(side="left", padx=2)
        self.stop_btn = tk.Button(controls, text="Stop", width=10, command=self.stop, state="disabled")
        self.stop_btn.pack(side="left", padx=2)
        tk.Button(controls, text="Clear log", width=10, command=self.clear_log).pack(side="left", padx=2)

        self.text = scrolledtext.ScrolledText(self.frame, wrap="word", state="disabled",
                                              font=("Consolas", 9))
        self.text.pack(fill="both", expand=True, padx=8, pady=8)

    # ---- subprocess control ----

    def start(self) -> None:
        if self.process is not None:
            return
        if not PYTHON_EXE.exists():
            self._append(f"ERROR: missing venv at {PYTHON_EXE}\n")
            return
        if not WATCHER_SCRIPT.exists():
            self._append(f"ERROR: missing script at {WATCHER_SCRIPT}\n")
            return

        env = os.environ.copy()
        env["BS_INSTANCE_NAME"] = self.config["name"]
        env["BS_ADB_DEVICE"] = self.config["adb_device"]
        env["BS_WINDOW_TITLE"] = self.config["window_title"]
        env["PYTHONUNBUFFERED"] = "1"

        self._set_status("Running", "green")
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self._append(f"--- starting watcher for {self.config['name']} ---\n")

        self.process = subprocess.Popen(
            [str(PYTHON_EXE), "-u", str(WATCHER_SCRIPT)],
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        threading.Thread(target=self._read_output, daemon=True).start()

    def stop(self) -> None:
        if self.process is None:
            return
        self._append("--- stopping (terminate sent) ---\n")
        try:
            self.process.terminate()
        except Exception as e:
            self._append(f"ERROR terminating: {e}\n")

    def kill(self) -> None:
        """Forcefully kill (used on window close)."""
        if self.process is not None:
            try:
                self.process.kill()
            except Exception:
                pass

    def _read_output(self) -> None:
        assert self.process is not None
        for line in self.process.stdout:  # type: ignore[union-attr]
            self.output_queue.put(line)
        self.process.wait()
        self.output_queue.put(f"--- process exited (code {self.process.returncode}) ---\n")
        self.output_queue.put("__DONE__")

    def drain(self) -> None:
        """Called periodically from main thread to pump output."""
        try:
            while True:
                item = self.output_queue.get_nowait()
                if item == "__DONE__":
                    self.process = None
                    self.start_btn.config(state="normal")
                    self.stop_btn.config(state="disabled")
                    self._set_status("Stopped", "gray")
                else:
                    self._append(item)
        except queue.Empty:
            pass

    # ---- UI helpers ----

    def _set_status(self, text: str, color: str) -> None:
        self.status_var.set(text)
        self.status_label.config(fg=color)

    def _append(self, line: str) -> None:
        self.text.config(state="normal")
        self.text.insert("end", line)
        self.text.see("end")
        self.text.config(state="disabled")

    def clear_log(self) -> None:
        self.text.config(state="normal")
        self.text.delete("1.0", "end")
        self.text.config(state="disabled")


class WatcherApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        root.title("Watch and Stop — multi-instance")
        root.geometry("820x520")

        notebook = ttk.Notebook(root)
        notebook.pack(fill="both", expand=True)

        self.panels: list[InstancePanel] = []
        for cfg in INSTANCES:
            panel = InstancePanel(notebook, cfg)
            notebook.add(panel.frame, text=cfg["name"])
            self.panels.append(panel)

        self.root.after(100, self._drain_all)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _drain_all(self) -> None:
        for p in self.panels:
            p.drain()
        self.root.after(100, self._drain_all)

    def _on_close(self) -> None:
        for p in self.panels:
            p.kill()
        self.root.destroy()


def main() -> int:
    root = tk.Tk()
    WatcherApp(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
