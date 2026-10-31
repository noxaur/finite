use std::{net::SocketAddr, sync::Arc};

use finite_server::{Hub, cluster::Cluster, store::FileStore};
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
    let cluster = match Cluster::from_env() {
        Ok(cluster) => cluster,
        Err(error) => {
            eprintln!("finite-server: {error}");
            std::process::exit(1);
        }
    };
    let hub = Hub::with_cluster(Arc::new(store), cluster)?;
    tracing::info!(data_dir, designs = hub.list().len(), "loaded designs");

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    tracing::info!("listening on http://{local} (MCP endpoint: http://{local}/mcp)");

    axum::serve(
        listener,
        finite_server::app(hub.clone(), static_dir.as_deref()),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    hub.flush();
    tracing::info!("saved every open design; bye");
    Ok(())
}

/// Resolves on Ctrl-C, or on SIGTERM, which is how process managers, Docker
/// and the desktop app stop the server. Either way, open designs are saved.
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
