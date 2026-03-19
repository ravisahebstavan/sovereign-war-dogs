mod finnhub;
mod redis_bus;
mod types;
mod ws_server;

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::info;
use tracing_subscriber::EnvFilter;

pub const REDIS_STREAM_NEWS:     &str = "sovereign:news";
pub const REDIS_STREAM_TRADES:   &str = "sovereign:trades";
pub const REDIS_STREAM_EVENTS:   &str = "sovereign:events";
pub const WS_BROADCAST_CAPACITY: usize = 8192;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("sovereign_core=debug".parse()?)
                .add_directive("tower_http=warn".parse()?),
        )
        .init();

    let finnhub_key = std::env::var("FINNHUB_API_KEY")
        .expect("FINNHUB_API_KEY not set — get a free key at finnhub.io");
    let redis_url = std::env::var("REDIS_URL")
        .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());

    info!("SOVEREIGN CORE starting — connecting to Redis at {redis_url}");

    let (tx, _) = broadcast::channel::<Arc<types::Event>>(WS_BROADCAST_CAPACITY);

    let redis = redis::Client::open(redis_url.as_str())
        .expect("invalid Redis URL")
        .get_multiplexed_async_connection()
        .await
        .expect("could not connect to Redis — is redis-server running?");

    let bus = Arc::new(redis_bus::RedisBus::new(redis, tx.clone()));

    info!("pipeline stages spawning…");

    let bus1 = bus.clone();
    let bus2 = bus.clone();
    let tx1  = tx.clone();
    let tx2  = tx.clone();
    let tx3  = tx.clone();
    let ru   = redis_url.clone();

    tokio::select! {
        _ = tokio::spawn(finnhub::run_news(finnhub_key.clone(), bus1)) => {}
        _ = tokio::spawn(finnhub::run_trades(finnhub_key.clone(), bus2)) => {}
        _ = tokio::spawn(ws_server::run("0.0.0.0:9001".to_string(), tx1)) => {}
        _ = tokio::spawn(latency_monitor(tx2.subscribe(), bus.clone())) => {}
        _ = tokio::spawn(redis_bus::relay_python_events(ru, tx3)) => {}
    }

    Ok(())
}

async fn latency_monitor(
    mut rx: broadcast::Receiver<Arc<types::Event>>,
    bus: Arc<redis_bus::RedisBus>,
) {
    use types::{Event, Payload, LatencySnapshot};
    use std::time::{SystemTime, UNIX_EPOCH};
    use uuid::Uuid;

    let mut samples: Vec<u64> = Vec::with_capacity(10_000);
    let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(5));

    loop {
        tokio::select! {
            Ok(ev) = rx.recv() => {
                samples.push(ev.latency_us());
            }
            _ = ticker.tick() => {
                if samples.is_empty() { continue; }
                samples.sort_unstable();
                let n = samples.len();
                let snap = LatencySnapshot {
                    samples: n as u64,
                    p50_us:  samples[n * 50 / 100],
                    p95_us:  samples[n * 95 / 100],
                    p99_us:  samples[n * 99 / 100],
                    max_us:  *samples.last().unwrap(),
                };
                tracing::info!(
                    p50 = snap.p50_us,
                    p95 = snap.p95_us,
                    p99 = snap.p99_us,
                    max = snap.max_us,
                    samples = snap.samples,
                    "latency snapshot"
                );
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH).unwrap()
                    .as_nanos() as u64;
                let ev = Arc::new(Event {
                    id: Uuid::new_v4().to_string(),
                    ingested_ns: now,
                    routed_ns: now,
                    payload: Payload::LatencySnapshot(snap),
                });
                bus.publish_local(ev);
                samples.clear();
            }
        }
    }
}