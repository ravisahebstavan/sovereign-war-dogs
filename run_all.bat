@echo off
REM One-line Windows launch for full zero-fee sovereign stack
setlocal enabledelayedexpansion

echo Starting Redis...
start "redis" cmd /k "redis-server"

echo Starting sovereign-core...
start "sovereign-core" cmd /k "cd /d %~dp0\sovereign && cargo run --release"

echo Starting signal-news-poller...
start "signal-news-poller" cmd /k "cd /d %~dp0\signal && python -m venv .venv && .venv\Scripts\activate && pip install --no-cache-dir -r requirements.txt && python news_poller.py"

echo Starting signal-engine...
start "signal-engine" cmd /k "cd /d %~dp0\signal && .venv\Scripts\activate && python engine.py"

echo Starting contracts poller...
start "contracts-poller" cmd /k "cd /d %~dp0\contracts && python -m venv .venv && .venv\Scripts\activate && pip install --no-cache-dir -r requirements.txt && python poller.py"

echo Starting UI...
start "ui" cmd /k "cd /d %~dp0\ui && npm install && npm run dev"

echo All services launched. Open http://localhost:5173 and monitor each window.
endlocal
