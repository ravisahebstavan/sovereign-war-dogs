use crate::{redis_bus::RedisBus, types::*};
use serde::Deserialize;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};
use uuid::Uuid;

const WATCHLIST: &[&str] = &[
    "LMT", "RTX", "NOC", "GD", "BA",
    "HII", "LHX", "LDOS", "SAIC", "BAH",
    "PLTR", "KTOS", "AVAV", "CACI", "MANT",
    "MSFT", "AMZN", "GOOGL", "ORCL",
];

// ─── Bounded dedup set — evicts oldest entries in FIFO order ─────────────────
// Prevents the "clear entire set" bug that could re-process old articles.
struct BoundedSet {
    set:      HashSet<String>,
    order:    VecDeque<String>,
    capacity: usize,
}

impl BoundedSet {
    fn new(capacity: usize) -> Self {
        Self { set: HashSet::new(), order: VecDeque::new(), capacity }
    }
    fn contains(&self, id: &str) -> bool { self.set.contains(id) }
    fn insert(&mut self, id: String) {
        if self.set.len() >= self.capacity {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        self.order.push_back(id.clone());
        self.set.insert(id);
    }
}

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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    let mut seen_ids = BoundedSet::new(5_000);

    info!("Finnhub general news poller starting — polling every 30s");

    loop {
        let ingested = now_ns();
        let url = format!(
            "https://finnhub.io/api/v1/news?category=general&token={}",
            api_key
        );

        match client.get(&url).send().await {
            Ok(resp) => {
                if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    warn!("Finnhub rate limited (general news) — backing off 60s");
                    tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
                    continue;
                }
                if let Ok(items) = resp.json::<Vec<FinnhubNewsItem>>().await {
                    let mut count = 0;
                    for item in items.iter().take(20) {
                        let id = item.id.unwrap_or(0).to_string();
                        if seen_ids.contains(&id) { continue; }
                        seen_ids.insert(id.clone());

                        let headline = item.headline.clone().unwrap_or_default();
                        if headline.is_empty() { continue; }

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
                                headline,
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
                    if count > 0 { info!("general news: {} new articles", count); }
                }
            }
            Err(e) => error!("general news fetch error: {e}"),
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
    }
}

/// Company-specific news — polls each watchlist ticker's own news feed.
/// This is the PRIMARY signal source: guarantees we get news about our companies.
/// Finnhub free: 60 req/min. We poll 19 tickers with 2s spacing = ~10 req/min.
pub async fn run_company_news(api_key: String, bus: Arc<RedisBus>) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    let mut seen_ids = BoundedSet::new(10_000);

    info!("Company news poller starting — cycling all {} watchlist tickers every 5min", WATCHLIST.len());

    loop {
        let today     = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let yesterday = (chrono::Utc::now() - chrono::Duration::days(2)).format("%Y-%m-%d").to_string();

        for ticker in WATCHLIST {
            let ingested = now_ns();
            let url = format!(
                "https://finnhub.io/api/v1/company-news?symbol={}&from={}&to={}&token={}",
                ticker, yesterday, today, api_key
            );

            match client.get(&url).send().await {
                Ok(resp) => {
                    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                        warn!("Finnhub rate limited (company news) — backing off 60s");
                        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
                        break;
                    }
                    if resp.status().is_success() {
                        if let Ok(items) = resp.json::<Vec<FinnhubNewsItem>>().await {
                            let mut count = 0;
                            // Take only the 3 most recent articles per ticker
                            for item in items.iter().take(3) {
                                let raw_id = item.id.unwrap_or(0).to_string();
                                // Namespace ID by ticker so same article for different tickers
                                // is processed separately (each ticker needs its own signal)
                                let id = format!("{}-{}", ticker, raw_id);
                                if seen_ids.contains(&id) { continue; }

                                let headline = item.headline.clone().unwrap_or_default();
                                if headline.is_empty() { continue; }

                                seen_ids.insert(id);
                                let event = Event {
                                    id: Uuid::new_v4().to_string(),
                                    ingested_ns: ingested,
                                    routed_ns: now_ns(),
                                    payload: Payload::News(NewsItem {
                                        article_id: raw_id,
                                        headline,
                                        summary: item.summary.clone().unwrap_or_default(),
                                        // Explicitly tag with the ticker — no NER needed
                                        tickers: vec![ticker.to_string()],
                                        source: item.source.clone().unwrap_or_default(),
                                        url: item.url.clone().unwrap_or_default(),
                                        published_unix: item.datetime.unwrap_or(0),
                                    }),
                                };
                                bus.publish_news(event).await;
                                count += 1;
                            }
                            if count > 0 {
                                info!("company news: {} new articles for {}", count, ticker);
                            }
                        }
                    }
                }
                Err(e) => error!("company news fetch error [{ticker}]: {e}"),
            }

            // 2s between tickers — well within Finnhub's 60 req/min free limit
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }

        // Full cycle every 5 minutes
        tokio::time::sleep(tokio::time::Duration::from_secs(300)).await;
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
