"""
sovereign/signal/diagnose.py

Run this ONCE to verify every layer of the pipeline is working.
Usage:
    .venv\Scripts\python.exe diagnose.py     (Windows)
    python diagnose.py                        (if venv already active)

It checks each step and tells you exactly where things break.
"""

import sys
import os
import json
import time
import asyncio

os.chdir(os.path.dirname(os.path.abspath(__file__)))

PASS = "  [PASS]"
FAIL = "  [FAIL]"
WARN = "  [WARN]"
INFO = "  [INFO]"

print()
print("=" * 60)
print("  SOVEREIGN — Pipeline Diagnostic")
print("=" * 60)

# ── Step 1: .env / environment variables ─────────────────────────

print("\n[1] Checking .env / environment variables")
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))
    print(f"{PASS} python-dotenv loaded")
except ImportError:
    print(f"{FAIL} python-dotenv not installed — run:  pip install -r requirements.txt")
    sys.exit(1)

finnhub_key = os.getenv("FINNHUB_API_KEY", "")
alpaca_key  = os.getenv("ALPACA_API_KEY",  "")
redis_url   = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")

if not finnhub_key or finnhub_key == "your_finnhub_key_here":
    print(f"{FAIL} FINNHUB_API_KEY not set in .env — get a free key at finnhub.io")
else:
    print(f"{PASS} FINNHUB_API_KEY set ({finnhub_key[:6]}...)")

if not alpaca_key or alpaca_key == "your_alpaca_api_key_here":
    print(f"{WARN} ALPACA_API_KEY not set — orders will be dry-run only (signals still fire)")
else:
    print(f"{PASS} ALPACA_API_KEY set")

print(f"{INFO} REDIS_URL = {redis_url}")

# ── Step 2: Python packages ──────────────────────────────────────

print("\n[2] Checking Python packages")
missing = []
for pkg, import_name in [
    ("redis", "redis"),
    ("transformers", "transformers"),
    ("torch", "torch"),
    ("spacy", "spacy"),
    ("httpx", "httpx"),
    ("alpaca", "alpaca"),
]:
    try:
        __import__(import_name)
        print(f"{PASS} {pkg}")
    except ImportError:
        print(f"{FAIL} {pkg} — run:  pip install -r requirements.txt")
        missing.append(pkg)

if missing:
    print(f"\n  Missing packages: {missing}")
    print("  Fix:  .venv\\Scripts\\pip install -r requirements.txt")
    sys.exit(1)

# ── Step 3: spaCy model ──────────────────────────────────────────

print("\n[3] Checking spaCy model (en_core_web_sm)")
try:
    import spacy
    nlp_test = spacy.load("en_core_web_sm")
    doc = nlp_test("Lockheed Martin wins Pentagon contract")
    orgs = [e.text for e in doc.ents if e.label_ == "ORG"]
    print(f"{PASS} en_core_web_sm loaded — NER found: {orgs}")
except OSError:
    print(f"{FAIL} en_core_web_sm not installed — run:")
    print(f"        .venv\\Scripts\\python.exe -m spacy download en_core_web_sm")
    sys.exit(1)

# ── Step 4: FinBERT ──────────────────────────────────────────────

print("\n[4] Checking FinBERT (ProsusAI/finbert) — may take 30-60s first run")
try:
    import torch
    from transformers import pipeline as hf_pipeline
    device = 0 if torch.cuda.is_available() else -1
    sentiment_pipe = hf_pipeline(
        "text-classification",
        model="ProsusAI/finbert",
        tokenizer="ProsusAI/finbert",
        device=device,
        top_k=None,
        truncation=True,
        max_length=512,
    )
    result = sentiment_pipe("Lockheed Martin wins $2 billion Pentagon contract for F-35")[0]
    scores = {r["label"]: round(r["score"], 3) for r in result}
    scalar = scores.get("positive", 0) - scores.get("negative", 0)
    print(f"{PASS} FinBERT loaded — scores: {scores} → scalar={scalar:+.3f}")
    if abs(scalar) < 0.10:
        print(f"{WARN} Scalar={scalar:+.3f} is below ALPHA_THRESHOLD=0.10 — this headline would NOT trigger a signal")
    else:
        print(f"{PASS} Would trigger a signal (|α|={abs(scalar):.3f} > 0.10)")
except Exception as e:
    print(f"{FAIL} FinBERT failed: {e}")
    print("       First run downloads ~400MB — check internet connection")
    sys.exit(1)

# ── Step 5: Redis connection ─────────────────────────────────────

print("\n[5] Checking Redis")

async def check_redis():
    try:
        import redis.asyncio as aioredis
        r = await aioredis.from_url(redis_url, decode_responses=True)
        await r.ping()
        news_len  = await r.xlen("sovereign:news")
        event_len = await r.xlen("sovereign:events")
        print(f"{PASS} Redis connected — sovereign:news={news_len} msgs, sovereign:events={event_len} msgs")
        await r.aclose()
        return r, news_len, event_len
    except Exception as e:
        print(f"{FAIL} Redis not reachable: {e}")
        print("       Start Redis:  redis-server   (or run start_sovereign.bat step 1)")
        return None, 0, 0

