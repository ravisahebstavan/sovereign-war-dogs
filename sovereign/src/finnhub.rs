use crate::{redis_bus::RedisBus, types::*};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};
use uuid::Uuid;

const WATCHLIST: &[&str] = &[
    "LMT", "RTX", "NOC", "GD", "BA",
    "HII", "LHX", "LDOS", "SAIC", "BAH",
    "PLTR", "KTOS", "AVAV", "CACI", "MANT",
    "MSFT", "AMZN", "GOOGL", "ORCL",
];

#[derive(Deserialize)]
struct FinnhubQuote {
    c: Option<f64>,  // current price
    v: Option<f64>,  // volume
}

#[derive(Deserialize)]
struct FinnhubNewsItem {
    id: Option<i64>,
    headline: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    related: String,
    source: Option<String>,
    url: Option<String>,
    datetime: Option<i64>,
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

pub async fn run_news(api_key: String, bus: Arc<RedisBus>) {
    let client = reqwest::Client::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    info!("Finnhub news poller starting — polling every 30s");

    loop {
        let ingested = now_ns();
        let url = format!(
            "https://finnhub.io/api/v1/news?category=general&token={}",
            api_key
        );

        match client.get(&url).send().await {
            Ok(resp) => {
                if let Ok(items) = resp.json::<Vec<FinnhubNewsItem>>().await {
                    let mut count = 0;
                    for item in items.iter().take(20) {
                        let id = item.id.unwrap_or(0).to_string();
                        if seen_ids.contains(&id) { continue; }
                        seen_ids.insert(id.clone());

                        let tickers: Vec<String> = item.related
                            .split(',')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect();

                        let event = Event {
                            id: Uuid::new_v4().to_string(),
                            ingested_ns: ingested,
                            routed_ns: now_ns(),
                            payload: Payload::News(NewsItem {
                                article_id: id,
                                headline: item.headline.clone().unwrap_or_default(),
                                summary: item.summary.clone().unwrap_or_default(),
                                tickers,
                                source: item.source.clone().unwrap_or_default(),
                                url: item.url.clone().unwrap_or_default(),
                                published_unix: item.datetime.unwrap_or(0),
                            }),
                        };
                        bus.publish_news(event).await;
                        count += 1;
                    }
                    if count > 0 {
                        info!("fetched {} new articles", count);
                    }
                    // Keep seen_ids bounded
                    if seen_ids.len() > 5000 {
                        seen_ids.clear();
                    }
                }
            }
            Err(e) => error!("news fetch error: {e}"),
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
    }
}

pub async fn run_trades(api_key: String, bus: Arc<RedisBus>) {
    let client = reqwest::Client::new();
    info!("Finnhub quote poller starting — polling every 15s");

    loop {
        for ticker in WATCHLIST {
            let ingested = now_ns();
            let url = format!(
                "https://finnhub.io/api/v1/quote?symbol={}&token={}",
                ticker, api_key
            );

            match client.get(&url).send().await {
                Ok(resp) => {
                    if let Ok(quote) = resp.json::<FinnhubQuote>().await {
                        if let Some(price) = quote.c {
                            if price > 0.0 {
                                let event = Event {
                                    id: Uuid::new_v4().to_string(),
                                    ingested_ns: ingested,
                                    routed_ns: now_ns(),
                                    payload: Payload::Trade(TradeItem {
                                        ticker: ticker.to_string(),
                                        price,
                                        volume: quote.v.unwrap_or(0.0),
                                        exchange_ts_ms: ingested as i64 / 1_000_000,
                                    }),
                                };
                                bus.publish_trade(event).await;
                            }
                        }
                    }
                }
                Err(e) => error!("quote fetch error [{ticker}]: {e}"),
            }

            // 60 req/min free tier — space requests 1s apart
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
    }
}