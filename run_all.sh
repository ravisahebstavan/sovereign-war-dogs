#!/usr/bin/env bash
set -euo pipefail

echo "Starting Redis..."
redis-server --daemonize yes

echo "Starting sovereign-core..."
pushd sovereign > /dev/null
cargo run --release &
popd > /dev/null

echo "Starting signal-news-poller..."
pushd signal > /dev/null
python -m venv .venv
source .venv/bin/activate
pip install --no-cache-dir -r requirements.txt
python news_poller.py &
popd > /dev/null

echo "Starting signal-engine..."
pushd signal > /dev/null
source .venv/bin/activate
python engine.py &
popd > /dev/null

echo "Starting contracts poller..."
pushd contracts > /dev/null
python -m venv .venv
source .venv/bin/activate
pip install --no-cache-dir -r requirements.txt
python poller.py &
popd > /dev/null

echo "Starting UI..."
pushd ui > /dev/null
npm install
npm run dev &
popd > /dev/null

echo "All services launched. Open http://localhost:5173"
