# sovereign-war-dogs 🐺

> **Geopolitical alpha engine** — monitors U.S. defense contracts & news to generate real-time trading signals.
> Built entirely on free, open-source tooling. Zero cost to run.

[![GitHub](https://img.shields.io/badge/GitHub-ravisahebstavan%2Fsovereign--war--dogs-181717?style=flat&logo=github)](https://github.com/ravisahebstavan/sovereign-war-dogs)
![Pipeline](https://img.shields.io/badge/pipeline-Rust%20%2B%20Python-orange)
![NLP](https://img.shields.io/badge/NLP-FinBERT%20%2B%20spaCy-blue)
![Trading](https://img.shields.io/badge/trading-Alpaca%20paper-green)
![Cost](https://img.shields.io/badge/cost-%240%2Fmonth-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## What It Does

SOVEREIGN watches the U.S. defence and aerospace sector in real time. It ingests live news headlines for 15 defence companies, scores them with a financial-grade AI model (FinBERT), amplifies signals when a company has recently won a government contract award, and automatically places paper trades — all in under 250ms from headline to order.

```
Finnhub (live news + prices)        USASpending.gov (DoD contracts)
          │                                     │
          ▼                                     ▼
  sovereign-core (Rust)              contracts/poller.py
  ┌─────────────────────┐            (60s poll · no API key)
  │ tokio async runtime │                       │
  │ Finnhub news poll   │                       │
  │ Redis Streams pub   │◄──────────────────────┘
  │ WebSocket :9001     │
  └────────┬────────────┘
           │  sovereign:news + sovereign:contracts
           ▼
   signal/engine.py
   ┌──────────────────────────────┐
   │ spaCy NER   — who is it about│
   │ FinBERT     — positive/negative│
   │ Contract    — up to 3× boost │
   │ Alpha check — |α| > 0.25     │
   └──────────┬───────────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
Alpaca paper        sovereign:events
BUY / SELL SHORT    (Redis Stream)
$1,000 / trade           │
                         ▼
                 React Dashboard :5173
                 BUY · SELL SHORT · HOLD
                 Live prices · Contracts · Latency
```

---

## Signal Logic

```
alpha = FinBERT_sentiment × contract_boost

  FinBERT_sentiment  ∈ [-1.0, +1.0]  scored on news headline + summary
  contract_boost     ∈ [ 1.0,  3.0]  scales with DoD award size, decays over 7 days

  boost = min(3.0,  1.0 + award_USD / 1,000,000,000)
  → $2B contract = 3.0×  |  $500M contract = 1.5×  |  no contract = 1.0×

  alpha > +0.10  →  BUY        (long position, expecting price rise)
  alpha < -0.10  →  SELL SHORT (short position, expecting price fall)
  otherwise      →  HOLD       (no trade)

  Threshold is configurable via ALPHA_THRESHOLD env var (default: 0.10)
```

---

## Tech Stack — 100% Free

| Layer | Technology | Cost |
|-------|-----------|------|
| Ingestion runtime | Rust — tokio, axum, reqwest | FREE |
| Live news + quotes | Finnhub REST API | FREE (60 req/min) |
| DoD contract awards | USASpending.gov API | FREE (no key needed) |
| Message bus | Redis Streams (self-hosted) | FREE |
| NLP — sentiment | ProsusAI/FinBERT (HuggingFace) | FREE |
| NLP — entity extraction | spaCy en_core_web_sm | FREE |
| Signal runtime | Python 3.11 — asyncio | FREE |
| Paper trade execution | Alpaca Markets API | FREE (email signup) |
| Dashboard | React 18 + Vite | FREE |

---

## Latency Budget

| Hop | Target |
|-----|--------|
| Finnhub → Rust parse | < 500µs |
| Rust → Redis XADD | < 200µs |
| Redis → Python XREAD | < 1ms |
| FinBERT CPU inference | ~130ms |
| Alpaca order submit | ~40ms |
| **Total: headline → order** | **< 250ms** |

FinBERT is the bottleneck by design — ~15ms on GPU, ~130ms on CPU.

---

## Watchlist

15 defence and aerospace tickers with company-specific news monitoring:

| Ticker | Company |
|--------|---------|
| LMT | Lockheed Martin |
| RTX | Raytheon Technologies |
| NOC | Northrop Grumman |
| GD | General Dynamics |
| BA | Boeing |
| HII | Huntington Ingalls Industries |
| LHX | L3Harris Technologies |
| PLTR | Palantir Technologies |
| KTOS | Kratos Defense |
| BAH | Booz Allen Hamilton |
| LDOS | Leidos |
| SAIC | Science Applications International |
| AVAV | AeroVironment |
| CACI | CACI International |
| MANT | ManTech International |

---

## Project Structure

```
sovereign/                  Rust — ingestion + WebSocket server
  src/
    main.rs                 entry point, pipeline orchestration
    finnhub.rs              Finnhub news + quote REST poller
    redis_bus.rs            Redis Streams publisher + Python event relay
    types.rs                shared Event/Payload types (serde)
    ws_server.rs            axum WebSocket server → dashboard

signal/                     Python — NLP engine + trade executor
  engine.py                 main loop: Redis consumer → FinBERT → Alpaca
  nlp.py                    FinBERT sentiment + spaCy NER pipeline
  alpaca_exec.py            Alpaca paper trading API wrapper
  ticker_map.py             company name → ticker (300+ contractors)
  news_poller.py            Finnhub company-specific news (15 tickers)

contracts/                  Python — government contract poller
  poller.py                 USASpending.gov REST poller (60s cycle)
  resolver.py               awardee name → ticker resolver

ui/                         React — live trading dashboard
  src/App.jsx               dashboard (WebSocket hook + all panels)

infra/
  docker-compose.yml        optional Redis via Docker

start_sovereign.bat         one-click Windows launcher
.env.example                API key template
```

---

## Quick Start

### Prerequisites

| Tool | Windows | macOS | Linux |
|------|---------|-------|-------|
| Rust | [rustup.rs](https://rustup.rs) | `brew install rust` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Python 3.11+ | [python.org](https://python.org) | `brew install python` | `apt install python3.11` |
| Node.js 18+ | [nodejs.org](https://nodejs.org) | `brew install node` | `apt install nodejs` |
| Redis | `winget install Redis.Redis` | `brew install redis` | `apt install redis-server` |

### 1. Clone and configure

```bash
git clone https://github.com/ravisahebstavan/sovereign-war-dogs.git
cd sovereign-war-dogs
cp .env.example .env
```

Open `.env` and fill in your free API keys:

```env
FINNHUB_API_KEY=your_key       # free at finnhub.io (email only)
ALPACA_API_KEY=your_key        # free at alpaca.markets (paper trading)
ALPACA_SECRET_KEY=your_secret
REDIS_URL=redis://127.0.0.1:6379
```

### 2. Set up Python environments

```bash
# Signal engine
cd signal
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Windows
# source .venv/bin/pip install -r requirements.txt  # macOS/Linux
.venv/Scripts/python -m spacy download en_core_web_sm

# Contracts poller
cd ../contracts
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

### 3. Install dashboard dependencies

```bash
cd ui && npm install
```

### 4. Launch

**Windows:** double-click `start_sovereign.bat` — opens all 6 services automatically.

**macOS / Linux:** open 6 terminals:

```bash
# 1 — Redis
redis-server

# 2 — Rust core (first build ~3 min)
cd sovereign && cargo build --release && ./target/release/sovereign-core

# 3 — Company news poller
cd signal && .venv/bin/python news_poller.py

# 4 — Contracts poller
cd contracts && .venv/bin/python poller.py

# 5 — Signal engine (FinBERT loads ~30s on first start)
cd signal && .venv/bin/python engine.py

# 6 — Dashboard
cd ui && npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)**

Signals begin firing within 2–3 minutes once FinBERT loads and the news poller completes its first cycle.

---

## Dashboard Panels

| Panel | What It Shows |
|-------|--------------|
| **TRADE SIGNALS** | BUY / SELL SHORT / HOLD with confidence bar, plain-English rationale, triggering headline, paper order status |
| **WATCHLIST** | Live prices for all tickers, green flash on each update |
| **GOV CONTRACTS** | Latest DoD awards with calculated signal boost indicator |
| **PIPELINE LATENCY** | P50 / P95 / P99 / MAX updated every 5 seconds |
| **GLOSSARY** | Hover any term for plain-English definition |

---

## Signal Terminology

| Term | Meaning |
|------|---------|
| **BUY** | Open a long position — model expects price to rise |
| **SELL SHORT** | Borrow and sell — model expects price to fall |
| **HOLD** | Alpha below threshold — no trade placed |
| **Alpha (α)** | `sentiment × contract_boost` — the raw signal score |
| **Confidence** | `min(|α|, 1.0)` as a percentage |
| **Contract Boost** | 1–3× multiplier when company has a recent DoD award |
| **PAPER** | Simulated Alpaca trade — no real money involved |

---

## Architecture Notes

**Why Rust for ingestion?**
Tokio's async runtime delivers sub-millisecond Redis publish latency with no GC pauses. Accurate nanosecond timestamps require deterministic execution — Rust provides that guarantee.

**Why Python for NLP?**
FinBERT and spaCy have first-class Python support. Asyncio keeps the signal engine non-blocking while FinBERT runs inference (~130ms/call on CPU) without stalling the event loop.

**Why Redis Streams?**
`XADD`/`XREAD` gives persistent, ordered, multi-consumer message queues with nanosecond precision — exactly what a latency-sensitive pipeline with multiple consumers needs.

**Why USASpending.gov over SAM.gov?**
USASpending.gov aggregates from SAM.gov and FPDS into a single open API — no registration, no API key, no login.gov 2FA. Simpler, more reliable for automated polling.

---

## Disclaimer

SOVEREIGN executes trades exclusively on an **Alpaca paper trading account** — no real money is ever used. This project is for research and educational purposes only. Nothing in this codebase constitutes financial advice.

---

## License

MIT — use it, fork it, build on it.

---

*"Cry havoc, and let slip the dogs of war."* — Shakespeare, Julius Caesar
