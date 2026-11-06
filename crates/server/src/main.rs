use std::{net::SocketAddr, sync::Arc};

use finite_server::{
    Hub,
    cluster::{self, Cluster, Lease, Members},
    config::{Config, Database},
    router::Options,
    store::{FileStore, Registry, Store},
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let config = Config::from_env().unwrap_or_else(|error| fail(error));
    let port = config.port;
    // `finite-server router` runs the front door for the servers in
    // FINITE_NODES, or for the live ones in FINITE_DATABASE_URL.
    if std::env::args().nth(1).as_deref() == Some("router") {
        let members = match &config.database {
            Some(database) => {
                let (_, registry) = shared_store(database, "router", config.lease);
                let live = registry.live()?;
                let members = Arc::new(Members::fixed(Cluster::observer(live)));
                cluster::follow(members.clone(), registry, config.lease.every());
                members
            }
            None => {
                let Some(nodes) = config.nodes.clone().filter(|n| !n.is_empty()) else {
                    fail("the router needs FINITE_NODES or FINITE_DATABASE_URL");
                };
                Arc::new(Members::fixed(Cluster::observer(nodes)))
            }
        };
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
        tracing::info!(nodes = ?members.now().nodes(), "routing on http://{}", listener.local_addr()?);
        // With a shared FINITE_SESSION_DIR, any router can serve any MCP session.
        let sessions = match &config.session_dir {
            Some(dir) => Some(Arc::new(finite_server::relay::DirSessionStore::new(dir)?) as _),
            None => None,
        };
        let app = finite_server::router::app(
            members,
            Options {
                static_dir: config.static_dir.clone(),
                sessions,
                allowed_hosts: config.settings.allowed_hosts.clone(),
                ..Options::default()
            },
        );
        return axum::serve(listener, app)
            .with_graceful_shutdown(shutdown())
            .await;
    }
    let hub = match &config.database {
        // Designs are saved in Postgres, which every server shares.
        Some(database) => {
            if config.nodes.is_some() {
                fail(
                    "with FINITE_DATABASE_URL, the servers come from the database; unset FINITE_NODES",
                );
            }
            let me = &config.node_url;
            let (store, registry) = shared_store(database, me, config.lease);
            let hub = Hub::shared(store, registry, me, config.lease)?;
            tracing::info!(
                me,
                designs = hub.list().len(),
                lease = ?config.lease,
                "joined the servers sharing the database"
            );
            hub
        }
        // Designs are saved here as JSON files.
        None => {
            let store = FileStore::new(&config.data_dir).unwrap_or_else(|error| fail(error));
            let cluster = config.cluster().unwrap_or_else(|error| fail(error));
            let hub = Hub::with_cluster(Arc::new(store), cluster)?;
            tracing::info!(
                data_dir = config.data_dir,
                designs = hub.list().len(),
                "loaded designs"
            );
            hub
        }
    };
    hub.configure(config.settings.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    tracing::info!("listening on http://{local} (MCP endpoint: http://{local}/mcp)");

    axum::serve(
        listener,
        finite_server::app(hub.clone(), config.static_dir.as_deref()),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    // Saving talks to the store, which can block, so it runs off the async workers.
    let flushing = hub.clone();
    tokio::task::spawn_blocking(move || flushing.flush())
        .await
        .map_err(std::io::Error::other)?;
    tracing::info!("saved every open design; bye");
    Ok(())
}

/// The Postgres store in `database`, as the server at `me`: its designs, and
/// the heartbeats of the servers that share it.
#[cfg(feature = "postgres")]
fn shared_store(
    database: &Database,
    me: &str,
    lease: Lease,
) -> (Arc<dyn Store>, Arc<dyn Registry>) {
    let store = finite_server::postgres::PgStore::connect_in(
        &database.url,
        database.schema.as_deref(),
        me,
        lease.0,
    )
    .unwrap_or_else(|error| fail(format!("couldn't open the database: {error}")));
    let store = Arc::new(store);
    (store.clone(), store)
}

/// Without the `postgres` feature, there's no shared store to open. A
/// database URL that was set on purpose must not be ignored: the server would
/// start on its own folder, and its designs would never reach the others.
#[cfg(not(feature = "postgres"))]
fn shared_store(_: &Database, _: &str, _: Lease) -> (Arc<dyn Store>, Arc<dyn Registry>) {
    fail(
        "FINITE_DATABASE_URL is set, but this finite-server was built without Postgres. \
         Build it with `cargo build -p finite-server --features postgres`, or unset FINITE_DATABASE_URL.",
    )
}

fn fail(error: impl std::fmt::Display) -> ! {
    eprintln!("finite-server: {error}");
    std::process::exit(1);
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
