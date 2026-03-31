"""
sovereign-signal/rss_poller.py

Polls Google News RSS and Yahoo Finance RSS for all watchlist tickers
and publishes NewsItem events to the sovereign:news Redis stream.

WHY THIS EXISTS:
  Finnhub free tier has rate limits and primarily indexes articles after a
  delay.  Google News and Yahoo Finance RSS feeds are public, unlimited, and
  frequently carry stories minutes before Finnhub indexes them — giving the
  FinBERT engine a richer, more current article pool to score.

  Both feeds return standard RSS 2.0 XML parsed with stdlib
  xml.etree.ElementTree — no extra dependencies beyond what news_poller.py
  already requires.

Rate limits: None (public RSS endpoints).  We add small courtesy delays.
"""

import asyncio
import hashlib
import json
import logging
import os
import random
import time
import uuid
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

import httpx
import redis.asyncio as aioredis
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("sovereign.rss_poller")
logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}'
)

REDIS_URL   = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM_NEWS = "sovereign:news"
POLL_CYCLE  = 60    # seconds between full cycles — no API rate limit constraints

# Extended 28-ticker watchlist — defence primes, cyber, AI hardware, cloud
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

# Long TTL so duplicate articles from two feeds don't double-fire on the engine.
# Random spread prevents all-at-once expiry bursts (same design as news_poller.py).
SEEN_TTL_MIN = 3600    # 1 hour
SEEN_TTL_MAX = 14_400  # 4 hours


# ─── Feed URL helpers ─────────────────────────────────────────────────────────

def _google_news_url(ticker: str) -> str:
    query = f"{ticker}+stock+defense+aerospace+contract+government"
    return (
        f"https://news.google.com/rss/search"
        f"?q={query}&hl=en-US&gl=US&ceid=US:en"
    )


def _yahoo_finance_url(ticker: str) -> str:
    return f"https://finance.yahoo.com/rss/headline?s={ticker}"


# ─── Redis connection with exponential backoff ────────────────────────────────

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


# ─── RSS XML parser ───────────────────────────────────────────────────────────

def parse_rss(xml_text: str, ticker: str, source: str) -> list[dict]:
    """Parse RSS 2.0 XML and return article dicts compatible with build_news_event."""
    articles = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.warning(f"RSS parse error [{source}/{ticker}]: {e}")
        return articles

    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link  = (item.findtext("link")  or "").strip()
        desc  = (item.findtext("description") or "").strip()
        pub   = item.findtext("pubDate") or ""

        if not title:
            continue

        # Strip any embedded HTML from Google News descriptions
        if "<" in desc:
            try:
                desc = ET.fromstring(f"<x>{desc}</x>").text or desc
            except ET.ParseError:
                desc = desc[:500]

        # Stable content-hash ID — same article from two feeds → same uid
        article_id = hashlib.sha1(f"{link}{title}".encode()).hexdigest()

        pub_unix = 0
        if pub:
            try:
                pub_unix = int(parsedate_to_datetime(pub).timestamp())
            except Exception:
                pass

        articles.append({
            "id":       article_id,
            "headline": title,
            "summary":  desc[:500],
            "source":   source,
            "url":      link,
            "datetime": pub_unix,
        })

    return articles


# ─── Event builder — identical shape to news_poller.py ───────────────────────

def build_news_event(article: dict, ticker: str) -> dict:
    now_ns = time.time_ns()
    return {
        "id":          str(uuid.uuid4()),
        "ingested_ns": now_ns,
        "routed_ns":   now_ns,
        "payload": {
            "kind":           "news",
            "article_id":     str(article["id"]),
            "headline":       article["headline"],
            "summary":        article.get("summary", ""),
            "tickers":        [ticker],
            "source":         article.get("source", "rss"),
            "url":            article.get("url", ""),
            "published_unix": article.get("datetime", 0),
        },
    }


# ─── HTTP fetch one RSS feed ──────────────────────────────────────────────────

async def fetch_rss(
    client: httpx.AsyncClient,
    url: str,
    ticker: str,
    source: str,
) -> list[dict]:
    try:
        r = await client.get(url, timeout=10, follow_redirects=True)
        if r.status_code != 200:
            log.warning(f"RSS {source} [{ticker}] HTTP {r.status_code}")
            return []
        return parse_rss(r.text, ticker, source)
    except Exception as e:
        log.warning(f"RSS {source} [{ticker}] fetch error: {e}")
        return []


# ─── Main loop ────────────────────────────────────────────────────────────────

async def run():
    redis = await connect_redis(REDIS_URL)
    seen_ids: dict[str, float] = {}
    cycle_num = 0

    log.info(
        f"RSS poller ready — {len(WATCHLIST)} tickers · "
        f"Google News + Yahoo Finance · {POLL_CYCLE}s cycle"
    )

    async with httpx.AsyncClient(
        headers={
            "User-Agent": (
                "Mozilla/5.0 (compatible; sovereign-war-dogs/1.0; "
                "+https://github.com/ravisahebstavan/sovereign-war-dogs)"
            )
        },
    ) as client:

        while True:
            cycle_num  += 1
            cycle_start = time.time()
            published   = 0

            log.info(f"RSS cycle {cycle_num} — {len(WATCHLIST)} tickers × 2 feeds")

            for ticker in WATCHLIST:
                feeds = [
                    (_google_news_url(ticker),  "google-news"),
                    (_yahoo_finance_url(ticker), "yahoo-finance"),
                ]

                for url, source in feeds:
                    articles = await fetch_rss(client, url, ticker, source)

                    now_ts = time.time()
                    for article in articles[:10]:
                        headline = article["headline"].strip()
                        uid = f"{source}-{ticker}-{article['id']}"

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
                            log.info(f"RSS   {ticker:6s} [{source}] — {headline[:80]}")
                        except Exception as e:
                            log.error(f"Redis xadd failed: {e} — reconnecting")
                            redis = await connect_redis(REDIS_URL)

                    # Courtesy delay between feeds for the same ticker
                    await asyncio.sleep(0.5)

                # Small delay between tickers
                await asyncio.sleep(1)

            log.info(
                f"RSS cycle {cycle_num} done — {published} new articles published "
                f"({time.time() - cycle_start:.0f}s elapsed)"
            )

            # Evict expired entries to prevent unbounded memory growth
            now_ts   = time.time()
            seen_ids = {k: v for k, v in seen_ids.items() if v > now_ts}

            elapsed    = time.time() - cycle_start
            sleep_time = max(0, POLL_CYCLE - elapsed)
            log.info(f"next RSS cycle in {sleep_time:.0f}s")
            await asyncio.sleep(sleep_time)


if __name__ == "__main__":
    asyncio.run(run())
