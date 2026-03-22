use crate::types::Event;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{error, info};

/// Wraps Redis multiplexed connection + internal broadcast sender.
/// All pipeline stages publish through here.
pub struct RedisBus {
    conn: tokio::sync::Mutex<redis::aio::MultiplexedConnection>,
    local_tx: broadcast::Sender<Arc<Event>>,
}

impl RedisBus {
    pub fn new(
        conn: redis::aio::MultiplexedConnection,
        local_tx: broadcast::Sender<Arc<Event>>,
    ) -> Self {
        Self {
            conn: tokio::sync::Mutex::new(conn),
            local_tx,
        }
    }

    /// Publish to both Redis Streams (for Python) and local broadcast (for WS server).
    async fn publish(&self, stream: &str, event: Event) {
        let ev = Arc::new(event);

        // Local broadcast first — zero-copy for WS server
        let _ = self.local_tx.send(ev.clone());

        // Serialize and push to Redis Stream
        let json = match serde_json::to_string(&*ev) {
            Ok(j) => j,
            Err(e) => { error!("serialize error: {e}"); return; }
        };

        let mut conn = self.conn.lock().await;
        let result: redis::RedisResult<String> = redis::cmd("XADD")
            .arg(stream)
            .arg("MAXLEN")
            .arg("~")
            .arg(10_000u64)
            .arg("*")
            .arg("data")
            .arg(&json)
            .query_async(&mut *conn)
            .await;

        if let Err(e) = result {
            error!("Redis XADD {stream} error: {e}");
        }
    }

    pub async fn publish_news(&self, event: Event) {
        self.publish(crate::REDIS_STREAM_NEWS, event).await;
    }

    pub async fn publish_trade(&self, event: Event) {
        self.publish(crate::REDIS_STREAM_TRADES, event).await;
    }

    /// Publish to local broadcast only (for latency snapshots etc)
    pub fn publish_local(&self, event: Arc<Event>) {
        let _ = self.local_tx.send(event);
    }
}

/// Read signals and contract events that Python writes to sovereign:events
/// and relay them into the local broadcast so the WS dashboard sees them.
///
/// Uses StreamReadReply — the typed API from the `streams` feature — instead of
/// manual redis::Value pattern matching, which was silently dropping every message
/// due to incorrect traversal of the nested XREAD response structure.
pub async fn relay_python_events(
    redis_url: String,
    tx: broadcast::Sender<Arc<Event>>,
) {
    use redis::streams::StreamReadReply;

    let client = match redis::Client::open(redis_url.as_str()) {
        Ok(c) => c,
        Err(e) => { error!("relay Redis client error: {e}"); return; }
    };
    let mut conn = match client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => { error!("relay Redis connect error: {e}"); return; }
    };

    info!("Python event relay started — watching {}", crate::REDIS_STREAM_EVENTS);

    // Start from the beginning so we pick up any signals written before this
    // function started (e.g. during the Python news_poller warm-up cycle).
    let mut last_id = "0-0".to_string();
    let mut relayed: u64 = 0;

    loop {
        // Use StreamReadReply — it handles the nested XREAD response structure
        // correctly and gives us typed access to each message's field map.
        let result: redis::RedisResult<StreamReadReply> = redis::cmd("XREAD")
            .arg("BLOCK")
            .arg(500u64)   // block up to 500 ms, then loop
            .arg("COUNT")
            .arg(100u64)
            .arg("STREAMS")
            .arg(crate::REDIS_STREAM_EVENTS)
            .arg(&last_id)
            .query_async(&mut conn)
            .await;

        match result {
            Err(e) => {
                error!("relay XREAD error: {e} — retrying in 1s");
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            }
            Ok(reply) => {
                for stream_key in reply.keys {
                    for entry in stream_key.ids {
                        last_id = entry.id.clone();

                        // Each Redis Stream entry has a "data" field containing
                        // the JSON-serialised Event written by Python engine.py.
                        if let Some(redis::Value::Data(json_bytes)) = entry.map.get("data") {
                            match serde_json::from_slice::<Event>(json_bytes) {
                                Ok(event) => {
                                    relayed += 1;
                                    if relayed <= 5 || relayed % 50 == 0 {
                                        info!(
                                            "relay: forwarded event #{relayed} id={} kind={:?}",
                                            last_id,
                                            std::mem::discriminant(&event.payload),
                                        );
                                    }
                                    let _ = tx.send(Arc::new(event));
                                }
                                Err(e) => {
                                    // Log the first 300 chars so we can diagnose schema mismatches
                                    error!(
                                        "relay: JSON parse error: {e} | raw={}",
                                        String::from_utf8_lossy(json_bytes)
                                            .chars().take(300).collect::<String>()
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
