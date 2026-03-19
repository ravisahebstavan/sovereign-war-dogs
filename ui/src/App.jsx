import { useState, useEffect, useRef, useCallback } from "react";

// ─── WebSocket hook ───────────────────────────────────────────────────────────

function useSovereignWS(url) {
  const [signals, setSignals]     = useState([]);
  const [contracts, setContracts] = useState([]);
  const [trades, setTrades]       = useState({});
  const [latency, setLatency]     = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen  = () => { setConnected(true); clearTimeout(reconnectRef.current); };
      ws.onclose = () => { setConnected(false); reconnectRef.current = setTimeout(connect, 2000); };
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          const p  = ev.payload;
          if (!p) return;
          if (p.kind === "signal")
            setSignals(prev => [{ ...p, _id: ev.id, _ts: Date.now() }, ...prev].slice(0, 100));
          else if (p.kind === "contract")
            setContracts(prev => [{ ...p, _id: ev.id, _ts: Date.now() }, ...prev].slice(0, 50));
          else if (p.kind === "trade")
            setTrades(prev => ({ ...prev, [p.ticker]: { price: p.price, volume: p.volume, ts: Date.now() } }));
          else if (p.kind === "latency_snapshot")
            setLatency(p);
        } catch {}
      };
    } catch {}
  }, [url]);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); clearTimeout(reconnectRef.current); };
  }, [connect]);

  return { signals, contracts, trades, latency, connected };
}

// ─── Trading terminology helpers ─────────────────────────────────────────────

function getAction(direction) {
  if (direction === "LONG")    return { label: "BUY",        symbol: "▲", color: "#00ff88", bg: "rgba(0,255,136,0.08)", border: "rgba(0,255,136,0.3)" };
  if (direction === "SHORT")   return { label: "SELL SHORT", symbol: "▼", color: "#ff3355", bg: "rgba(255,51,85,0.08)",  border: "rgba(255,51,85,0.3)"  };
  return                               { label: "HOLD",       symbol: "—", color: "#888",    bg: "rgba(136,136,136,0.05)", border: "rgba(136,136,136,0.2)" };
}

function getSignalStrength(confidence) {
  if (confidence >= 0.8) return { label: "STRONG",   color: "#00ff88" };
  if (confidence >= 0.6) return { label: "MODERATE", color: "#ffaa00" };
  if (confidence >= 0.4) return { label: "WEAK",     color: "#ff7700" };
  return                         { label: "MARGINAL", color: "#ff3355" };
}

function contractBoost(usd_amount) {
  return Math.min(3.0, 1.0 + (usd_amount || 0) / 1e9);
}

const fmt = {
  usd:  (n) => n >= 1e9 ? `$${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : `$${Number(n).toLocaleString()}`,
  pct:  (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`,
  time: (ms) => new Date(ms).toLocaleTimeString("en-US", { hour12: false }),
};

// ─── Status Bar ───────────────────────────────────────────────────────────────

