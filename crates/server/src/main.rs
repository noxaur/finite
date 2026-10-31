use std::{net::SocketAddr, sync::Arc};

use finite_server::{Hub, store::FileStore};
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
    // Designs are saved here as JSON files.
    let data_dir = std::env::var("FINITE_DATA_DIR").unwrap_or_else(|_| "data".into());

    let store = match FileStore::new(&data_dir) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("finite-server: {error}");
            std::process::exit(1);
        }
    };
    let hub = Hub::new(Arc::new(store))?;
    tracing::info!(data_dir, designs = hub.list().len(), "loaded designs");

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    tracing::info!("listening on http://{local} (MCP endpoint: http://{local}/mcp)");

    axum::serve(
        listener,
        finite_server::app(hub.clone(), static_dir.as_deref()),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    hub.flush();
    Ok(())
}
