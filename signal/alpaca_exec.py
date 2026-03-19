"""
sovereign-signal/alpaca_exec.py

Submits fractional notional orders to Alpaca paper trading.
Free account — sign up at alpaca.markets, enable paper trading,
copy your paper API key + secret to .env.

No credit card. No KYC. No money. Just an email.
"""

import os
import logging
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce

log = logging.getLogger("sovereign.alpaca")


class AlpacaExecutor:
    def __init__(self):
        key    = os.getenv("ALPACA_API_KEY", "")
        secret = os.getenv("ALPACA_SECRET_KEY", "")

        if not key or not secret:
            log.warning(
                "ALPACA_API_KEY / ALPACA_SECRET_KEY not set — "
                "order execution disabled (signals will still generate)"
            )
            self._client = None
            return

        self._client = TradingClient(key, secret, paper=True)
        log.info("Alpaca paper trading client ready")

        try:
            account = self._client.get_account()
            log.info(
                f"Alpaca paper account: "
                f"equity=${float(account.equity):,.2f} "
                f"buying_power=${float(account.buying_power):,.2f}"
            )
        except Exception as e:
            log.warning(f"Could not fetch account info: {e} — continuing anyway")
            self._client = None

    async def submit(
        self,
        ticker: str,
        side: str,
        notional: float,
    ) -> Optional[str]:
        """Submit a notional market order. Returns order ID or None."""
        if not self._client:
            log.debug(f"[DRY RUN] would {side} ${notional} of {ticker}")
            return None

        try:
            order = self._client.submit_order(
                MarketOrderRequest(
                    symbol=ticker,
                    notional=round(notional, 2),
                    side=OrderSide.BUY if side == "buy" else OrderSide.SELL,
                    time_in_force=TimeInForce.DAY,
                )
            )
            log.info(
                f"ORDER {side.upper()} ${notional} {ticker} "
                f"→ id={order.id} status={order.status}"
            )
            return str(order.id)
        except Exception as e:
            log.error(f"Alpaca order failed [{ticker} {side}]: {e}")
            return None