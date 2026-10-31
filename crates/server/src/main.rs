use std::net::SocketAddr;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let port: u16 = std::env::var("FINITE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4100);
    // Serve the built frontend when a directory is given (desktop release, web deploy).
    let static_dir = std::env::var("FINITE_STATIC_DIR").ok();

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);

    axum::serve(listener, finite_server::app(static_dir.as_deref()))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}
