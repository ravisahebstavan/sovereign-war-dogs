@echo off
setlocal
set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%

echo.
echo  ============================================
echo   SOVEREIGN — Native App Window
echo  ============================================
echo.
echo  Make sure start_sovereign.bat is already running
echo  (Redis + sovereign-core + Python engines + Vite must be up).
echo.
echo  Opening SOVEREIGN as a native desktop window...
echo.

cd /d "%ROOT%\ui"

REM Install Tauri CLI if not already present
if not exist "node_modules\@tauri-apps\cli" (
    echo [SETUP] Installing Tauri dependencies ^(first time only, ~2 min^)...
    call npm install
)

REM Launch the Tauri dev window — connects to the already-running Vite on :5173
call npm run tauri -- dev

pause
