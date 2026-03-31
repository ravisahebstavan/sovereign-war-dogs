"""
sovereign-signal/news_poller.py

Polls Finnhub's /company-news endpoint for every watchlist ticker and
publishes NewsItem events to the sovereign:news Redis stream.

WHY THIS EXISTS:
  The Rust core polls Finnhub *general* news which rarely has defence
  ticker tags — so the signal engine has nothing to score.
  This poller targets each ticker directly, guaranteeing relevant,
  scored articles flow continuously into the pipeline.

Rate limit: Finnhub free = 60 req/min.
  Rust quotes use ~28/min (28 tickers × 1s spacing).
  This poller uses ~14/min (28 tickers × 2s spacing).
  General news: 2/min. Total: ~44/min — safely under the limit.
"""

import asyncio
import json
import logging
import os
import random
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import redis.asyncio as aioredis
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("sovereign.news_poller")
logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}'
)

REDIS_URL   = os.getenv("REDIS_URL", "redis://localhost:6379")
FINNHUB_KEY = os.getenv("FINNHUB_API_KEY", "")
STREAM_NEWS = "sovereign:news"
POLL_CYCLE  = 90    # seconds between full cycles
DAYS_BACK   = 7    # how many days of news to look back on each cycle
ARTICLES_PER_TICKER = 8  # fetch more per ticker so fresh articles always exist

# 28-ticker watchlist — defence primes, cyber, AI hardware, cloud
WATCHLIST = [
    # Core defence primes
    "LMT",  "RTX",  "NOC",  "GD",   "BA",
    "HII",  "LHX",  "LDOS", "SAIC", "BAH",
    # Intelligence / autonomy / ISR
    "PLTR", "KTOS", "AVAV", "CACI", "MANT",
    # Big tech (cloud / AI compute contracted to DoD)
    "MSFT", "AMZN", "GOOGL", "ORCL",
    # Emerging defence tech
    "AXON", "TXT",  "HWM",  "BWXT",
    # Cyber / endpoint
    "CRWD", "PANW",
    # AI chips & hardware
    "NVDA", "INTC", "AMD",
]

FINNHUB_COMPANY_NEWS = "https://finnhub.io/api/v1/company-news"


# ─── Redis connection with retry ─────────────────────────────────────────────

async def connect_redis(url: str) -> aioredis.Redis:
    backoff = 1
    while True:
        try:
            r = await aioredis.from_url(url, decode_responses=True)
            await r.ping()
            log.info("Redis connected")
            return r
        except Exception as e:
            log.warning(f"Redis connect failed: {e} — retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


# ─── Event builder — matches the format engine.py expects ───────────────────

def build_news_event(article: dict, ticker: str) -> dict:
    now_ns = time.time_ns()
    return {
        "id":          str(uuid.uuid4()),
        "ingested_ns": now_ns,
        "routed_ns":   now_ns,
        "payload": {
            "kind":           "news",
            "article_id":     str(article.get("id", uuid.uuid4())),
            "headline":       article.get("headline", ""),
            "summary":        article.get("summary",  ""),
            "tickers":        [ticker],   # guaranteed — company-specific endpoint
            "source":         article.get("source", "finnhub"),
            "url":            article.get("url", ""),
            "published_unix": article.get("datetime", 0),
        }
    }


# ─── Fetch one ticker's news ─────────────────────────────────────────────────

async def fetch_ticker_news(
    client: httpx.AsyncClient,
    ticker: str,
    days_back: int = DAYS_BACK,
) -> tuple[list[dict], bool]:
    """Returns (articles, rate_limited)."""
    today     = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    from_date = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")

    try:
        r = await client.get(
            FINNHUB_COMPANY_NEWS,
            params={"symbol": ticker, "from": from_date, "to": today, "token": FINNHUB_KEY},
            timeout=10,
        )
        if r.status_code == 429:
            return [], True
        if r.status_code == 401:
            log.error("Invalid FINNHUB_API_KEY — check your .env")
            return [], False
        r.raise_for_status()
        data = r.json()
        return (data if isinstance(data, list) else []), False
    except Exception as e:
        log.warning(f"news fetch error [{ticker}]: {e}")
        return [], False


# ─── Main loop ───────────────────────────────────────────────────────────────

async def run():
    if not FINNHUB_KEY:
        log.error("FINNHUB_API_KEY not set — check your .env file")
        return

    redis = await connect_redis(REDIS_URL)

    # TTL-based seen cache: uid -> expiry timestamp
    # Articles are kept in the seen cache for a long window to avoid replaying
    # the same historical article too frequently (which can look like churn).
    seen_ids: dict[str, float] = {}
    # Each article gets a random TTL so expiries are spread across cycles.
    # previous 90s–450s window produced repeating signals quickly.
    # 1h–4h window reduces identical repeated signals while still recovering old news.
    SEEN_TTL_MIN = 3600   # 1 hour
    SEEN_TTL_MAX = 14_400 # 4 hours
    cycle_num = 0

    log.info(
        f"news poller ready — {len(WATCHLIST)} tickers · "
        f"{ARTICLES_PER_TICKER} articles each · {POLL_CYCLE}s cycle · "
        f"SEEN_TTL {SEEN_TTL_MIN//3600}h–{SEEN_TTL_MAX//3600}h"
    )

    async with httpx.AsyncClient(
        headers={"User-Agent": "sovereign-war-dogs/1.0 research"},
    ) as client:

        while True:
            cycle_num  += 1
            cycle_start = time.time()
            published   = 0

            log.info(f"cycle {cycle_num} — fetching news for all {len(WATCHLIST)} tickers")

            for ticker in WATCHLIST:
                articles, rate_limited = await fetch_ticker_news(client, ticker)

                if rate_limited:
                    log.warning("Finnhub rate limited — backing off 60s and resuming cycle")
                    await asyncio.sleep(60)
                    continue

                for article in articles[:ARTICLES_PER_TICKER]:
                    # Prefix with ticker so same article generates per-ticker signals
                    uid      = f"{ticker}-{article.get('id', 0)}"
                    headline = (article.get("headline") or "").strip()

                    now_ts = time.time()
                    if not headline or seen_ids.get(uid, 0) > now_ts:
                        continue

                    seen_ids[uid] = now_ts + random.uniform(SEEN_TTL_MIN, SEEN_TTL_MAX)
                    event = build_news_event(article, ticker)

                    try:
                        await redis.xadd(
                            STREAM_NEWS,
                            {"data": json.dumps(event)},
                            maxlen=10_000,
                            approximate=True,
                        )
                        published += 1
                        log.info(f"NEWS  {ticker:6s} — {headline[:90]}")
                    except Exception as e:
                        log.error(f"Redis xadd failed: {e} — reconnecting")
                        redis = await connect_redis(REDIS_URL)

                # 2s between tickers — keeps us ~10 req/min during the active window
                await asyncio.sleep(2)

            log.info(
                f"cycle {cycle_num} done — {published} new articles published "
                f"({time.time() - cycle_start:.0f}s elapsed)"
            )

            # Evict expired entries to prevent unbounded growth
            now_ts = time.time()
            seen_ids = {k: v for k, v in seen_ids.items() if v > now_ts}

            # Sleep for the remainder of the cycle window
            elapsed    = time.time() - cycle_start
            sleep_time = max(0, POLL_CYCLE - elapsed)
            log.info(f"next cycle in {sleep_time:.0f}s")
            await asyncio.sleep(sleep_time)


if __name__ == "__main__":
    asyncio.run(run())
