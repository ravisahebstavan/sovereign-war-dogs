import { useState, useEffect, useCallback } from "react";

const IS_TAURI = Boolean(window.__TAURI__);
const LS_KEY   = "sovereign_config";

// ─── Storage helpers ─────────────────────────────────────────────────────────

export function isBrowserSetupComplete() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const cfg = JSON.parse(raw);
    return Boolean(cfg.finnhubKey && cfg.alpacaKey && cfg.alpacaSecret);
  } catch { return false; }
}

async function tauriInvoke(cmd, args = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ─── Shared styles ───────────────────────────────────────────────────────────

const mono = "'JetBrains Mono', 'Fira Code', monospace";

// ─── Small components ────────────────────────────────────────────────────────

function StatusDot({ state }) {
  const cfg = {
    checking: { color: "#555",    glow: "#555",    label: "CHECKING…" },
    ok:       { color: "#00ff88", glow: "#00ff88", label: "OK"        },
    fail:     { color: "#ff3355", glow: "#ff3355", label: "NOT FOUND" },
  }[state] || { color: "#555", glow: "#555", label: "—" };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        display: "inline-block", width: 7, height: 7, borderRadius: "50%",
        background: cfg.color,
        boxShadow: state !== "checking" ? `0 0 6px ${cfg.glow}` : "none",
        animation: state === "checking" ? "pulse 1.2s infinite" : "none",
      }} />
      <span style={{ color: cfg.color, fontSize: 10, letterSpacing: "0.1em" }}>{cfg.label}</span>
    </span>
  );
}

function Pill({ children, href }) {
  return (
    <a
      href={href} target="_blank" rel="noreferrer"
      style={{
        display: "inline-block",
        padding: "3px 10px",
        border: "1px solid #222",
        borderRadius: 2,
        fontSize: 10,
        color: "#555",
        textDecoration: "none",
        letterSpacing: "0.08em",
        transition: "all 0.15s",
      }}
      onMouseEnter={e => { e.target.style.borderColor = "#444"; e.target.style.color = "#aaa"; }}
      onMouseLeave={e => { e.target.style.borderColor = "#222"; e.target.style.color = "#555"; }}
    >
      {children} ↗
    </a>
  );
}

function SecretInput({ value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        style={{
          width: "100%", background: "#0d0d0d", border: "1px solid #222",
          borderRadius: 3, padding: "11px 44px 11px 14px",
          color: "#e0e0e0", fontFamily: mono, fontSize: 13, outline: "none",
          boxSizing: "border-box", transition: "border-color 0.15s",
        }}
        onFocus={e => e.target.style.borderColor = "#333"}
        onBlur={e => e.target.style.borderColor = "#222"}
      />
      <button onClick={() => setShow(s => !s)} style={{
        position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
        background: "none", border: "none", cursor: "pointer", color: "#444", fontSize: 10,
      }}>
        {show ? "HIDE" : "SHOW"}
      </button>
    </div>
  );
}

function PlainInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      style={{
        width: "100%", background: "#0d0d0d", border: "1px solid #222",
        borderRadius: 3, padding: "11px 14px",
        color: "#e0e0e0", fontFamily: mono, fontSize: 13, outline: "none",
        boxSizing: "border-box", transition: "border-color 0.15s",
      }}
      onFocus={e => e.target.style.borderColor = "#333"}
      onBlur={e => e.target.style.borderColor = "#222"}
    />
  );
}

function ActionBtn({ onClick, disabled, children, variant = "primary" }) {
  const active = variant === "primary"
    ? { bg: "rgba(0,255,136,0.08)", border: "rgba(0,255,136,0.35)", color: "#00ff88" }
    : { bg: "rgba(255,255,255,0.03)", border: "#222", color: "#555" };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%", padding: "13px", marginTop: 10,
        background: disabled ? "transparent" : active.bg,
        border: `1px solid ${disabled ? "#1a1a1a" : active.border}`,
        borderRadius: 3,
        color: disabled ? "#333" : active.color,
        fontFamily: mono, fontSize: 12, fontWeight: 700,
        letterSpacing: "0.18em", cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.2s",
      }}
      onMouseEnter={e => { if (!disabled) e.target.style.filter = "brightness(1.3)"; }}
      onMouseLeave={e => { e.target.style.filter = ""; }}
    >
      {children}
    </button>
  );
}

// ─── Step 1: Prerequisites ────────────────────────────────────────────────────

