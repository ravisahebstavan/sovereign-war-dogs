"""
sovereign-signal/engine.py

Consumes news events from Redis Stream sovereign:news,
runs FinBERT sentiment + spaCy NER, merges SAM.gov contract boosts,
and fires paper orders to Alpaca when alpha_score exceeds threshold.

Writes SignalItems back to sovereign:events so the Rust WS server
can push them to the dashboard in real-time.
"""

import asyncio
import json
import os
import time
import uuid
import logging
from dataclasses import dataclass, asdict, field
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

import redis.asyncio as aioredis
from nlp import NLPPipeline
from alpaca_exec import AlpacaExecutor
from ticker_map import resolve_tickers

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}'
)
log = logging.getLogger("sovereign.signal")

REDIS_URL        = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM_NEWS      = "sovereign:news"
STREAM_CONTRACTS = "sovereign:contracts"
STREAM_OUT       = "sovereign:events"

# Lowered from 0.25 → 0.10 so mild sentiment on company-specific news triggers.
# With direct company-news polling, articles are always relevant — lower threshold
# captures more genuine signals without generating noise.
ALPHA_THRESHOLD  = float(os.getenv("ALPHA_THRESHOLD", "0.10"))
MAX_POSITION_USD = 1000


# ─── Theme detection ─────────────────────────────────────────────────────────
# Simple keyword-based narrative tagging — fast, no extra model required.

_THEME_KEYWORDS: dict[str, list[str]] = {
    "contract":    ["contract", "award", "win", "bid", "procurement", "pentagon",
                    "dod", "defense", "military", "government", "federal"],
    "earnings":    ["earnings", "revenue", "profit", "eps", "quarterly",
                    "fiscal", "guidance", "beat", "miss", "outlook"],
    "geopolitical":["war", "conflict", "sanction", "china", "russia", "ukraine",
                    "iran", "taiwan", "nato", "threat", "crisis", "tension"],
    "technology":  ["ai", "artificial intelligence", "cyber", "space", "satellite",
                    "missile", "drone", "hypersonic", "quantum", "software"],
    "regulatory":  ["sec", "ftc", "doj", "investigation", "lawsuit",
                    "settlement", "fine", "probe", "allegation", "compliance"],
    "m&a":         ["acquisition", "merger", "takeover", "deal",
                    "buyout", "acquire", "divest", "spin-off"],
}


def detect_themes(text: str) -> list[str]:
    lower = text.lower()
    return [
        theme
        for theme, keywords in _THEME_KEYWORDS.items()
        if any(kw in lower for kw in keywords)
    ]


# ─── Signal dataclass ─────────────────────────────────────────────────────────

@dataclass
class SignalItem:
    ticker:           str
    direction:        str            # LONG | SHORT | NEUTRAL
    confidence:       float
    sentiment:        float
    contract_boost:   float
    alpha_score:      float
    rationale:        str
    trigger_headline: str
    order_id:         Optional[str]
    # FinBERT breakdown — full 3-class probabilities
    finbert_positive: float = 0.0
    finbert_negative: float = 0.0
    finbert_neutral:  float = 0.0
    nlp_confidence:   float = 0.0   # max(pos, neg, neutral) — model certainty
    # Narrative intelligence
    themes:           list  = field(default_factory=list)
    entities:         list  = field(default_factory=list)
    article_source:   str   = ""
    article_url:      str   = ""


def build_event(signal: SignalItem, ingested_ns: int) -> dict:
    now_ns = time.time_ns()
    return {
        "id":          str(uuid.uuid4()),
        "ingested_ns": ingested_ns,
        "routed_ns":   now_ns,
        "payload": {
            "kind": "signal",
            **asdict(signal),
        }
    }


# ─── Redis connection with retry ──────────────────────────────────────────────

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


# ─── Main loop ────────────────────────────────────────────────────────────────

