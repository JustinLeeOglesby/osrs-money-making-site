@echo off
REM Double-click this file to start the watch_and_stop bot.
REM Auto-elevates to admin (BlueStacks runs elevated; clicks need matching
REM integrity level to get past Windows UIPI).

REM ---- self-elevate to admin ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo Working dir: %CD%

if not exist ".venv\Scripts\python.exe" goto :no_venv

echo Starting watch_and_stop ...
echo (Press Ctrl+C in this window to abort the bot.)
echo.
".venv\Scripts\python.exe" "src\sequences\watch_and_stop.py"
set EXITCODE=%ERRORLEVEL%

echo.
echo ----------------------------------------------------------
echo Bot exited with code: %EXITCODE%
echo.
echo Press any key in THIS window to close it.
echo If you press keys in BlueStacks they go to the game, not here.
pause
goto :eof

:no_venv
echo.
echo Python virtualenv not found at: %CD%\.venv\Scripts\python.exe
echo.
echo If the working dir above is wrong, fix the shortcut's "Start in"
echo property to point at the project folder.
echo.
echo If it is correct, your virtualenv is missing. Recreate it:
echo   python -m venv .venv
echo   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
pause
exit /b 1
