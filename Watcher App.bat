@echo off
REM Launch the Tkinter GUI for watch_and_stop. Auto-elevates because the
REM chrome click requires admin to bypass UIPI on elevated BlueStacks.

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

if not exist ".venv\Scripts\pythonw.exe" goto :no_venv

REM pythonw.exe runs without a console window — pure GUI.
start "" ".venv\Scripts\pythonw.exe" "src\watcher_app.py"
goto :eof

:no_venv
echo Python virtualenv not found at: %CD%\.venv\Scripts\pythonw.exe
pause
exit /b 1
