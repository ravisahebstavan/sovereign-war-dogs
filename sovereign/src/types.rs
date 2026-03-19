use serde::{Deserialize, Serialize};

/// Every message flowing through the pipeline is wrapped in this envelope.
/// The dual timestamps let us measure exact ingestion→bus latency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    /// Nanoseconds since UNIX epoch — captured the instant we receive the raw bytes
    pub ingested_ns: u64,
    /// Nanoseconds since UNIX epoch — captured just before Redis XADD
    pub routed_ns: u64,
    pub payload: Payload,
}

impl Event {
    /// Ingestion → routing latency in microseconds
    pub fn latency_us(&self) -> u64 {
        self.routed_ns.saturating_sub(self.ingested_ns) / 1_000
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Payload {
    News(NewsItem),
    Trade(TradeItem),
    Signal(SignalItem),
    Contract(ContractItem),
    Heartbeat { ts_ns: u64 },
    LatencySnapshot(LatencySnapshot),
}

// ─── Finnhub news payload ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsItem {
    pub article_id: String,
    pub headline: String,
    pub summary: String,
    pub tickers: Vec<String>,
    pub source: String,
    pub url: String,
    pub published_unix: i64,
}

// ─── Finnhub trade tick ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeItem {
    pub ticker: String,
    pub price: f64,
    pub volume: f64,
    pub exchange_ts_ms: i64,
}

// ─── Signal produced by the Python NLP engine ────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalItem {
    pub ticker: String,
    pub direction: Direction,
    pub confidence: f32,
    pub sentiment: f32,
    pub contract_boost: f32,
    pub alpha_score: f32,
    pub rationale: String,
    pub trigger_headline: String,
    pub order_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Direction {
    Long,
    Short,
    Neutral,
}

// ─── SAM.gov contract award ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractItem {
    pub notice_id: String,
    pub title: String,
    pub awardee: String,
    pub ticker: Option<String>,
    pub usd_amount: f64,
    pub agency: String,
    pub award_date: String,
}

// ─── Latency report emitted every 5 seconds ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencySnapshot {
    pub samples: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub max_us: u64,
}