async def run():
    redis = await connect_redis(REDIS_URL)
    nlp   = NLPPipeline()
    exec_ = AlpacaExecutor()

    # In-memory contract boost cache: ticker → (boost_factor, expiry_unix)
    contract_cache: dict[str, tuple[float, float]] = {}

    log.info(f"signal engine ready — threshold |α|>{ALPHA_THRESHOLD} — consuming {STREAM_NEWS}")

    # Read messages from the last 10 minutes so any news published before the
    # engine started (e.g. during a news_poller cycle) is not silently missed.
    _ten_min_ago     = int((time.time() - 600) * 1000)
    last_news_id     = f"{_ten_min_ago}-0"
    last_contract_id = f"{_ten_min_ago}-0"

    while True:
        try:
            results = await redis.xread(
                streams={
                    STREAM_NEWS:      last_news_id,
                    STREAM_CONTRACTS: last_contract_id,
                },
                count=50,
                block=500,
            )
        except Exception as e:
            log.warning(f"Redis xread error: {e} — reconnecting")
            redis = await connect_redis(REDIS_URL)
            continue

        if not results:
            continue

        for stream_name, messages in results:
            for msg_id, fields in messages:
                ingested_ns = time.time_ns()

                # ── Contract boost update ─────────────────────────────────────
                if stream_name == STREAM_CONTRACTS:
                    last_contract_id = msg_id
                    try:
                        event    = json.loads(fields["data"])
                        contract = event["payload"]
                        ticker   = contract.get("ticker")
                        amount   = contract.get("usd_amount", 0) or 0
                        if ticker and amount > 0:
                            boost  = min(3.0, 1.0 + amount / 1e9)
                            expiry = time.time() + 7 * 86400
                            contract_cache[ticker] = (boost, expiry)
                            log.info(f"contract boost cached: {ticker} = {boost:.2f}×")
                    except Exception as e:
                        log.warning(f"contract parse error: {e}")
                    continue

                # ── News event ────────────────────────────────────────────────
                last_news_id = msg_id
                try:
                    event   = json.loads(fields["data"])
                    article = event["payload"]
                except (KeyError, json.JSONDecodeError) as e:
                    log.warning(f"parse error: {e}")
                    continue

                headline = article.get("headline", "")
                summary  = article.get("summary",  "")
                tickers  = article.get("tickers",  [])

                if not headline:
                    continue

                text = f"{headline}. {summary}"

                # ── NLP — run in thread pool so event loop is never blocked ──
                t0 = time.perf_counter()
                try:
                    sent_result, org_names = await asyncio.gather(
                        asyncio.to_thread(nlp.sentiment_full, text),
                        asyncio.to_thread(nlp.extract_orgs, text),
                    )
                except Exception as e:
                    log.warning(f"NLP error: {e}")
                    continue

                nlp_ms = (time.perf_counter() - t0) * 1000

                sentiment        = sent_result["scalar"]
                finbert_positive = sent_result["positive"]
                finbert_negative = sent_result["negative"]
                finbert_neutral  = sent_result["neutral"]
                nlp_confidence   = sent_result["confidence"]

                # Resolve additional tickers from NER if not already in the article
                ner_tickers  = resolve_tickers(org_names)
                all_tickers  = list(dict.fromkeys(tickers + ner_tickers))  # dedup, preserve order
                themes       = detect_themes(text)
                entities     = [{"name": n} for n in org_names[:10]]

                if not all_tickers:
                    continue

                log.info(
                    f"NLP: {nlp_ms:.1f}ms | sentiment={sentiment:+.3f} "
                    f"(pos={finbert_positive:.2f} neg={finbert_negative:.2f} "
                    f"neu={finbert_neutral:.2f} conf={nlp_confidence:.2f}) "
                    f"| tickers={all_tickers} | themes={themes}"
                )

                for ticker in all_tickers[:3]:
                    # Clean expired boosts
                    boost, expiry = contract_cache.get(ticker, (1.0, 0))
                    if time.time() > expiry:
                        contract_cache.pop(ticker, None)
                        boost = 1.0

                    alpha      = sentiment * boost
                    confidence = min(abs(alpha), 1.0)

                    if alpha > ALPHA_THRESHOLD:
                        direction = "LONG"
                    elif alpha < -ALPHA_THRESHOLD:
                        direction = "SHORT"
                    else:
                        direction = "NEUTRAL"

                    order_id = None
                    if direction != "NEUTRAL":
                        order_id = await exec_.submit(
                            ticker=ticker,
                            side="buy" if direction == "LONG" else "sell",
                            notional=MAX_POSITION_USD,
                        )

                    sentiment_pct  = abs(int(sentiment * 100))
                    sentiment_word = "positive" if sentiment > 0 else "negative"
                    boost_note     = f" · {boost:.1f}× contract boost applied" if boost > 1.0 else ""
                    rationale = (
                        f"{sentiment_pct}% {sentiment_word} sentiment{boost_note} "
                        f"(FinBERT={sentiment:+.3f} × boost={boost:.2f} = α={alpha:+.3f})"
                    )

                    signal = SignalItem(
                        ticker=ticker,
                        direction=direction,
                        confidence=confidence,
                        sentiment=sentiment,
                        contract_boost=boost,
                        alpha_score=alpha,
                        rationale=rationale,
                        trigger_headline=headline[:120],
                        order_id=order_id,
                        finbert_positive=finbert_positive,
                        finbert_negative=finbert_negative,
                        finbert_neutral=finbert_neutral,
                        nlp_confidence=nlp_confidence,
                        themes=themes,
                        entities=entities,
                        article_source=article.get("source", ""),
                        article_url=article.get("url", ""),
                    )

                    out_event = build_event(signal, ingested_ns)
                    try:
                        await redis.xadd(
                            STREAM_OUT,
                            {"data": json.dumps(out_event)},
                            maxlen=5000,
                            approximate=True,
                        )
                    except Exception as e:
                        log.error(f"Redis xadd error: {e}")

                    latency_ms = (time.time_ns() - ingested_ns) / 1e6
                    log.info(
                        f"SIGNAL {direction:7s} {ticker:6s} "
                        f"α={alpha:+.3f} conf={confidence:.2f} "
                        f"latency={latency_ms:.1f}ms"
                    )


if __name__ == "__main__":
    asyncio.run(run())
