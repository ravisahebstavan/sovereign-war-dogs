import { useState, useEffect, useRef, useCallback } from "react";
import Setup, { isBrowserSetupComplete } from "./Setup.jsx";

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
      ws.onerror = () => { /* let onclose handle reconnect */ };
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
        } catch (err) {
          console.warn("[SOVEREIGN] WS message parse error:", err);
        }
      };
    } catch (err) {
      console.warn("[SOVEREIGN] WebSocket connect error:", err);
      reconnectRef.current = setTimeout(connect, 2000);
    }
  }, [url]);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); clearTimeout(reconnectRef.current); };
  }, [connect]);

  const refresh = useCallback(() => {
    setSignals([]);
    setContracts([]);
    setLatency(null);
    clearTimeout(reconnectRef.current);
    if (wsRef.current) {
      wsRef.current.onclose = null; // suppress auto-reconnect from the old socket
      wsRef.current.close();
    }
    connect();
  }, [connect]);

  return { signals, contracts, trades, latency, connected, refresh };
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

// ─── Analysis Panel components ────────────────────────────────────────────────

const ANALYSIS_TICKERS = [
  "LMT","RTX","NOC","GD","BA",
  "HII","LHX","LDOS","SAIC","BAH",
  "PLTR","KTOS","AVAV","CACI","MANT",
  "MSFT","AMZN","GOOGL","ORCL",
];

const THEME_COLORS = {
  contract:    "#ff9900",
  earnings:    "#00aaff",
  geopolitical:"#ff3355",
  technology:  "#00ff88",
  regulatory:  "#aa44ff",
  "m&a":       "#ffdd44",
};

function ThemeTag({ theme }) {
  const color = THEME_COLORS[theme] || "#555";
  return (
    <span style={{ fontSize:8, color, background:`${color}15`, border:`1px solid ${color}33`, padding:"1px 6px", letterSpacing:"0.1em" }}>
      {theme.toUpperCase()}
    </span>
  );
}

