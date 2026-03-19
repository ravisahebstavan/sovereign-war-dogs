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
from dataclasses import dataclass, asdict
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

REDIS_URL       = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM_NEWS     = "sovereign:news"
STREAM_CONTRACTS = "sovereign:contracts"
STREAM_OUT      = "sovereign:events"

ALPHA_THRESHOLD  = 0.25   # |alpha_score| must exceed this to trade
MAX_POSITION_USD = 1000   # paper money position cap per ticker


@dataclass
class SignalItem:
    ticker: str
    direction: str            # LONG | SHORT | NEUTRAL
    confidence: float
    sentiment: float
    contract_boost: float
    alpha_score: float
    rationale: str
    trigger_headline: str
    order_id: Optional[str]


def build_event(signal: SignalItem, ingested_ns: int) -> dict:
    now_ns = time.time_ns()
    return {
        "id": str(uuid.uuid4()),
        "ingested_ns": ingested_ns,
        "routed_ns": now_ns,
        "payload": {
            "kind": "signal",
            **asdict(signal),
        }
    }


async def run():
    redis = await aioredis.from_url(REDIS_URL, decode_responses=True)
    nlp   = NLPPipeline()
    exec_ = AlpacaExecutor()

    # In-memory contract boost cache: ticker → (boost_factor, expiry_unix)
    contract_cache: dict[str, tuple[float, float]] = {}

    log.info("signal engine ready — consuming sovereign:news")

    last_news_id     = "$"   # start from latest
    last_contract_id = "$"

    while True:
        # ── Read news and contract streams concurrently ──────────────────────
        results = await redis.xread(
            streams={
                STREAM_NEWS:      last_news_id,
                STREAM_CONTRACTS: last_contract_id,
            },
            count=50,
            block=500,  # block up to 500ms — keeps CPU idle when quiet
        )

        if not results:
            continue

        for stream_name, messages in results:
            for msg_id, fields in messages:
                ingested_ns = time.time_ns()

                if stream_name == STREAM_CONTRACTS:
                    last_contract_id = msg_id
                    try:
                        event = json.loads(fields["data"])
                        contract = event["payload"]
                        ticker = contract.get("ticker")
                        if ticker and contract.get("usd_amount", 0) > 0:
                            # Boost decays linearly: 3× for fresh awards, 1× after 7 days
                            boost = min(3.0, 1.0 + contract["usd_amount"] / 1e9)
                            expiry = time.time() + 7 * 86400
                            contract_cache[ticker] = (boost, expiry)
                            log.info(f"contract boost cached: {ticker} = {boost:.2f}×")
                    except Exception as e:
                        log.warning(f"contract parse error: {e}")
                    continue

                # ── News event ───────────────────────────────────────────────
                last_news_id = msg_id
                try:
                    event = json.loads(fields["data"])
                    article = event["payload"]
                except (KeyError, json.JSONDecodeError) as e:
                    log.warning(f"parse error: {e}")
                    continue

                headline = article.get("headline", "")
                summary  = article.get("summary", "")
                tickers  = article.get("tickers", [])

                if not headline:
                    continue

                # Resolve additional tickers from NER if Finnhub didn't tag them
                text = f"{headline}. {summary}"
                ner_tickers = resolve_tickers(nlp.extract_orgs(text))
                all_tickers = list(set(tickers + ner_tickers))

                if not all_tickers:
                    continue

                # Run FinBERT sentiment
                t0 = time.perf_counter()
                sentiment = nlp.sentiment(text)  # float in [-1, 1]
                nlp_ms = (time.perf_counter() - t0) * 1000

                log.info(f"NLP: {nlp_ms:.1f}ms | sentiment={sentiment:.3f} | tickers={all_tickers}")

                for ticker in all_tickers[:3]:  # cap at 3 tickers per article
                    # Clean expired boosts
                    boost, expiry = contract_cache.get(ticker, (1.0, 0))
                    if time.time() > expiry:
                        contract_cache.pop(ticker, None)
                        boost = 1.0

                    alpha = sentiment * boost
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

                    sentiment_pct = abs(int(sentiment * 100))
                    sentiment_word = "positive" if sentiment > 0 else "negative"
                    boost_note = f" · {boost:.1f}x contract boost applied" if boost > 1.0 else ""
                    rationale = (
                        f"{sentiment_pct}% {sentiment_word} sentiment{boost_note} "
                        f"(raw: FinBERT={sentiment:+.3f} x boost={boost:.2f} = alpha={alpha:+.3f})"
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
                    )

                    out_event = build_event(signal, ingested_ns)
                    await redis.xadd(
                        STREAM_OUT,
                        {"data": json.dumps(out_event)},
                        maxlen=5000,
                        approximate=True,
                    )

                    latency_ms = (time.time_ns() - ingested_ns) / 1e6
                    log.info(
                        f"SIGNAL {direction:7s} {ticker:6s} "
                        f"α={alpha:+.3f} conf={confidence:.2f} "
                        f"latency={latency_ms:.1f}ms"
                    )


if __name__ == "__main__":
    asyncio.run(run())
