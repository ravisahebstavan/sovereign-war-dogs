@echo off
setlocal EnableDelayedExpansion
set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%

echo.
echo  =====================================================
echo   SOVEREIGN - Geopolitical Alpha Pipeline  v1.2
echo  =====================================================
echo.

REM ── 1. Redis ──────────────────────────────────────────────────────────────────
echo [1/7] Starting Redis (5.0 with Streams support)...
if exist "%USERPROFILE%\Downloads\Redis5\redis-server.exe" (
    start "Redis5" /d "%USERPROFILE%\Downloads\Redis5" cmd /k "redis-server.exe --port 6380"
) else if exist "C:\Program Files\Redis\redis-server.exe" (
    echo WARNING: Using Redis 3.0 - Streams may not work. Install Redis 5 for full support.
    start "Redis" /d "C:\Program Files\Redis" cmd /k "redis-server.exe"
) else (
    echo ERROR: Redis not found. Download Redis 5 portable to %USERPROFILE%\Downloads\Redis5\
    pause
    exit /b 1
)
timeout /t 3 /nobreak >nul

REM ── 2. Sovereign-core (Rust) ──────────────────────────────────────────────────
echo [2/7] Starting sovereign-core (Rust ingestion + WebSocket)...
if not exist "%ROOT%\sovereign\target\release\sovereign-core.exe" (
    echo Binary not found. Building now ^(3 min first time^)...
    start "BUILD sovereign-core" /d "%ROOT%\sovereign" cmd /k "cargo build --release && echo. && echo BUILD DONE - close this and re-run start_sovereign.bat"
    echo.
    echo Wait for BUILD DONE in the build window, then re-run this script.
    pause
    exit /b 0
)
start "sovereign-core" /d "%ROOT%\sovereign" cmd /k "target\release\sovereign-core.exe"
timeout /t 2 /nobreak >nul

REM ── 3. Company news poller ────────────────────────────────────────────────────
echo [3/7] Starting company news poller (Finnhub per-ticker, 28 tickers)...
start "news-poller" /d "%ROOT%\signal" cmd /k ".venv\Scripts\python.exe news_poller.py"
timeout /t 1 /nobreak >nul

REM ── 4. RSS poller ─────────────────────────────────────────────────────────────
echo [4/7] Starting RSS poller (Google News + Yahoo Finance, 28 tickers)...
start "rss-poller" /d "%ROOT%\signal" cmd /k ".venv\Scripts\python.exe rss_poller.py"
timeout /t 1 /nobreak >nul

REM ── 5. Contracts poller ───────────────────────────────────────────────────────
echo [5/7] Starting contracts poller (USASpending.gov)...
start "contracts-poller" /d "%ROOT%\contracts" cmd /k ".venv\Scripts\python.exe poller.py"
timeout /t 1 /nobreak >nul

REM ── 6. Signal engine ──────────────────────────────────────────────────────────
echo [6/7] Starting signal engine (FinBERT NLP + Alpaca orders)...
start "signal-engine" /d "%ROOT%\signal" cmd /k ".venv\Scripts\python.exe engine.py"
timeout /t 1 /nobreak >nul

REM ── 7. React dashboard ────────────────────────────────────────────────────────
echo [7/7] Starting React dashboard...
start "sovereign-ui" /d "%ROOT%\ui" cmd /k "npm run dev"

echo.
echo  =====================================================
echo   All 7 services launched!
echo   Dashboard: http://localhost:5173
echo  =====================================================
echo.
echo  Windows opened:
echo    Redis            port 6380  - message bus (Redis Streams)
echo    sovereign-core   port 9001  - Rust ingestion + WS server
echo    news-poller                 - Finnhub company news (28 tickers, 90s cycle)
echo    rss-poller                  - Google News + Yahoo Finance (28 tickers, 60s)
echo    contracts-poller            - USASpending.gov DoD awards
echo    signal-engine               - FinBERT NLP + Alpaca paper trades
echo    sovereign-ui     port 5173  - React dashboard
echo.
echo  Signal engine takes ~30s to load FinBERT on first run.
echo  Two news pollers run in parallel — expect 3-5x more signals vs v1.1.
echo  Open http://localhost:5173 once sovereign-ui shows "VITE ready".
echo.
echo  Signals will start firing within 2-3 minutes.
echo.
pause