function StatusBar({ connected, latency, signals, contracts }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(t => t+1), 1000); return () => clearInterval(i); }, []);
  const buys   = signals.filter(s => s.direction === "LONG").length;
  const shorts = signals.filter(s => s.direction === "SHORT").length;

  return (
    <div style={{ display:"flex", alignItems:"center", gap:20, padding:"7px 20px", background:"#0a0a0a", borderBottom:"1px solid #1a1a1a", fontFamily:"'JetBrains Mono',monospace", fontSize:11, flexWrap:"wrap" }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div style={{ width:7, height:7, borderRadius:"50%", background: connected ? "#00ff88" : "#ff3355", boxShadow: connected ? "0 0 8px #00ff88" : "0 0 8px #ff3355", animation: connected ? "pulse 2s infinite" : "none" }} />
        <span style={{ color: connected ? "#00ff88" : "#ff3355", fontWeight:700 }}>
          {connected ? "LIVE FEED" : "OFFLINE — start sovereign-core"}
        </span>
      </div>
      <span style={{ color:"#333" }}>│</span>
      <span style={{ color:"#555" }}>BUY <span style={{ color:"#00ff88", fontWeight:700 }}>{buys}</span></span>
      <span style={{ color:"#555" }}>SHORT <span style={{ color:"#ff3355", fontWeight:700 }}>{shorts}</span></span>
      <span style={{ color:"#555" }}>CONTRACTS <span style={{ color:"#ff9900", fontWeight:700 }}>{contracts.length}</span></span>
      {latency && (
        <>
          <span style={{ color:"#333" }}>│</span>
          <span style={{ color:"#555" }}>LATENCY P50 <span style={{ color:"#e0e0e0" }}>{latency.p50_us}µs</span></span>
          <span style={{ color:"#555" }}>P99 <span style={{ color: latency.p99_us > 5000 ? "#ff3355" : "#e0e0e0" }}>{latency.p99_us}µs</span></span>
        </>
      )}
      <span style={{ marginLeft:"auto", color:"#444", fontSize:10 }}>{new Date().toLocaleTimeString("en-US", { hour12:false })} UTC</span>
    </div>
  );
}

// ─── Signal Card ──────────────────────────────────────────────────────────────

