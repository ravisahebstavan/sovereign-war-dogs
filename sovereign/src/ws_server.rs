use crate::types::Event;
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::Response,
    routing::get,
    Router,
};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

type Tx = broadcast::Sender<Arc<Event>>;

pub async fn run(addr: String, tx: Tx) {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "SOVEREIGN CORE OK" }))
        .layer(cors)
        .with_state(tx);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("could not bind WS server");

    info!("WebSocket server listening on ws://{addr}/ws");
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(tx): State<Tx>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, tx))
}

async fn handle_socket(mut socket: WebSocket, tx: Tx) {
    let mut rx = tx.subscribe();
    info!("dashboard client connected");

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
