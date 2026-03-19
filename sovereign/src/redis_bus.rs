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
pub async fn relay_python_events(
    redis_url: String,
    tx: broadcast::Sender<Arc<Event>>,
) {
    let client = match redis::Client::open(redis_url.as_str()) {
        Ok(c) => c,
        Err(e) => { error!("relay Redis client error: {e}"); return; }
    };
    let mut conn = match client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => { error!("relay Redis connect error: {e}"); return; }
    };

    info!("Python event relay started — watching {}", crate::REDIS_STREAM_EVENTS);

    let mut last_id = "0-0".to_string();

    loop {
        let results: redis::RedisResult<Vec<redis::Value>> = redis::cmd("XREAD")
            .arg("BLOCK")
            .arg(500u64)
            .arg("COUNT")
            .arg(100u64)
            .arg("STREAMS")
            .arg(crate::REDIS_STREAM_EVENTS)
            .arg(&last_id)
            .query_async(&mut conn)
            .await;

        match results {
            Err(e) => {
                error!("XREAD error: {e}");
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            }
            Ok(data) => {
                for stream_data in &data {
                    if let redis::Value::Bulk(streams) = stream_data {
                        for stream in streams {
                            if let redis::Value::Bulk(entries) = stream {
                                if entries.len() >= 2 {
                                    if let redis::Value::Bulk(messages) = &entries[1] {
                                        for msg in messages {
                                            if let redis::Value::Bulk(parts) = msg {
                                                if let (
                                                    redis::Value::Data(id_bytes),
                                                    redis::Value::Bulk(fields),
                                                ) = (&parts[0], &parts[1])
                                                {
                                                    last_id = String::from_utf8_lossy(id_bytes).to_string();
                                                    if fields.len() >= 2 {
                                                        if let redis::Value::Data(json_bytes) = &fields[1] {
                                                            if let Ok(event) = serde_json::from_slice::<Event>(json_bytes) {
                                                                let _ = tx.send(Arc::new(event));
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}