function SignalCard({ signal }) {
  const [flash, setFlash] = useState(true);
  useEffect(() => { const t = setTimeout(() => setFlash(false), 800); return () => clearTimeout(t); }, []);

  const action   = getAction(signal.direction);
  const strength = getSignalStrength(signal.confidence);
  const confPct  = Math.round(signal.confidence * 100);
  const hasBoost = signal.contract_boost > 1.05;

  return (
    <div style={{
      padding: "14px 16px",
      borderLeft: `3px solid ${action.color}`,
      background: flash ? "rgba(255,255,255,0.04)" : action.bg,
      borderBottom: "1px solid #111",
      transition: "background 0.8s ease",
      animation: flash ? "slideIn 0.3s ease" : "none",
    }}>

      {/* Row 1: Action + Ticker + Order badge */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {/* Action badge */}
          <div style={{
            display:"flex", alignItems:"center", gap:5,
            background: action.bg,
            border: `1px solid ${action.border}`,
            padding: "4px 10px",
            borderRadius: 2,
          }}>
            <span style={{ fontSize:14, color: action.color }}>{action.symbol}</span>
            <span style={{ fontSize:11, fontWeight:700, color: action.color, letterSpacing:"0.12em" }}>{action.label}</span>
          </div>

          {/* Ticker */}
          <span style={{ fontSize:18, fontWeight:700, color:"#f0f0f0", fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.05em" }}>
            {signal.ticker}
          </span>

          {/* Strength label */}
          <span style={{ fontSize:9, color: strength.color, background:`${strength.color}15`, border:`1px solid ${strength.color}33`, padding:"2px 6px", letterSpacing:"0.15em" }}>
            {strength.label}
          </span>

          {/* Contract boost badge */}
          {hasBoost && (
            <span style={{ fontSize:9, color:"#ff9900", background:"rgba(255,153,0,0.1)", border:"1px solid rgba(255,153,0,0.3)", padding:"2px 6px", letterSpacing:"0.1em" }}>
              {signal.contract_boost.toFixed(1)}× CONTRACT BOOST
            </span>
          )}
        </div>

        {/* Right: position size + order status */}
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontSize:11, color:"#555", fontFamily:"monospace" }}>$1,000 PAPER</span>
          {signal.direction !== "NEUTRAL" && (
            <span style={{
              fontSize:10, padding:"2px 8px",
              color: signal.order_id ? "#00ff88" : "#666",
              border: `1px solid ${signal.order_id ? "#00ff8855" : "#333"}`,
              fontFamily:"monospace",
            }}>
              {signal.order_id ? "ORDER FILLED ✓" : "SUBMITTING…"}
            </span>
          )}
        </div>
      </div>

      {/* Row 2: Confidence bar */}
      <div style={{ marginBottom:8 }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
          <span style={{ fontSize:9, color:"#444", letterSpacing:"0.1em" }}>CONFIDENCE</span>
          <span style={{ fontSize:10, color: strength.color, fontWeight:700, fontFamily:"'JetBrains Mono',monospace" }}>{confPct}%</span>
        </div>
        <div style={{ height:3, background:"#111", borderRadius:2 }}>
          <div style={{ height:"100%", width:`${confPct}%`, background: strength.color, borderRadius:2, boxShadow:`0 0 6px ${strength.color}`, transition:"width 0.5s ease" }} />
        </div>
      </div>

      {/* Row 3: Plain-English rationale */}
      <div style={{ fontSize:11, color:"#888", marginBottom:6, lineHeight:1.5 }}>
        {signal.rationale}
      </div>

      {/* Row 4: Triggering headline */}
      <div style={{ fontSize:11, color:"#555", fontFamily:"'JetBrains Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:6 }}>
        <span style={{ color:"#333" }}>NEWS » </span>{signal.trigger_headline}
      </div>

      {/* Row 5: Raw numbers */}
      <div style={{ display:"flex", gap:16, fontSize:10, color:"#333", fontFamily:"'JetBrains Mono',monospace" }}>
        <span>alpha <span style={{ color: signal.alpha_score > 0 ? "#00ff8888" : "#ff335588" }}>{signal.alpha_score >= 0 ? "+" : ""}{signal.alpha_score.toFixed(3)}</span></span>
        <span>sentiment <span style={{ color:"#555" }}>{fmt.pct(signal.sentiment)}</span></span>
        <span>boost <span style={{ color:"#555" }}>{signal.contract_boost.toFixed(2)}×</span></span>
        <span style={{ marginLeft:"auto", color:"#333" }}>{fmt.time(signal._ts)}</span>
      </div>
    </div>
  );
}

// ─── Contract Card ────────────────────────────────────────────────────────────

function ContractCard({ contract }) {
  const boost = contractBoost(contract.usd_amount);
  const boostColor = boost >= 2.5 ? "#ff3355" : boost >= 1.5 ? "#ff9900" : "#ffdd44";

  return (
    <div style={{ padding:"12px 14px", borderLeft:"3px solid #ff9900", background:"rgba(255,153,0,0.04)", borderBottom:"1px solid #111" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
            <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:700, color:"#ff9900" }}>
              {contract.ticker}
            </span>
            <span style={{ fontSize:10, color:"#555" }}>{(contract.awardee || "").slice(0,35)}</span>
          </div>
          <div style={{ fontSize:10, color:"#444", fontFamily:"monospace", marginBottom:4 }}>{contract.agency}</div>
          {contract.title && (
            <div style={{ fontSize:10, color:"#333", fontFamily:"'JetBrains Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:200 }}>
              {contract.title.slice(0,60)}
            </div>
          )}
        </div>
        <div style={{ textAlign:"right", flexShrink:0, marginLeft:10 }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:15, fontWeight:700, color:"#ff9900" }}>
            {fmt.usd(contract.usd_amount)}
          </div>
          <div style={{ fontSize:9, color:"#444", marginTop:2 }}>{contract.award_date}</div>
        </div>
      </div>
      {/* Boost indicator */}
      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 8px", background:"rgba(255,153,0,0.06)", border:"1px solid rgba(255,153,0,0.15)", marginTop:4 }}>
        <span style={{ fontSize:12, color: boostColor }}>⚡</span>
        <span style={{ fontSize:9, color: boostColor, fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.1em" }}>
          {boost.toFixed(1)}× SIGNAL BOOST — amplifies {contract.ticker} sentiment for 7 days
        </span>
      </div>
    </div>
  );
}

// ─── Price Grid ───────────────────────────────────────────────────────────────

function PriceGrid({ trades }) {
  const tickers = Object.keys(trades);
  if (!tickers.length) return (
    <div style={{ padding:16, color:"#2a2a2a", fontSize:11, fontFamily:"monospace" }}>awaiting live prices…</div>
  );
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(100px, 1fr))", gap:1 }}>
      {tickers.map(t => {
        const { price, ts } = trades[t];
        const fresh = Date.now() - ts < 4000;
        return (
          <div key={t} style={{ padding:"8px 10px", background: fresh ? "rgba(0,255,136,0.05)" : "#0d0d0d", transition:"background 1.2s ease" }}>
            <div style={{ fontSize:9, color:"#444", fontFamily:"monospace", letterSpacing:"0.12em", marginBottom:2 }}>{t}</div>
            <div style={{ fontSize:14, fontWeight:700, fontFamily:"'JetBrains Mono',monospace", color: fresh ? "#00ff88" : "#666", transition:"color 1.2s ease" }}>
              ${price.toFixed(2)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Latency Panel ────────────────────────────────────────────────────────────

function LatencyPanel({ latency, connected }) {
  const bar = (value, max, label, color) => {
    const pct = Math.min((value / max) * 100, 100);
    return (
      <div style={{ marginBottom:10 }} key={label}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
          <span style={{ fontSize:9, color:"#444", fontFamily:"monospace", letterSpacing:"0.12em" }}>{label}</span>
          <span style={{ fontSize:11, color, fontFamily:"'JetBrains Mono',monospace", fontWeight:700 }}>{value}µs</span>
        </div>
        <div style={{ height:3, background:"#111" }}>
          <div style={{ height:"100%", width:`${pct}%`, background:color, boxShadow:`0 0 5px ${color}`, transition:"width 0.5s ease" }} />
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding:"14px 16px", borderBottom:"1px solid #111" }}>
      <div style={{ fontSize:9, color:"#444", letterSpacing:"0.2em", marginBottom:12 }}>PIPELINE LATENCY</div>
      {latency ? (
        <>
          {bar(latency.p50_us, 10000, "P50  MEDIAN",       "#00ff88")}
          {bar(latency.p95_us, 10000, "P95  95th pct",     "#88ff00")}
          {bar(latency.p99_us, 10000, "P99  99th pct",     latency.p99_us > 5000 ? "#ff3355" : "#ffaa00")}
          {bar(latency.max_us, 10000, "MAX  worst case",   "#ff3355")}
          <div style={{ marginTop:8, padding:8, background:"#0c0c0c", fontSize:9, color:"#333", fontFamily:"monospace", lineHeight:1.8 }}>
            <div>Finnhub → Rust parse  &lt;500µs</div>
            <div>Rust → Redis XADD     &lt;200µs</div>
            <div>FinBERT CPU inference  ~130ms</div>
            <div>Alpaca order submit    ~40ms</div>
          </div>
        </>
      ) : (
        <div style={{ fontSize:11, color:"#2a2a2a" }}>{connected ? "collecting samples…" : "offline"}</div>
      )}
    </div>
  );
}

// ─── Glossary pill ────────────────────────────────────────────────────────────

function GlossaryBar() {
  const terms = [
    { term:"BUY",         def:"Open a long position — betting the price will rise" },
    { term:"SELL SHORT",  def:"Borrow shares and sell them, betting the price will fall" },
    { term:"ALPHA",       def:"Expected excess return vs the market (sentiment × boost)" },
    { term:"BOOST",       def:"Multiplier applied when a company has a recent gov contract" },
    { term:"CONF",        def:"Model confidence 0–100% (abs value of alpha, capped at 1)" },
    { term:"PAPER",       def:"Simulated trade — no real money, uses Alpaca paper account" },
  ];
  const [active, setActive] = useState(null);

  return (
    <div style={{ padding:"6px 16px", background:"#060606", borderBottom:"1px solid #111", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
      <span style={{ fontSize:9, color:"#333", letterSpacing:"0.15em", marginRight:4 }}>GLOSSARY</span>
      {terms.map(({ term, def }) => (
        <div key={term} style={{ position:"relative" }}
          onMouseEnter={() => setActive(term)}
          onMouseLeave={() => setActive(null)}>
          <span style={{ fontSize:9, color:"#444", border:"1px solid #222", padding:"2px 6px", cursor:"default", fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.08em" }}>
            {term}
          </span>
          {active === term && (
            <div style={{ position:"absolute", bottom:"calc(100% + 4px)", left:0, zIndex:100, background:"#1a1a1a", border:"1px solid #333", padding:"6px 10px", fontSize:10, color:"#aaa", whiteSpace:"nowrap", boxShadow:"0 4px 16px #000" }}>
              {def}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Empty state for signals ──────────────────────────────────────────────────

function SignalEmptyState({ connected }) {
  if (!connected) return (
    <div style={{ padding:"28px 20px", color:"#333", fontSize:11, fontFamily:"'JetBrains Mono',monospace", lineHeight:2 }}>
      <div style={{ color:"#ff3355", marginBottom:10, fontSize:12 }}>⬤ PIPELINE OFFLINE</div>
      <div>Run start_sovereign.bat to launch all services:</div>
      <div style={{ marginTop:6, color:"#2a2a2a" }}>
        <div>1. redis-server</div>
        <div>2. sovereign-core.exe  (port 9001)</div>
        <div>3. python contracts/poller.py</div>
        <div>4. python signal/engine.py</div>
      </div>
    </div>
  );
  return (
    <div style={{ padding:"28px 20px", color:"#333", fontSize:11, fontFamily:"'JetBrains Mono',monospace", lineHeight:1.9 }}>
      <div style={{ color:"#00ff88", marginBottom:8 }}>⬤ CONNECTED — waiting for signals</div>
      <div style={{ color:"#2a2a2a" }}>
        <div>· FinBERT scoring incoming news headlines</div>
        <div>· Threshold: |alpha| &gt; 0.35 to generate BUY/SHORT</div>
        <div>· Defense news triggers most frequently</div>
        <div>· Contract boosts amplify signals up to 3×</div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const { signals, contracts, trades, latency, connected } = useSovereignWS("ws://localhost:9001/ws");

  const buys   = signals.filter(s => s.direction === "LONG").length;
  const shorts = signals.filter(s => s.direction === "SHORT").length;
  const holds  = signals.filter(s => s.direction === "NEUTRAL").length;

  return (
    <div style={{ background:"#080808", minHeight:"100vh", color:"#e0e0e0", fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@700;800&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        body { background:#080808; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:#0d0d0d; }
        ::-webkit-scrollbar-thumb { background:#222; border-radius:2px; }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes slideIn { from{transform:translateX(-6px);opacity:0} to{transform:translateX(0);opacity:1} }
      `}</style>

      {/* ── Header ── */}
      <div style={{ padding:"14px 20px 12px", borderBottom:"1px solid #141414", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#050505" }}>
        <div>
          <div style={{ fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800, letterSpacing:"0.25em", color:"#f0f0f0" }}>SOVEREIGN</div>
          <div style={{ fontSize:9, color:"#2a2a2a", letterSpacing:"0.18em", marginTop:2 }}>
            GEOPOLITICAL ALPHA PIPELINE — RUST + PYTHON + FINBERT — ALL FREE
          </div>
        </div>

        {/* Signal counters */}
        <div style={{ display:"flex", gap:28 }}>
          {[
            { label:"BUY",       value:buys,              color:"#00ff88", hint:"Long positions" },
            { label:"SELL SHORT",value:shorts,            color:"#ff3355", hint:"Short positions" },
            { label:"HOLD",      value:holds,             color:"#555",    hint:"Below threshold" },
            { label:"CONTRACTS", value:contracts.length,  color:"#ff9900", hint:"Active boosts" },
          ].map(({ label, value, color, hint }) => (
            <div key={label} style={{ textAlign:"center" }} title={hint}>
              <div style={{ fontSize:8, color:"#333", letterSpacing:"0.15em", marginBottom:2 }}>{label}</div>
              <div style={{ fontSize:22, fontWeight:700, color, fontFamily:"'JetBrains Mono',monospace" }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      <StatusBar connected={connected} latency={latency} signals={signals} contracts={contracts} />
      <GlossaryBar />

      {/* ── Main grid ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 300px", gap:1, background:"#111", minHeight:"calc(100vh - 130px)" }}>

        {/* Left column */}
        <div style={{ background:"#080808", display:"flex", flexDirection:"column" }}>

          {/* Signal feed header */}
          <div style={{ padding:"10px 16px", borderBottom:"1px solid #111", background:"#0a0a0a", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:10, color:"#555", letterSpacing:"0.2em" }}>TRADE SIGNALS</span>
              {connected && signals.length > 0 && (
                <span style={{ fontSize:9, color:"#333", fontFamily:"monospace" }}>{signals.length} total this session</span>
              )}
            </div>
            <span style={{ fontSize:9, color:"#2a2a2a", fontFamily:"monospace" }}>
              FinBERT sentiment × contract boost — threshold |α|&gt;0.35
            </span>
          </div>

          {/* Signal cards */}
          <div style={{ flex:1, overflowY:"auto", maxHeight:"calc(100vh - 330px)" }}>
            {signals.length === 0
              ? <SignalEmptyState connected={connected} />
              : signals.map(s => <SignalCard key={s._id} signal={s} />)
            }
          </div>

          {/* Live prices */}
          <div>
            <div style={{ padding:"9px 16px", borderBottom:"1px solid #111", borderTop:"1px solid #111", background:"#0a0a0a", display:"flex", justifyContent:"space-between" }}>
              <span style={{ fontSize:10, color:"#555", letterSpacing:"0.2em" }}>WATCHLIST</span>
              <span style={{ fontSize:9, color:"#2a2a2a" }}>live via Finnhub · refreshes every 15s</span>
            </div>
            <PriceGrid trades={trades} />
          </div>
        </div>

        {/* Right column */}
        <div style={{ background:"#080808", display:"flex", flexDirection:"column" }}>
          <LatencyPanel latency={latency} connected={connected} />

          {/* Contract feed */}
          <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>
            <div style={{ padding:"10px 14px", background:"#0a0a0a", borderBottom:"1px solid #111", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:10, color:"#555", letterSpacing:"0.2em" }}>GOV CONTRACTS</span>
              <span style={{ fontSize:9, color:"#2a2a2a" }}>USASpending · 60s poll</span>
            </div>
            <div style={{ overflowY:"auto", flex:1 }}>
              {!connected ? (
                <div style={{ padding:14, color:"#2a2a2a", fontSize:11 }}>offline</div>
              ) : contracts.length === 0 ? (
                <div style={{ padding:14, color:"#2a2a2a", fontSize:11, lineHeight:1.8, fontFamily:"monospace" }}>
                  <div>polling USASpending.gov…</div>
                  <div style={{ marginTop:6, fontSize:10, color:"#222" }}>Contract awards trigger</div>
                  <div style={{ fontSize:10, color:"#222" }}>signal boosts up to 3×</div>
                </div>
              ) : (
                contracts.map(c => <ContractCard key={c._id} contract={c} />)
              )}
            </div>
          </div>

          {/* Stack footer */}
          <div style={{ padding:"10px 14px", borderTop:"1px solid #0e0e0e", background:"#050505" }}>
            <div style={{ fontSize:8, color:"#1e1e1e", fontFamily:"monospace", lineHeight:1.9, letterSpacing:"0.05em" }}>
              {["RUST tokio/axum (ingestion + WS)","Redis Streams (message bus)","spaCy NER (entity extraction)","ProsusAI/finbert (sentiment)","USASpending.gov (contracts)","Finnhub (news + live prices)","Alpaca (paper trade execution)","100% FREE · OPEN SOURCE"].map((l,i) => <div key={i}>› {l}</div>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
