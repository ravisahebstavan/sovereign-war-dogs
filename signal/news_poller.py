"""
sovereign-signal/news_poller.py

Polls Finnhub company-specific news for every watchlist ticker and
publishes to the sovereign:news Redis stream in the same Event envelope
format as the Rust core.

WHY THIS EXISTS:
  The Rust core polls Finnhub *general* news which rarely has defence
  ticker tags — so the signal engine has nothing to score.
  This poller targets each ticker directly, guaranteeing relevant,
  scored articles flow continuously into the pipeline.

Rate limit: Finnhub free = 60 req/min.
  Rust core uses ~35/min (19 quotes + 1 general news).
  This poller uses ~10/min (10 tickers × 1 per 60s cycle).
  Total: ~45/min — safely under the limit.
"""

import asyncio
import json
import logging
import os
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

REDIS_URL    = os.getenv("REDIS_URL", "redis://localhost:6379")
FINNHUB_KEY  = os.getenv("FINNHUB_API_KEY", "")
STREAM_NEWS  = "sovereign:news"
POLL_CYCLE   = 90   # seconds between full cycles (all tickers)

# Top defence & aerospace watchlist — company-specific news guarantees relevance
WATCHLIST = [
    "LMT",   # Lockheed Martin
    "RTX",   # Raytheon Technologies
    "NOC",   # Northrop Grumman
    "GD",    # General Dynamics
    "BA",    # Boeing
    "HII",   # Huntington Ingalls
    "LHX",   # L3Harris
    "PLTR",  # Palantir
    "KTOS",  # Kratos Defense
    "BAH",   # Booz Allen Hamilton
    "LDOS",  # Leidos
    "SAIC",  # SAIC
    "AVAV",  # AeroVironment
    "CACI",  # CACI International
    "MANT",  # ManTech
]

FINNHUB_COMPANY_NEWS = "https://finnhub.io/api/v1/company-news"


def now_ns() -> int:
    return time.time_ns()


def build_news_event(article: dict, ticker: str) -> dict:
    ingested = now_ns()
    return {
        "id":          str(uuid.uuid4()),
        "ingested_ns": ingested,
        "routed_ns":   now_ns(),
        "payload": {
            "kind":           "news",
            "article_id":     str(article.get("id", uuid.uuid4())),
            "headline":       article.get("headline", ""),
            "summary":        article.get("summary", ""),
            "tickers":        [ticker],   # guaranteed — company-specific endpoint
            "source":         article.get("source", "finnhub"),
            "url":            article.get("url", ""),
            "published_unix": article.get("datetime", 0),
        }
    }


async def fetch_company_news(
    client: httpx.AsyncClient,
    ticker: str,
    days_back: int = 3,
) -> list[dict]:
    today     = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    from_date = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")

    try:
        r = await client.get(
            FINNHUB_COMPANY_NEWS,
            params={"symbol": ticker, "from": from_date, "to": today, "token": FINNHUB_KEY},
            timeout=10,
        )
        r.raise_for_status()
        return r.json() if isinstance(r.json(), list) else []
    except Exception as e:
        log.warning(f"news fetch error [{ticker}]: {e}")
        return []


async def run():
    if not FINNHUB_KEY:
        log.error("FINNHUB_API_KEY not set — check your .env file")
        return

    redis    = await aioredis.from_url(REDIS_URL, decode_responses=True)
    seen_ids: set[str] = set()

    log.info(f"Company news poller starting — {len(WATCHLIST)} tickers, {POLL_CYCLE}s cycle")

    async with httpx.AsyncClient(
        headers={"User-Agent": "sovereign-alpha-pipeline/0.1 research"},
    ) as client:
        while True:
            cycle_start = time.time()
            published   = 0

            for ticker in WATCHLIST:
                articles = await fetch_company_news(client, ticker)

                for article in articles:
                    article_id = str(article.get("id", ""))
                    if not article_id or article_id in seen_ids:
                        continue
                    if not article.get("headline", "").strip():
                        continue

                    seen_ids.add(article_id)
                    event = build_news_event(article, ticker)

                    await redis.xadd(
                        STREAM_NEWS,
                        {"data": json.dumps(event)},
                        maxlen=5000,
                        approximate=True,
                    )
                    published += 1
                    log.info(f"NEWS [{ticker}] {article.get('headline','')[:80]}")

                # Space requests ~1.5s apart to stay well under 60 req/min
                await asyncio.sleep(1.5)

            if published:
                log.info(f"published {published} new articles this cycle")
            else:
                log.info("cycle complete — no new articles")

            # Keep seen_ids bounded
            if len(seen_ids) > 20_000:
                seen_ids = set(list(seen_ids)[-10_000:])

            # Wait out the rest of the cycle
            elapsed = time.time() - cycle_start
            sleep_for = max(0, POLL_CYCLE - elapsed)
            log.info(f"next cycle in {sleep_for:.0f}s")
            await asyncio.sleep(sleep_for)


if __name__ == "__main__":
    asyncio.run(run())
