import { useState } from "react";

const IS_TAURI = Boolean(window.__TAURI__);
const LS_KEY   = "sovereign_config";

// ─── Storage helpers ─────────────────────────────────────────────────────────

export function isBrowserSetupComplete() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const cfg = JSON.parse(raw);
    return Boolean(cfg.finnhubKey && cfg.alpacaKey && cfg.alpacaSecret);
  } catch {
    return false;
  }
}

// ─── Field component ─────────────────────────────────────────────────────────

function Field({ label, hint, linkLabel, linkHref, value, onChange, type = "text", placeholder }) {
  const [show, setShow] = useState(false);
  const isSecret = type === "password";

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: "#aaa", letterSpacing: "0.15em" }}>{label}</label>
        {linkLabel && (
          <a
            href={linkHref}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 10, color: "#555", textDecoration: "none", letterSpacing: "0.08em" }}
            onMouseEnter={e => e.target.style.color = "#00ff88"}
            onMouseLeave={e => e.target.style.color = "#555"}
          >
            {linkLabel} ↗
          </a>
        )}
      </div>
      <div style={{ position: "relative" }}>
        <input
          type={isSecret && !show ? "password" : "text"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          style={{
            width: "100%",
            background: "#0d0d0d",
            border: "1px solid #222",
            borderRadius: 3,
            padding: isSecret ? "11px 44px 11px 14px" : "11px 14px",
            color: "#e0e0e0",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            outline: "none",
            boxSizing: "border-box",
            transition: "border-color 0.15s",
          }}
          onFocus={e => e.target.style.borderColor = "#333"}
          onBlur={e => e.target.style.borderColor = "#222"}
        />
        {isSecret && (
          <button
            onClick={() => setShow(s => !s)}
            style={{
              position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer",
              color: "#444", fontSize: 12, padding: 0,
            }}
          >
            {show ? "HIDE" : "SHOW"}
          </button>
        )}
      </div>
      {hint && <div style={{ marginTop: 5, fontSize: 10, color: "#333", lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

// ─── Browser-mode next-steps panel ───────────────────────────────────────────

function BrowserInstructions() {
  return (
    <div style={{
      marginTop: 28,
      padding: "16px 18px",
      background: "rgba(0,255,136,0.03)",
      border: "1px solid #1a2a1a",
      borderRadius: 3,
      fontSize: 10,
      color: "#444",
      lineHeight: 2,
      letterSpacing: "0.04em",
    }}>
      <div style={{ color: "#2a4a2a", fontWeight: 700, letterSpacing: "0.15em", marginBottom: 8 }}>
        NEXT — START THE BACKEND
      </div>
      <div>1. Copy the keys above into your <span style={{ color: "#555" }}>signal/.env</span> file</div>
      <div>2. Run <span style={{ color: "#555" }}>start_sovereign.bat</span> to launch all services</div>
      <div>3. Reload this page — the dashboard will connect automatically</div>
    </div>
  );
}

// ─── Main Setup page ──────────────────────────────────────────────────────────

export default function Setup({ onComplete }) {
  const [finnhub,   setFinnhub]   = useState("");
  const [alpacaKey, setAlpacaKey] = useState("");
  const [alpacaSec, setAlpacaSec] = useState("");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [browserDone, setBrowserDone] = useState(false);

  const canSubmit = finnhub.trim() && alpacaKey.trim() && alpacaSec.trim() && !loading;

  async function handleLaunch() {
    if (!canSubmit) return;
    setLoading(true);
    setError("");

    if (IS_TAURI) {
      // ── Tauri: save keys to app config dir and spawn all services ──
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("activate", {
          finnhubKey:   finnhub.trim(),
          alpacaKey:    alpacaKey.trim(),
          alpacaSecret: alpacaSec.trim(),
        });
        onComplete();
      } catch (e) {
        setError(String(e));
        setLoading(false);
      }
    } else {
      // ── Browser: save keys to localStorage, show instructions ──
      localStorage.setItem(LS_KEY, JSON.stringify({
        finnhubKey:   finnhub.trim(),
        alpacaKey:    alpacaKey.trim(),
        alpacaSecret: alpacaSec.trim(),
      }));
      setLoading(false);
      setBrowserDone(true);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080808",
      color: "#e0e0e0",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080808; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
        input::placeholder { color: #2a2a2a; }
      `}</style>

      <div style={{ width: "100%", maxWidth: 500, padding: "0 24px" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 52 }}>
          <div style={{
            fontFamily: "'Syne', sans-serif",
            fontSize: 32,
            fontWeight: 800,
            letterSpacing: "0.3em",
            color: "#f0f0f0",
            marginBottom: 8,
          }}>
            SOVEREIGN
          </div>
          <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em" }}>
            GEOPOLITICAL ALPHA PIPELINE
          </div>
          <div style={{ marginTop: 24, fontSize: 11, color: "#444", lineHeight: 1.7, letterSpacing: "0.04em" }}>
            Enter your API keys to activate the pipeline.<br />
            Keys are stored locally — never transmitted anywhere.
          </div>
        </div>

        <div style={{ borderTop: "1px solid #141414", marginBottom: 36 }} />

        <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em", marginBottom: 24 }}>
          MARKET DATA
        </div>

        <Field
          label="FINNHUB API KEY"
          linkLabel="Get free key at finnhub.io"
          linkHref="https://finnhub.io/register"
          value={finnhub}
          onChange={setFinnhub}
          type="password"
          placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxx"
          hint="Free tier — 60 API calls/min. Live news and price feeds."
        />

        <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em", marginBottom: 24, marginTop: 12 }}>
          PAPER TRADING — ALPACA MARKETS
        </div>

        <Field
          label="ALPACA API KEY ID"
          linkLabel="Get free paper account at alpaca.markets"
          linkHref="https://app.alpaca.markets/signup"
          value={alpacaKey}
          onChange={setAlpacaKey}
          placeholder="PKXXXXXXXXXXXXXXXXXX"
          hint="Paper trading only — no real money. API Keys section in your Alpaca dashboard."
        />

        <Field
          label="ALPACA SECRET KEY"
          value={alpacaSec}
          onChange={setAlpacaSec}
          type="password"
          placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        />

        {error && (
          <div style={{
            marginBottom: 20,
            padding: "10px 14px",
            background: "rgba(255,51,85,0.06)",
            border: "1px solid rgba(255,51,85,0.2)",
            borderRadius: 3,
            fontSize: 11,
            color: "#ff3355",
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* Browser mode: show instructions after saving, with "Open Dashboard" */}
        {browserDone ? (
          <>
            <BrowserInstructions />
            <button
              onClick={onComplete}
              style={{
                width: "100%", padding: "14px", marginTop: 20,
                background: "rgba(0,255,136,0.08)",
                border: "1px solid rgba(0,255,136,0.35)",
                borderRadius: 3,
                color: "#00ff88",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12, fontWeight: 700, letterSpacing: "0.2em",
                cursor: "pointer",
              }}
            >
              OPEN DASHBOARD →
            </button>
          </>
        ) : (
          <button
            onClick={handleLaunch}
            disabled={!canSubmit}
            style={{
              width: "100%", padding: "14px", marginTop: 8,
              background: canSubmit ? "rgba(0,255,136,0.08)" : "transparent",
              border: `1px solid ${canSubmit ? "rgba(0,255,136,0.35)" : "#1a1a1a"}`,
              borderRadius: 3,
              color: canSubmit ? "#00ff88" : "#333",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, fontWeight: 700, letterSpacing: "0.2em",
              cursor: canSubmit ? "pointer" : "not-allowed",
              transition: "all 0.2s",
            }}
            onMouseEnter={e => { if (canSubmit) e.target.style.background = "rgba(0,255,136,0.14)"; }}
            onMouseLeave={e => { if (canSubmit) e.target.style.background = "rgba(0,255,136,0.08)"; }}
          >
            {loading ? "SAVING…" : IS_TAURI ? "LAUNCH SOVEREIGN →" : "SAVE KEYS →"}
          </button>
        )}

        <div style={{ marginTop: 32, textAlign: "center", fontSize: 10, color: "#1e1e1e", lineHeight: 1.8 }}>
          Keys stored {IS_TAURI ? "in your local app config folder" : "in browser localStorage"}.<br />
          Nothing is transmitted to any server.
        </div>

      </div>
    </div>
  );
}