redis_conn, news_len, event_len = asyncio.run(check_redis())

if redis_conn is None:
    print("\n  Cannot continue without Redis. Fix Redis first.")
    sys.exit(1)

# ── Step 6: Finnhub API call ─────────────────────────────────────

print("\n[6] Checking Finnhub API (company news for LMT)")
if finnhub_key and finnhub_key != "your_finnhub_key_here":
    try:
        import httpx
        from datetime import datetime, timedelta, timezone
        today     = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        from_date = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%d")
        r = httpx.get(
            "https://finnhub.io/api/v1/company-news",
            params={"symbol": "LMT", "from": from_date, "to": today, "token": finnhub_key},
            timeout=10,
        )
        if r.status_code == 200:
            articles = r.json()
            if isinstance(articles, list) and articles:
                print(f"{PASS} Finnhub returned {len(articles)} articles for LMT")
                print(f"{INFO} Latest: \"{articles[0].get('headline', '')[:80]}\"")
            elif isinstance(articles, list):
                print(f"{WARN} Finnhub returned 0 articles for LMT (market may be quiet)")
            else:
                print(f"{FAIL} Unexpected Finnhub response: {str(articles)[:100]}")
        elif r.status_code == 401:
            print(f"{FAIL} Finnhub API key is INVALID — get a new one at finnhub.io")
        elif r.status_code == 429:
            print(f"{WARN} Finnhub rate limited (60 req/min) — wait 60s and retry")
        else:
            print(f"{FAIL} Finnhub returned HTTP {r.status_code}: {r.text[:100]}")
    except Exception as e:
        print(f"{FAIL} Finnhub request failed: {e}")
else:
    print(f"{FAIL} Skipped — FINNHUB_API_KEY not set")

# ── Step 7: Inject a test signal directly into Redis ─────────────

print("\n[7] Injecting a test signal into sovereign:events")
print("    (This bypasses NLP entirely — tests if Rust relay + UI works)")

async def inject_test_signal():
    import redis.asyncio as aioredis
    import uuid
    r = await aioredis.from_url(redis_url, decode_responses=True)

    now_ns = time.time_ns()
    test_event = {
        "id":          str(uuid.uuid4()),
        "ingested_ns": now_ns,
        "routed_ns":   now_ns,
        "payload": {
            "kind":            "signal",
            "ticker":          "LMT",
            "direction":       "LONG",
            "confidence":      0.72,
            "sentiment":       0.72,
            "contract_boost":  2.1,
            "alpha_score":     0.72,
            "rationale":       "DIAGNOSTIC TEST: 72% positive sentiment · 2.1× contract boost (FinBERT=+0.72 × boost=2.10 = α=+0.72)",
            "trigger_headline":"[DIAGNOSTIC] Lockheed Martin awarded $2.1B Pentagon F-35 contract",
            "order_id":        None,
        }
    }

    msg_id = await r.xadd(
        "sovereign:events",
        {"data": json.dumps(test_event)},
        maxlen=5000,
        approximate=True,
    )
    print(f"{PASS} Test signal written to sovereign:events (id={msg_id})")
    print(f"{INFO} If dashboard doesn't show it within 3s → Rust relay broken")

    # Also inject a test news article into sovereign:news
    news_event = {
        "id":          str(uuid.uuid4()),
        "ingested_ns": now_ns,
        "routed_ns":   now_ns,
        "payload": {
            "kind":           "news",
            "article_id":     "diag-001",
            "headline":       "[DIAGNOSTIC] Lockheed Martin awarded $2.1B Pentagon F-35 contract",
            "summary":        "The Defense Department awarded Lockheed Martin a major contract for F-35 production upgrades. This represents a significant win for the company's defense division.",
            "tickers":        ["LMT"],
            "source":         "diagnostic",
            "url":            "https://test.com",
            "published_unix": int(time.time()),
        }
    }
    msg_id2 = await r.xadd(
        "sovereign:news",
        {"data": json.dumps(news_event)},
        maxlen=10000,
        approximate=True,
    )
    print(f"{PASS} Test news article written to sovereign:news (id={msg_id2})")
    print(f"{INFO} If engine.py is running, it will score this and produce a 2nd signal")

    await r.aclose()

asyncio.run(inject_test_signal())

# ── Summary ──────────────────────────────────────────────────────

print()
print("=" * 60)
print("  DIAGNOSTIC COMPLETE")
print("=" * 60)
print()
print("  Next steps:")
print("  1. Check your dashboard NOW — a test signal was just injected.")
print("     If you see a [DIAGNOSTIC] LMT LONG card → Rust relay + UI ✓")
print("     If you see NOTHING → sovereign-core (Rust) is not running")
print()
print("  2. Watch the signal-engine terminal window for lines like:")
print('     SIGNAL LONG   LMT    α=+0.720 conf=0.72')
print("     If you see them → engine.py ✓")
print("     If the window shows errors → engine.py crashed")
print()
print("  3. Watch the news-poller terminal for lines like:")
print('     NEWS  LMT    — Lockheed Martin ...')
print("     If no NEWS lines after 90s → Finnhub API key issue")
print()
