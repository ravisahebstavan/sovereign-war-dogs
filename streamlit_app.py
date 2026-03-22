"""
SOVEREIGN — Streamlit Live Dashboard
Reads from Redis (local or Upstash cloud) and renders a live signal feed.
Deploy to Streamlit Community Cloud: https://streamlit.io/cloud
Set REDIS_URL in Streamlit Secrets.
"""

import json
import os
import time
from datetime import datetime, timezone

import redis
import streamlit as st

# ── Page config ──────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="SOVEREIGN — Geopolitical Alpha",
    page_icon="◈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ── Styling ───────────────────────────────────────────────────────────────────

st.markdown("""
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
  html, body, [class*="css"] { font-family: 'Share Tech Mono', monospace; }
  .main { background: #050a0f; }
  .stMetric label { font-size: 0.7rem !important; letter-spacing: 0.15em; color: #4a6a7a !important; }
  .stMetric value { color: #00ffe0 !important; }
  div[data-testid="stMetricValue"] { color: #00ffe0; font-size: 1.6rem; }
  .signal-long  { color: #00ff88; font-weight: bold; }
  .signal-short { color: #ff3366; font-weight: bold; }
  .signal-neutral { color: #4a6a7a; }
  .ticker { color: #fff; font-size: 1.1rem; font-weight: bold; letter-spacing: 0.08em; }
  .headline { color: #8a9aaa; font-size: 0.82rem; }
  hr { border-color: #0d2030; }
</style>
""", unsafe_allow_html=True)

# ── Redis connection ──────────────────────────────────────────────────────────

@st.cache_resource
def get_redis():
    url = st.secrets.get("REDIS_URL", os.getenv("REDIS_URL", "redis://localhost:6379"))
    return redis.Redis.from_url(url, decode_responses=True, socket_timeout=3)

try:
    r = get_redis()
    r.ping()
    connected = True
except Exception:
    connected = False

# ── Header ────────────────────────────────────────────────────────────────────

col1, col2 = st.columns([3, 1])
with col1:
    st.markdown("## ◈ SOVEREIGN")
    st.markdown("<span style='color:#4a6a7a;font-size:0.8rem;letter-spacing:0.15em'>GEOPOLITICAL ALPHA PIPELINE — RUST · FINBERT · REDIS</span>", unsafe_allow_html=True)
with col2:
    status_color = "#00ff88" if connected else "#ff3366"
    status_text  = "LIVE FEED" if connected else "OFFLINE"
    st.markdown(f"<div style='text-align:right;margin-top:1rem'><span style='color:{status_color};font-size:0.8rem;letter-spacing:0.1em'>● {status_text}</span></div>", unsafe_allow_html=True)
    st.markdown(f"<div style='text-align:right;color:#4a6a7a;font-size:0.75rem'>{datetime.now(timezone.utc).strftime('%H:%M:%S UTC')}</div>", unsafe_allow_html=True)

st.markdown("---")

if not connected:
    st.error("Cannot connect to Redis. Set REDIS_URL in Streamlit Secrets.")
    st.stop()

# ── Metrics ───────────────────────────────────────────────────────────────────

raw = r.xrevrange("sovereign:events", count=500)
events = []
for _, fields in raw:
    try:
        events.append(json.loads(fields["data"]))
    except Exception:
        pass

signals = [e for e in events if e.get("payload", {}).get("kind") == "signal"]
buys    = [s for s in signals if s["payload"].get("direction") == "LONG"]
shorts  = [s for s in signals if s["payload"].get("direction") == "SHORT"]

m1, m2, m3, m4 = st.columns(4)
m1.metric("TOTAL SIGNALS", len(signals))
m2.metric("LONG", len(buys))
m3.metric("SHORT", len(shorts))
m4.metric("STREAM DEPTH", r.xlen("sovereign:news"))

st.markdown("---")

# ── Signal feed ───────────────────────────────────────────────────────────────

st.markdown("### TRADE SIGNALS")
st.markdown("<span style='color:#4a6a7a;font-size:0.75rem'>FinBERT sentiment × contract boost → threshold |α| > 0.10</span>", unsafe_allow_html=True)
st.markdown("")

actionable = [s for s in signals if s["payload"].get("direction") in ("LONG", "SHORT")][:50]

if not actionable:
    st.info("No signals yet — pipeline may still be warming up.")
else:
    for ev in actionable:
        p = ev["payload"]
        direction = p.get("direction", "NEUTRAL")
        ticker    = p.get("ticker", "???")
        alpha     = p.get("alpha_score", 0.0)
        conf      = p.get("confidence", 0.0)
        boost     = p.get("contract_boost", 1.0)
        headline  = p.get("trigger_headline", "—")
        rationale = p.get("rationale", "")

        dir_color = "#00ff88" if direction == "LONG" else "#ff3366"
        dir_arrow = "▲" if direction == "LONG" else "▼"
        alpha_pct = min(abs(alpha) * 100, 100)

        with st.container():
            c1, c2, c3 = st.columns([1, 4, 2])
            with c1:
                st.markdown(f"<div class='ticker'>{ticker}</div>", unsafe_allow_html=True)
                st.markdown(f"<span style='color:{dir_color};font-size:0.85rem;font-weight:bold'>{dir_arrow} {direction}</span>", unsafe_allow_html=True)
            with c2:
                st.markdown(f"<div class='headline'>{headline[:120]}</div>", unsafe_allow_html=True)
                st.progress(alpha_pct / 100)
            with c3:
                st.markdown(f"<div style='color:#4a6a7a;font-size:0.75rem'>α = {alpha:+.3f}</div>", unsafe_allow_html=True)
                st.markdown(f"<div style='color:#4a6a7a;font-size:0.75rem'>boost {boost:.1f}× · conf {conf:.0%}</div>", unsafe_allow_html=True)
            st.markdown("---")

# ── Auto-refresh ──────────────────────────────────────────────────────────────

st.markdown("<div style='color:#0d2030;font-size:0.7rem;text-align:center'>Refreshes every 15 seconds · SOVEREIGN v1.0.9</div>", unsafe_allow_html=True)
time.sleep(15)
st.rerun()