function SentimentBar({ label, value, color }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div style={{ marginBottom:5 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
        <span style={{ fontSize:8, color:"#333", fontFamily:"monospace", letterSpacing:"0.1em" }}>{label}</span>
        <span style={{ fontSize:8, color, fontFamily:"monospace" }}>{pct}%</span>
      </div>
      <div style={{ height:2, background:"#111" }}>
        <div style={{ height:"100%", width:`${pct}%`, background:color, boxShadow:`0 0 4px ${color}88`, transition:"width 0.4s ease" }} />
      </div>
    </div>
  );
}

// Intelligence Matrix — sector-wide signal heatmap
function IntelligenceMatrix({ signals, trades, contracts }) {
  const tickerData = {};
  ANALYSIS_TICKERS.forEach(t => {
    const tickerSigs = signals.filter(s => s.ticker === t);
    const latest     = tickerSigs[0];
    const hasBoost   = contracts.some(c => c.ticker === t);
    tickerData[t] = {
      count:     tickerSigs.length,
      latest,
      hasBoost,
      price:     trades[t]?.price,
      alpha:     latest?.alpha_score ?? null,
      direction: latest?.direction   ?? "NEUTRAL",
    };
  });

  return (
    <div style={{ borderBottom:"1px solid #111" }}>
      <div style={{ padding:"7px 14px", background:"#0a0a0a", borderBottom:"1px solid #111", display:"flex", gap:10, alignItems:"center" }}>
        <span style={{ fontSize:9, color:"#00aaff", letterSpacing:"0.2em" }}>INTELLIGENCE MATRIX</span>
        <span style={{ fontSize:8, color:"#2a2a2a" }}>real-time per-ticker signal state · green=LONG · red=SHORT · amber=contract boost active</span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(88px,1fr))", gap:1, background:"#111", padding:1 }}>
        {ANALYSIS_TICKERS.map(t => {
          const d = tickerData[t];
          const color = d.direction === "LONG" ? "#00ff88" : d.direction === "SHORT" ? "#ff3355" : d.hasBoost ? "#ff9900" : "#252525";
          const bg    = d.direction === "LONG" ? "rgba(0,255,136,0.06)" : d.direction === "SHORT" ? "rgba(255,51,85,0.06)" : d.hasBoost ? "rgba(255,153,0,0.04)" : "#0a0a0a";
          return (
            <div key={t} style={{ background:bg, padding:"8px 10px", borderLeft:`2px solid ${color}`, transition:"background 0.6s ease" }}>
              <div style={{ fontSize:10, fontWeight:700, color: d.direction !== "NEUTRAL" ? color : d.hasBoost ? "#ff9900" : "#333", fontFamily:"monospace", letterSpacing:"0.08em" }}>{t}</div>
              {d.price != null && <div style={{ fontSize:9, color:"#2a2a2a", fontFamily:"monospace", marginTop:1 }}>${d.price.toFixed(0)}</div>}
              {d.alpha != null
                ? <div style={{ fontSize:8, color, marginTop:2 }}>α {d.alpha >= 0 ? "+" : ""}{d.alpha.toFixed(2)}</div>
                : <div style={{ fontSize:8, color:"#1a1a1a", marginTop:2 }}>no signal</div>
              }
              <div style={{ display:"flex", gap:4, marginTop:3, alignItems:"center" }}>
                {d.hasBoost && <span style={{ fontSize:7, color:"#ff9900" }}>⚡</span>}
                {d.count > 0 && <span style={{ fontSize:7, color:"#2a2a2a", fontFamily:"monospace" }}>{d.count}sig</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Signal Decomposition — step-by-step breakdown of how α was computed
function SignalDecomposition({ signal }) {
  if (!signal) return (
    <div style={{ padding:"20px 16px", color:"#1e1e1e", fontSize:10, fontFamily:"monospace", lineHeight:1.9 }}>
      <div>① TRIGGER: awaiting signal…</div>
      <div>② NER ENTITIES: —</div>
      <div>③ FINBERT SCORES: —</div>
      <div>④ ALPHA CALCULATION: —</div>
      <div>⑤ DECISION: —</div>
    </div>
  );

  const action   = getAction(signal.direction);
  const hasFull  = signal.finbert_positive != null && signal.finbert_positive > 0;

  return (
    <div style={{ padding:"14px 16px", overflowY:"auto", maxHeight:420 }}>

      {/* ① Trigger headline */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:8, color:"#333", letterSpacing:"0.12em", marginBottom:4 }}>① TRIGGER HEADLINE</div>
        <div style={{ fontSize:10, color:"#888", fontFamily:"monospace", lineHeight:1.5, borderLeft:"2px solid #1a1a1a", paddingLeft:8 }}>
          {signal.trigger_headline}
        </div>
        {signal.article_source && (
          <div style={{ fontSize:8, color:"#2a2a2a", marginTop:3, fontFamily:"monospace" }}>
            source: {signal.article_source}
          </div>
        )}
      </div>

      {/* ② NER entities */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:8, color:"#333", letterSpacing:"0.12em", marginBottom:4 }}>② NER ENTITIES EXTRACTED</div>
        {signal.entities?.length > 0 ? (
          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
            {signal.entities.map((e, i) => (
              <span key={i} style={{ fontSize:8, color:"#555", background:"#111", border:"1px solid #1e1e1e", padding:"1px 6px", fontFamily:"monospace" }}>
                {typeof e === "string" ? e : e.name}
              </span>
            ))}
          </div>
        ) : <span style={{ fontSize:8, color:"#2a2a2a", fontFamily:"monospace" }}>ticker resolved directly from feed</span>}
      </div>

      {/* ③ FinBERT scores */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:8, color:"#333", letterSpacing:"0.12em", marginBottom:6 }}>③ FINBERT SCORES (ProsusAI/finbert)</div>
        {hasFull ? (
          <>
            <SentimentBar label="POSITIVE" value={signal.finbert_positive} color="#00ff88" />
            <SentimentBar label="NEGATIVE" value={signal.finbert_negative} color="#ff3355" />
            <SentimentBar label="NEUTRAL"  value={signal.finbert_neutral}  color="#444"    />
            <div style={{ fontSize:8, color:"#2a2a2a", marginTop:4, fontFamily:"monospace" }}>
              model certainty: {Math.round((signal.nlp_confidence || 0) * 100)}%
            </div>
          </>
        ) : (
          <SentimentBar label="SENTIMENT SCALAR" value={Math.abs(signal.sentiment)} color={signal.sentiment >= 0 ? "#00ff88" : "#ff3355"} />
        )}
      </div>

      {/* ④ Alpha calculation */}
      <div style={{ marginBottom:12, padding:"8px 10px", background:"#0c0c0c", border:"1px solid #1a1a1a", fontFamily:"monospace" }}>
        <div style={{ fontSize:8, color:"#333", letterSpacing:"0.12em", marginBottom:6 }}>④ ALPHA CALCULATION</div>
        <div style={{ fontSize:9, color:"#444", lineHeight:2 }}>
          <div>sentiment  = <span style={{ color: signal.sentiment >= 0 ? "#00ff88" : "#ff3355" }}>{signal.sentiment >= 0 ? "+" : ""}{signal.sentiment.toFixed(4)}</span></div>
          <div>boost      = <span style={{ color:"#ff9900" }}>{signal.contract_boost.toFixed(2)}×</span> {signal.contract_boost <= 1.01 ? <span style={{ color:"#2a2a2a" }}>(no active contract)</span> : <span style={{ color:"#ff990066" }}>(DoD contract active)</span>}</div>
          <div style={{ borderTop:"1px solid #1a1a1a", marginTop:4, paddingTop:4 }}>
            α          = <span style={{ color:action.color, fontWeight:700, fontSize:11 }}>{signal.alpha_score >= 0 ? "+" : ""}{signal.alpha_score.toFixed(4)}</span>
          </div>
        </div>
      </div>

      {/* ⑤ Decision */}
      <div style={{ marginBottom:12, padding:"8px 10px", background:action.bg, border:`1px solid ${action.border}`, display:"flex", alignItems:"center", gap:10 }}>
        <span style={{ fontSize:16, color:action.color }}>{action.symbol}</span>
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:action.color, letterSpacing:"0.1em" }}>⑤ {action.label}</div>
          <div style={{ fontSize:8, color:`${action.color}88`, fontFamily:"monospace", marginTop:2 }}>
            {signal.ticker} · $1,000 PAPER · {signal.order_id ? `ORDER FILLED ✓ ${signal.order_id.slice(0,8)}…` : "PENDING / DRY RUN"}
          </div>
        </div>
      </div>

      {/* Narrative themes */}
      {signal.themes?.length > 0 && (
        <div>
          <div style={{ fontSize:8, color:"#333", letterSpacing:"0.12em", marginBottom:5 }}>NARRATIVE THEMES DETECTED</div>
          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
            {signal.themes.map((t, i) => <ThemeTag key={i} theme={t} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// Narrative Intelligence — regime, themes, velocity, top entities
function NarrativeIntelligence({ signals }) {
  const themeCounts  = {};
  const entityCounts = {};
  const velMap       = {};

  signals.forEach(s => {
    (s.themes   || []).forEach(t => { themeCounts[t]       = (themeCounts[t]       || 0) + 1; });
    (s.entities || []).forEach(e => {
      const n = typeof e === "string" ? e : e.name;
      if (n) entityCounts[n] = (entityCounts[n] || 0) + 1;
    });
    if (s.ticker) velMap[s.ticker] = (velMap[s.ticker] || 0) + 1;
  });

  const topThemes   = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topEntities = Object.entries(entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topTickers  = Object.entries(velMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxVel      = Math.max(...topTickers.map(([, v]) => v), 1);

  const avgAlpha = signals.length > 0
    ? signals.reduce((s, x) => s + x.alpha_score, 0) / signals.length
    : 0;
  const regime = avgAlpha > 0.08 ? { label:"RISK ON",  color:"#00ff88" }
               : avgAlpha < -0.08 ? { label:"RISK OFF", color:"#ff3355" }
               :                    { label:"NEUTRAL",  color:"#888" };

  return (
    <div style={{ padding:"14px 16px", overflowY:"auto", maxHeight:420 }}>
      <div style={{ fontSize:9, color:"#555", letterSpacing:"0.2em", marginBottom:12 }}>NARRATIVE INTELLIGENCE</div>

      {/* Regime */}
      <div style={{ marginBottom:14, padding:"8px 10px", background:"#0c0c0c", border:`1px solid ${regime.color}22` }}>
        <div style={{ fontSize:8, color:"#333", letterSpacing:"0.1em", marginBottom:5 }}>MARKET REGIME</div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ width:7, height:7, borderRadius:"50%", background:regime.color, boxShadow:`0 0 6px ${regime.color}` }} />
          <span style={{ fontSize:12, fontWeight:700, color:regime.color, fontFamily:"monospace" }}>{regime.label}</span>
          <span style={{ fontSize:9, color:"#333", marginLeft:"auto", fontFamily:"monospace" }}>
            avg α: {avgAlpha >= 0 ? "+" : ""}{avgAlpha.toFixed(3)}
          </span>
        </div>
      </div>

      {/* Dominant themes */}
      {topThemes.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:8, color:"#333", letterSpacing:"0.1em", marginBottom:6 }}>DOMINANT THEMES</div>
          {topThemes.map(([theme, count]) => (
            <div key={theme} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
              <ThemeTag theme={theme} />
              <div style={{ flex:1, height:2, background:"#111" }}>
                <div style={{ height:"100%", width:`${(count / topThemes[0][1]) * 100}%`, background: THEME_COLORS[theme] || "#333", opacity:0.4 }} />
              </div>
              <span style={{ fontSize:8, color:"#2a2a2a", fontFamily:"monospace" }}>{count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Signal velocity per ticker */}
      {topTickers.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:8, color:"#333", letterSpacing:"0.1em", marginBottom:6 }}>SIGNAL VELOCITY (this session)</div>
          {topTickers.map(([ticker, count]) => (
            <div key={ticker} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
              <span style={{ fontSize:8, color:"#555", fontFamily:"monospace", width:34 }}>{ticker}</span>
              <div style={{ flex:1, height:2, background:"#111" }}>
                <div style={{ height:"100%", width:`${(count / maxVel) * 100}%`, background:"#00ff8855" }} />
              </div>
              <span style={{ fontSize:8, color:"#2a2a2a", fontFamily:"monospace" }}>{count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Top entities */}
      {topEntities.length > 0 && (
        <div>
          <div style={{ fontSize:8, color:"#333", letterSpacing:"0.1em", marginBottom:5 }}>TOP ENTITIES MENTIONED</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
            {topEntities.map(([name, count]) => (
              <span key={name} style={{ fontSize:8, color:"#444", background:"#111", border:"1px solid #1a1a1a", padding:"1px 6px", fontFamily:"monospace" }}>
                {name.slice(0, 18)} ({count})
              </span>
            ))}
          </div>
        </div>
      )}

      {signals.length === 0 && (
        <div style={{ color:"#1e1e1e", fontSize:10, fontFamily:"monospace" }}>analysis populates as signals arrive…</div>
      )}
    </div>
  );
}

// Alpha Distribution — histogram + session stats
function AlphaDistribution({ signals }) {
  const bins   = [-1.5, -1.0, -0.75, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5];
  const counts = new Array(bins.length - 1).fill(0);

  signals.forEach(s => {
    for (let i = 0; i < bins.length - 1; i++) {
      if (s.alpha_score >= bins[i] && s.alpha_score < bins[i + 1]) { counts[i]++; break; }
    }
  });

  const maxCount = Math.max(...counts, 1);
  const alphas   = signals.map(s => s.alpha_score).sort((a, b) => a - b);
  const mean     = alphas.length ? alphas.reduce((s, a) => s + a, 0) / alphas.length : 0;
  const median   = alphas.length ? alphas[Math.floor(alphas.length / 2)] : 0;
  const positive = signals.filter(s => s.alpha_score > 0.1).length;
  const negative = signals.filter(s => s.alpha_score < -0.1).length;
  const neutral  = signals.filter(s => Math.abs(s.alpha_score) <= 0.1).length;

  return (
    <div style={{ padding:"14px 16px", overflowY:"auto", maxHeight:420 }}>
      <div style={{ fontSize:9, color:"#555", letterSpacing:"0.2em", marginBottom:12 }}>ALPHA DISTRIBUTION</div>

      {signals.length > 0 ? (
        <>
          {/* Histogram */}
          <div style={{ display:"flex", alignItems:"flex-end", gap:1, height:64, marginBottom:4 }}>
            {counts.map((count, i) => {
              const mid   = (bins[i] + bins[i + 1]) / 2;
              const color = mid > 0.1 ? `rgba(0,255,136,${0.25 + 0.75 * (count / maxCount)})`
                          : mid < -0.1 ? `rgba(255,51,85,${0.25 + 0.75 * (count / maxCount)})`
                          : `rgba(100,100,100,${0.2 + 0.4 * (count / maxCount)})`;
              const h = count > 0 ? Math.max((count / maxCount) * 60, 3) : 0;
              return <div key={i} style={{ flex:1, background:color, height:h, alignSelf:"flex-end", transition:"height 0.5s ease" }} />;
            })}
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, color:"#2a2a2a", fontFamily:"monospace", marginBottom:12 }}>
            <span>-1.5</span><span>-0.5</span><span>0</span><span>+0.5</span><span>+1.5</span>
          </div>

          {/* Stats grid */}
          <div style={{ padding:"8px 10px", background:"#0c0c0c", fontFamily:"monospace", fontSize:9, marginBottom:10 }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:6 }}>
              <div style={{ color:"#444" }}>mean   <span style={{ color: mean >= 0 ? "#00ff88" : "#ff3355" }}>{mean >= 0 ? "+" : ""}{mean.toFixed(3)}</span></div>
              <div style={{ color:"#444" }}>median <span style={{ color: median >= 0 ? "#00ff88" : "#ff3355" }}>{median >= 0 ? "+" : ""}{median.toFixed(3)}</span></div>
              <div style={{ color:"#444" }}>long   <span style={{ color:"#00ff88" }}>{positive}</span></div>
              <div style={{ color:"#444" }}>short  <span style={{ color:"#ff3355" }}>{negative}</span></div>
            </div>
            {/* Bias bar */}
            <div style={{ borderTop:"1px solid #1a1a1a", paddingTop:6 }}>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:8, color:"#333", width:28 }}>bias</span>
                <div style={{ flex:1, height:2, background:"#1a1a1a", position:"relative" }}>
                  <div style={{
                    position:"absolute", top:0, height:"100%",
                    background: mean >= 0 ? "#00ff88" : "#ff3355",
                    width:`${Math.min(Math.abs(mean) * 70, 50)}%`,
                    left: mean >= 0 ? "50%" : `${50 - Math.min(Math.abs(mean) * 70, 50)}%`,
                  }} />
                  <div style={{ position:"absolute", top:-3, left:"calc(50% - 1px)", width:1, height:8, background:"#333" }} />
                </div>
                <span style={{ fontSize:8, color: mean >= 0 ? "#00ff88" : "#ff3355", width:42 }}>{mean >= 0 ? "BULLISH" : "BEARISH"}</span>
              </div>
            </div>
          </div>

          <div style={{ fontSize:8, color:"#2a2a2a", lineHeight:1.9, fontFamily:"monospace" }}>
            <div>total signals: {signals.length}</div>
            <div>long / neutral / short: {positive} / {neutral} / {negative}</div>
            <div>win rate: {signals.length ? Math.round((positive / signals.length) * 100) : 0}% bullish</div>
          </div>
        </>
      ) : (
        <div style={{ color:"#1e1e1e", fontSize:10, fontFamily:"monospace" }}>awaiting signals…</div>
      )}
    </div>
  );
}

// ─── Full Analysis Panel ──────────────────────────────────────────────────────

function AnalysisPanel({ signals, contracts, trades, selectedSignal }) {
  const displaySignal = selectedSignal || signals[0] || null;

  return (
    <div style={{ borderTop:"2px solid #141414", background:"#060606" }}>
      {/* Panel header */}
      <div style={{ padding:"9px 16px", background:"#0a0a0a", borderBottom:"1px solid #111", display:"flex", alignItems:"center", gap:12 }}>
        <span style={{ fontSize:10, color:"#00aaff", letterSpacing:"0.25em", fontWeight:700 }}>◈ DEEP ANALYSIS</span>
        <span style={{ fontSize:8, color:"#2a2a2a" }}>multi-factor decomposition · FinBERT breakdown · narrative regime · alpha distribution</span>
        {signals.length > 0 && (
          <span style={{ marginLeft:"auto", fontSize:8, color:"#2a2a2a", fontFamily:"monospace" }}>
            {signals.length} signal{signals.length !== 1 ? "s" : ""} analysed this session
          </span>
        )}
      </div>

      {/* Intelligence Matrix — full width */}
      <IntelligenceMatrix signals={signals} trades={trades} contracts={contracts} />

      {/* Three-column deep analysis */}
      <div style={{ display:"grid", gridTemplateColumns:"2fr 1.2fr 1fr", gap:1, background:"#111" }}>

        {/* Signal Decomposition */}
        <div style={{ background:"#080808" }}>
          <div style={{ padding:"7px 14px", background:"rgba(0,170,255,0.03)", borderBottom:"1px solid #111", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:9, color:"#00aaff", letterSpacing:"0.15em" }}>SIGNAL DECOMPOSITION</span>
            {signals.length > 1 && <span style={{ fontSize:7, color:"#2a2a2a" }}>showing most recent · click signal cards to inspect any</span>}
          </div>
          <SignalDecomposition signal={displaySignal} />
        </div>

        {/* Narrative Intelligence */}
        <div style={{ background:"#080808", borderLeft:"1px solid #0e0e0e" }}>
          <div style={{ padding:"7px 14px", background:"rgba(0,170,255,0.03)", borderBottom:"1px solid #111" }}>
            <span style={{ fontSize:9, color:"#00aaff", letterSpacing:"0.15em" }}>NARRATIVE INTELLIGENCE</span>
          </div>
          <NarrativeIntelligence signals={signals} />
        </div>

        {/* Alpha Distribution */}
        <div style={{ background:"#080808", borderLeft:"1px solid #0e0e0e" }}>
          <div style={{ padding:"7px 14px", background:"rgba(0,170,255,0.03)", borderBottom:"1px solid #111" }}>
            <span style={{ fontSize:9, color:"#00aaff", letterSpacing:"0.15em" }}>ALPHA DISTRIBUTION</span>
          </div>
          <AlphaDistribution signals={signals} />
        </div>
      </div>
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
        <div>· Threshold: |alpha| &gt; 0.10 to generate BUY/SHORT</div>
        <div>· Company news polled directly per ticker every 5min</div>
        <div>· Contract boosts amplify signals up to 3×</div>
      </div>
    </div>
  );
}

// ─── Dashboard (inner) ────────────────────────────────────────────────────────

function Dashboard() {
  const { signals, contracts, trades, latency, connected, refresh } = useSovereignWS("ws://localhost:9001/ws");
  const [selectedSignal, setSelectedSignal] = useState(null);

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
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <span style={{ fontSize:9, color:"#2a2a2a", fontFamily:"monospace" }}>
                FinBERT sentiment × contract boost — threshold |α|&gt;0.10
              </span>
              <button
                onClick={refresh}
                title="Reconnect WebSocket and replay last 200 signals from sovereign-core"
                style={{
                  background:"none", border:"1px solid #222", borderRadius:2, color:"#444",
                  fontFamily:"'JetBrains Mono',monospace", fontSize:9, padding:"3px 8px",
                  cursor:"pointer", letterSpacing:"0.1em", transition:"all 0.15s",
                }}
                onMouseEnter={e => { e.target.style.borderColor="#555"; e.target.style.color="#aaa"; }}
                onMouseLeave={e => { e.target.style.borderColor="#222"; e.target.style.color="#444"; }}
              >
                ↺ REFRESH STREAM
              </button>
            </div>
          </div>

          {/* Signal cards — click any card to inspect it in the Analysis panel */}
          <div style={{ flex:1, overflowY:"auto", maxHeight:"calc(100vh - 330px)" }}>
            {signals.length === 0
              ? <SignalEmptyState connected={connected} />
              : signals.map(s => (
                  <div key={s._id} onClick={() => setSelectedSignal(s)} style={{ cursor:"pointer" }}>
                    <SignalCard signal={s} />
                  </div>
                ))
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

      {/* ── Deep Analysis Panel — full width, below main grid ── */}
      <AnalysisPanel
        signals={signals}
        contracts={contracts}
        trades={trades}
        selectedSignal={selectedSignal}
      />
    </div>
  );
}

// ─── Root App — setup gate ────────────────────────────────────────────────────

export default function App() {
  const [setupDone, setSetupDone] = useState(null); // null=loading, false=needs setup, true=ready

  useEffect(() => {
    if (window.__TAURI__) {
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("is_setup_complete"))
        .then(ok => setSetupDone(ok))
        .catch(() => setSetupDone(true));
    } else {
      setSetupDone(isBrowserSetupComplete()); // browser — check localStorage
    }
  }, []);

  if (setupDone === null) return null;
  if (!setupDone) return <Setup onComplete={() => setSetupDone(true)} />;
  return <Dashboard />;
}