function StepPrereqs({ onNext }) {
  const [python, setPython] = useState({ state: "checking", version: "" });
  const [redis,  setRedis]  = useState({ state: "checking", port: 0 });
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState("");
  const [installErr, setInstallErr] = useState("");
  const [depsOk,     setDepsOk]     = useState(false);

  const runChecks = useCallback(async () => {
    setPython({ state: "checking", version: "" });
    setRedis({ state: "checking", port: 0 });

    if (IS_TAURI) {
      const [py, rd] = await Promise.all([
        tauriInvoke("check_python").catch(() => ({ ok: false, version: "" })),
        tauriInvoke("check_redis").catch(() => ({ ok: false, port: 0 })),
      ]);
      setPython({ state: py.ok ? "ok" : "fail", version: py.version });
      setRedis({ state: rd.ok ? "ok" : "fail", port: rd.port });
    } else {
      // Browser — can't check, assume user knows what they're doing
      setPython({ state: "ok", version: "detected via browser" });
      setRedis({ state: "ok", port: 6380 });
    }
  }, []);

  useEffect(() => { runChecks(); }, [runChecks]);

  async function handleInstallDeps() {
    setInstalling(true);
    setInstallLog("");
    setInstallErr("");   // clear previous error on every attempt
    try {
      const log = await tauriInvoke("install_python_deps");
      setInstallLog(log || "All packages installed successfully.");
      setDepsOk(true);
    } catch (e) {
      setInstallErr(String(e));
    } finally {
      setInstalling(false);
    }
  }

  const pyOk    = python.state === "ok";
  const redisOk = redis.state === "ok";
  const canNext = pyOk && redisOk;

  return (
    <div>
      <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em", marginBottom: 28 }}>
        STEP 1 OF 2 — PREREQUISITES
      </div>

      {/* Python */}
      <div style={{ marginBottom: 20, padding: "16px", background: "#0a0a0a", border: "1px solid #141414", borderRadius: 3 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#aaa", fontWeight: 700, letterSpacing: "0.12em" }}>PYTHON 3.11+</span>
          <StatusDot state={python.state} />
        </div>
        {python.version && <div style={{ fontSize: 10, color: "#444", marginBottom: 8 }}>{python.version}</div>}
        {python.state === "fail" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <span style={{ fontSize: 10, color: "#333" }}>Required to run the NLP pipeline.</span>
            <Pill href="https://www.python.org/downloads/">Download Python</Pill>
          </div>
        )}
        {pyOk && !depsOk && (
          <ActionBtn onClick={handleInstallDeps} disabled={installing} variant="secondary">
            {installing ? "INSTALLING PACKAGES… (may take a few minutes)" : "INSTALL PYTHON PACKAGES →"}
          </ActionBtn>
        )}
        {depsOk && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, color: "#00ff88" }}>✓ Python packages installed</div>
            <div style={{ marginTop: 8, padding: "10px 12px", background: "#0d0d0d", border: "1px solid #1a1400", borderRadius: 3, fontSize: 10, color: "#aa7700", lineHeight: 1.7 }}>
              ⚠ On first signal run, FinBERT (~400 MB) will auto-download. This takes 2–3 min. Signals will start flowing once the model is cached.
            </div>
          </div>
        )}
        {installErr && (
          <div style={{ marginTop: 10, fontSize: 10, color: "#ff3355", lineHeight: 1.6 }}>{installErr}</div>
        )}
        {installLog && !installErr && (
          <div style={{ marginTop: 10, maxHeight: 80, overflowY: "auto", fontSize: 9, color: "#333", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {installLog.slice(0, 400)}
          </div>
        )}
      </div>

      {/* Redis */}
      <div style={{ marginBottom: 28, padding: "16px", background: "#0a0a0a", border: "1px solid #141414", borderRadius: 3 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#aaa", fontWeight: 700, letterSpacing: "0.12em" }}>REDIS 5+</span>
          <StatusDot state={redis.state} />
        </div>
        {redis.state === "ok" && (
          <div style={{ fontSize: 10, color: "#444" }}>Running on port {redis.port}</div>
        )}
        {redis.state === "fail" && (
          <div>
            <div style={{ fontSize: 10, color: "#333", marginBottom: 10, lineHeight: 1.7 }}>
              Redis is not running. Download the Windows portable build,<br />
              extract it, and run <span style={{ color: "#555" }}>redis-server.exe --port 6380</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Pill href="https://github.com/tporadowski/redis/releases">Download Redis 5 (Windows)</Pill>
              <button onClick={runChecks} style={{
                background: "none", border: "1px solid #222", borderRadius: 2,
                color: "#444", fontFamily: mono, fontSize: 10, padding: "3px 10px", cursor: "pointer",
              }}>↺ RECHECK</button>
            </div>
          </div>
        )}
      </div>

      <ActionBtn onClick={onNext} disabled={!canNext}>
        {canNext ? "CONTINUE →" : "COMPLETE PREREQUISITES TO CONTINUE"}
      </ActionBtn>
    </div>
  );
}

// ─── Step 2: API Keys ─────────────────────────────────────────────────────────

function StepKeys({ onComplete }) {
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
      try {
        await tauriInvoke("activate", {
          finnhubKey: finnhub.trim(),
          alpacaKey: alpacaKey.trim(),
          alpacaSecret: alpacaSec.trim(),
        });
        onComplete();
      } catch (e) {
        setError(String(e));
        setLoading(false);
      }
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify({
        finnhubKey: finnhub.trim(),
        alpacaKey: alpacaKey.trim(),
        alpacaSecret: alpacaSec.trim(),
      }));
      setLoading(false);
      setBrowserDone(true);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em", marginBottom: 28 }}>
        STEP 2 OF 2 — API KEYS
      </div>

      <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em", marginBottom: 16 }}>MARKET DATA</div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#aaa", letterSpacing: "0.12em" }}>FINNHUB API KEY</label>
          <Pill href="https://finnhub.io/register">Get free key</Pill>
        </div>
        <SecretInput value={finnhub} onChange={setFinnhub} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxx" />
        <div style={{ marginTop: 5, fontSize: 10, color: "#2a2a2a" }}>Free tier — 60 calls/min. Live news and price feeds.</div>
      </div>

      <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em", marginBottom: 16, marginTop: 24 }}>PAPER TRADING — ALPACA MARKETS</div>

      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#aaa", letterSpacing: "0.12em" }}>ALPACA API KEY ID</label>
          <Pill href="https://app.alpaca.markets/signup">Get free paper account</Pill>
        </div>
        <PlainInput value={alpacaKey} onChange={setAlpacaKey} placeholder="PKXXXXXXXXXXXXXXXXXX" />
        <div style={{ marginTop: 5, fontSize: 10, color: "#2a2a2a" }}>Paper trading only — no real money.</div>
      </div>

      <div style={{ marginBottom: 28 }}>
        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#aaa", letterSpacing: "0.12em", marginBottom: 7 }}>ALPACA SECRET KEY</label>
        <SecretInput value={alpacaSec} onChange={setAlpacaSec} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "10px 14px", background: "rgba(255,51,85,0.06)", border: "1px solid rgba(255,51,85,0.2)", borderRadius: 3, fontSize: 11, color: "#ff3355", lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {browserDone ? (
        <>
          <div style={{ padding: "16px 18px", background: "rgba(0,255,136,0.03)", border: "1px solid #1a2a1a", borderRadius: 3, fontSize: 10, color: "#444", lineHeight: 2, marginBottom: 16 }}>
            <div style={{ color: "#2a4a2a", fontWeight: 700, letterSpacing: "0.15em", marginBottom: 8 }}>NEXT — START THE BACKEND</div>
            <div>1. Copy your keys into <span style={{ color: "#555" }}>signal/.env</span></div>
            <div>2. Run <span style={{ color: "#555" }}>start_sovereign.bat</span></div>
            <div>3. Reload this page — signals will flow</div>
          </div>
          <ActionBtn onClick={onComplete}>OPEN DASHBOARD →</ActionBtn>
        </>
      ) : (
        <ActionBtn onClick={handleLaunch} disabled={!canSubmit}>
          {loading ? "LAUNCHING…" : IS_TAURI ? "LAUNCH SOVEREIGN →" : "SAVE KEYS →"}
        </ActionBtn>
      )}

      <div style={{ marginTop: 28, textAlign: "center", fontSize: 10, color: "#1a1a1a", lineHeight: 1.8 }}>
        Keys stored {IS_TAURI ? "in your local app config folder" : "in browser localStorage"}.<br />
        Nothing is transmitted to any server.
      </div>
    </div>
  );
}

// ─── Root Setup wizard ────────────────────────────────────────────────────────

export default function Setup({ onComplete }) {
  const [step, setStep] = useState(IS_TAURI ? 0 : 1); // browser skips prereqs check

  return (
    <div style={{
      minHeight: "100vh", background: "#080808", color: "#e0e0e0",
      fontFamily: mono, display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080808; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
        input::placeholder { color: #2a2a2a; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
      `}</style>

      <div style={{ width: "100%", maxWidth: 520, padding: "0 24px" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 800, letterSpacing: "0.3em", color: "#f0f0f0", marginBottom: 8 }}>
            SOVEREIGN
          </div>
          <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: "0.2em" }}>GEOPOLITICAL ALPHA PIPELINE</div>
          <div style={{ marginTop: 20, fontSize: 11, color: "#444", lineHeight: 1.7 }}>
            One-time setup to activate your pipeline.<br />
            Everything runs locally on your machine.
          </div>
        </div>

        <div style={{ borderTop: "1px solid #141414", marginBottom: 36 }} />

        {step === 0 && <StepPrereqs onNext={() => setStep(1)} />}
        {step === 1 && <StepKeys onComplete={onComplete} />}

      </div>
    </div>
  );
}
