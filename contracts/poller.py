"""
sovereign-contracts/poller.py

Polls USASpending.gov API every 60 seconds for new defence/aerospace
contract awards. Completely free — no API key, no registration required.

USASpending.gov API docs: https://api.usaspending.gov/

Writes ContractItem events to Redis sovereign:contracts stream.
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

from resolver import awardee_to_ticker

load_dotenv()

log = logging.getLogger("sovereign.contracts")
logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}'
)

REDIS_URL        = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM_CONTRACTS = "sovereign:contracts"
POLL_INTERVAL    = 60  # seconds

# USASpending.gov — free, no API key required
USA_SPENDING_BASE = "https://api.usaspending.gov/api/v2/search/spending_by_award/"

# PSC (Product/Service Codes) for defence & aerospace
DEFENCE_PSC = [
    "1510",  # aircraft, fixed wing
    "1520",  # aircraft, rotary wing
    "1550",  # unmanned aircraft
    "1305",  # ammunition
    "1410",  # guided missiles
    "1420",  # guided missile systems
    "5821",  # radio & TV communication equipment (mil)
    "7010",  # ADP central processing units
    "R408",  # program management/support (defence)
    "R425",  # engineering/technical services
    "D302",  # IT and telecom — systems development
    "D307",  # IT operations/maintenance
    "D399",  # cybersecurity services
]

# Top defence agencies by CGAC code
DEFENCE_AGENCIES = [
    "097",   # Department of Defense
    "021",   # Department of the Army
    "017",   # Department of the Navy
    "057",   # Department of the Air Force
    "089",   # National Nuclear Security Admin
]


def build_event(award: dict, ingested_ns: int) -> dict:
    now_ns   = time.time_ns()
    awardee  = award.get("recipient_name", "Unknown") or "Unknown"
    ticker   = awardee_to_ticker(awardee)

    try:
        usd_amount = float(award.get("Award Amount", 0) or 0)
    except (ValueError, TypeError):
        usd_amount = 0.0

    award_date = award.get("Period of Performance Start Date", "")
    agency     = award.get("Awarding Agency", "")
    notice_id  = str(award.get("Award ID", "")) or str(uuid.uuid4())
    title      = (award.get("Award Description") or "")[:200]

    return {
        "id":          str(uuid.uuid4()),
        "ingested_ns": ingested_ns,
        "routed_ns":   now_ns,
        "payload": {
            "kind":       "contract",
            "notice_id":  notice_id,
            "title":      title,
            "awardee":    awardee,
            "ticker":     ticker,
            "usd_amount": usd_amount,
            "agency":     agency,
            "award_date": award_date,
        }
    }


async def fetch_recent_awards(client: httpx.AsyncClient) -> list[dict]:
    """Fetch top contract awards from the last 7 days via USASpending.gov."""
    today    = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

    payload = {
        "filters": {
            "time_period": [{"start_date": week_ago, "end_date": today}],
            "award_type_codes": ["A", "B", "C", "D"],  # contracts only
        },
        "fields": [
            "Award ID",
            "Recipient Name",
            "Award Amount",
            "Awarding Agency",
            "Award Description",
            "Period of Performance Start Date",
        ],
        "page":  1,
        "limit": 50,
        "sort":  "Award Amount",
        "order": "desc",
    }

    try:
        r = await client.post(USA_SPENDING_BASE, json=payload, timeout=20)
        r.raise_for_status()
        results = r.json().get("results", [])
        for item in results:
            item["recipient_name"] = item.get("Recipient Name", "")
        return results
    except Exception as e:
        log.warning(f"USASpending fetch error: {e}")
        return []


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


async def run():
    redis    = await connect_redis(REDIS_URL)
    seen_ids: set[str] = set()

    log.info("USASpending.gov contract poller starting")

    async with httpx.AsyncClient(
        headers={"User-Agent": "sovereign-alpha-pipeline/0.1 research"},
    ) as client:
        while True:
            ingested_ns = time.time_ns()
            awards      = await fetch_recent_awards(client)

            new_count = 0
            for award in awards:
                notice_id = str(award.get("Award ID", ""))
                if not notice_id or notice_id in seen_ids:
                    continue

                seen_ids.add(notice_id)
                event = build_event(award, ingested_ns)

                if event["payload"]["ticker"]:
                    try:
                        await redis.xadd(
                            STREAM_CONTRACTS,
                            {"data": json.dumps(event)},
                            maxlen=2000,
                            approximate=True,
                        )
                    except Exception as e:
                        log.error(f"Redis xadd failed: {e} — reconnecting")
                        redis = await connect_redis(REDIS_URL)
                        continue
                    new_count += 1
                    log.info(
                        f"CONTRACT {event['payload']['ticker']:6s} "
                        f"${event['payload']['usd_amount']:,.0f} "
                        f"<- {event['payload']['awardee'][:40]}"
                    )

            if new_count:
                log.info(f"published {new_count} new contract awards")
            else:
                log.info(f"poll complete — {len(awards)} awards fetched, 0 new actionable")

            # Keep seen_ids bounded
            if len(seen_ids) > 10_000:
                seen_ids = set(list(seen_ids)[-5_000:])

            await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(run())
