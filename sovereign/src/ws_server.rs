use crate::types::Event;
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::Response,
    routing::get,
    Router,
};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

type Tx      = broadcast::Sender<Arc<Event>>;
pub type History = Arc<RwLock<VecDeque<Arc<Event>>>>;
type AppState = (Tx, History);

pub async fn run(addr: String, tx: Tx, history: History) {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "SOVEREIGN CORE OK" }))
        .layer(cors)
        .with_state((tx, history));

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("could not bind WS server");

    info!("WebSocket server listening on ws://{addr}/ws");
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State((tx, history)): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, tx, history))
}

async fn handle_socket(mut socket: WebSocket, tx: Tx, history: History) {
    info!("dashboard client connected");

    // Replay recent history so the client sees signals immediately on connect
    {
        let h = history.read().await;
        for event in h.iter() {
            if let Ok(json) = serde_json::to_string(&**event) {
                if socket.send(Message::Text(json)).await.is_err() {
                    return;
                }
            }
        }
        info!("replayed {} historical events to new client", h.len());
    }

    let mut rx = tx.subscribe();

    loop {
        tokio::select! {
            Ok(event) = rx.recv() => {
                match serde_json::to_string(&*event) {
                    Ok(json) => {
                        if socket.send(Message::Text(json)).await.is_err() {
                            break; // client disconnected
                        }
                    }
                    Err(e) => tracing::error!("serialize error: {e}"),
                }
            }
            Some(Ok(Message::Close(_))) = socket.recv() => {
                info!("dashboard client disconnected");
                break;
            }
            else => break,
        }
    }
}
