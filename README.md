# SOVEREIGN — Geopolitical Alpha Pipeline

> Sub-millisecond news ingestion → NLP signal generation → paper trade execution.
> Built on 100% free, open-source tooling. Zero monetary cost to run.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SOVEREIGN PIPELINE                        │
│                                                                  │
│  [Finnhub WS]──┐                                                 │
│  News + Trades │                                                 │
│                ▼                                                 │
│         ┌─────────────┐    nanosecond     ┌──────────────────┐  │
│         │  RUST CORE  │───────stamp──────▶│   Redis Streams  │  │
│         │  sovereign- │    broadcast      │   (OSS, local)   │  │
│         │    core     │◀──────────────────│                  │  │
│         └─────────────┘                   └────────┬─────────┘  │
│                │                                   │            │
│                │ WebSocket                         │ XREAD      │
│                ▼                                   ▼            │
│         ┌─────────────┐              ┌─────────────────────┐   │
│         │  React UI   │              │   Python Signal     │   │
│         │  Dashboard  │              │      Engine         │   │
│         │  sovereign- │              │   spaCy NER +       │   │
│         │     ui      │              │   FinBERT sentiment │   │
│         └─────────────┘              └──────────┬──────────┘   │
│                                                 │               │
│                              ┌──────────────────┘               │
│                              │  Signal: BUY/SELL + confidence   │
│                              ▼                                   │
│                    ┌──────────────────┐                          │
│                    │  SAM.gov Poller  │                          │
│                    │  (contract data) │                          │
│                    │  sovereign-      │                          │
│                    │  contracts       │                          │
│                    └────────┬─────────┘                          │
│                             │ contract boost score               │
│                             ▼                                    │
│                    ┌──────────────────┐                          │
│                    │  Alpaca Paper    │                          │
│                    │  Trade Executor  │                          │
│                    │  (free account)  │                          │
│                    └──────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

## Latency Budget (target)

| Hop                              | Target    |
|----------------------------------|-----------|
| Finnhub WS → Rust parse          | < 500 µs  |
| Rust → Redis XADD                | < 200 µs  |
| Redis → Python consumer          | < 1 ms    |
| NLP (spaCy NER + sentiment)      | < 150 ms  |
| Signal → Alpaca order submit     | < 50 ms   |
| **Total: news → order**          | **< 250 ms** |

NLP is the bottleneck by design — it runs on CPU. On GPU it drops to ~15ms.

---

## Free Tier Stack

| Component        | Provider          | Cost  | Notes                            |
|-----------------|-------------------|-------|----------------------------------|
| News WebSocket   | Finnhub           | FREE  | 60 req/min, email signup only    |
| Trade data       | Finnhub           | FREE  | Real-time trades via WS          |
| Gov contracts    | SAM.gov API       | FREE  | No API key required              |
| Paper trading    | Alpaca            | FREE  | Email signup, no KYC, no card   |
| Message broker   | Redis OSS         | FREE  | Self-hosted, runs locally        |
| NLP models       | HuggingFace OSS   | FREE  | FinBERT, spaCy en_core_web_sm    |
| Runtime          | Rust + Python     | FREE  | MIT licensed                     |
| Dashboard        | React + Vite      | FREE  | OSS                              |

---

## Quick Start

### Prerequisites
- Rust (stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Python 3.11+
- Redis — `apt install redis-server` or `brew install redis`
- Node.js 18+

### 1. Set environment variables

```bash
cp .env.example .env
# Fill in:
# FINNHUB_API_KEY=your_key        ← free signup: finnhub.io
# ALPACA_API_KEY=your_key         ← free signup: alpaca.markets (paper only)
# ALPACA_SECRET_KEY=your_secret
```

### 2. Start Redis
```bash
redis-server
```

### 3. Start sovereign-core (Rust)
```bash
cd core
cargo build --release
./target/release/sovereign-core
```

### 4. Start sovereign-contracts (Python)
```bash
cd contracts
pip install -r requirements.txt
python poller.py
```

### 5. Start sovereign-signal (Python)
```bash
cd signal
pip install -r requirements.txt
python -m spacy download en_core_web_sm
python engine.py
```

### 6. Start the dashboard
```bash
cd ui
npm install
npm run dev
# Open http://localhost:5173
```

---

## Signal Logic

```
alpha_score = sentiment_score × contract_recency_boost × momentum_factor

where:
  sentiment_score    ∈ [-1, 1]   ← FinBERT on news headline+summary
  contract_boost     ∈ [1, 3]    ← 3x if contract awarded < 7 days ago
  momentum_factor    ∈ [0.5, 1.5] ← 5-day price momentum from Finnhub

Execute BUY  if alpha_score > +0.45
Execute SELL if alpha_score < -0.45
Hold         otherwise
```

## Ticker Resolution

News → ticker mapping uses a two-layer approach:
1. Finnhub news already tags `ticker` symbols in the payload
2. SAM.gov awardee names run through a curated `awardee_to_ticker.json` mapping
   (covers top 300 defense/aerospace contractors: LMT, RTX, NOC, GD, BA, etc.)

---

## Project Structure

```
sovereign/
├── core/                 # Rust — event ingestion + routing
│   ├── src/
│   │   ├── main.rs
│   │   ├── types.rs      # shared Event types
│   │   ├── finnhub.rs    # WebSocket client
│   │   ├── redis_bus.rs  # Redis Streams publisher
│   │   └── ws_server.rs  # WebSocket server → dashboard
│   └── Cargo.toml
│
├── signal/               # Python — NLP + order execution
│   ├── engine.py         # main signal loop
│   ├── nlp.py            # FinBERT + spaCy pipeline
│   ├── alpaca_exec.py    # Alpaca paper order submission
│   ├── ticker_map.py     # entity → ticker resolution
│   └── requirements.txt
│
├── contracts/            # Python — SAM.gov contract poller
│   ├── poller.py         # polls SAM.gov every 60s
│   ├── resolver.py       # awardee name → ticker
│   ├── awardee_to_ticker.json
│   └── requirements.txt
│
├── ui/                   # React — live dashboard
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── SignalFeed.jsx
│   │   │   ├── LatencyMonitor.jsx
│   │   │   ├── PnLChart.jsx
│   │   │   ├── ContractFeed.jsx
│   │   │   └── OrderBook.jsx
│   │   └── hooks/
│   │       └── useSovereignWS.js
│   └── package.json
│
├── infra/
│   ├── redis.conf        # tuned for low latency
│   └── docker-compose.yml
│
├── .env.example
└── README.md
```
