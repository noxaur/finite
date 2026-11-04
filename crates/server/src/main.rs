use std::{net::SocketAddr, sync::Arc};

use finite_server::{
    Hub,
    cluster::{self, Cluster, Lease, Members},
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

    let port: u16 = std::env::var("FINITE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4100);
    // Serve the built frontend when a directory is given (desktop release, web deploy).
    let static_dir = std::env::var("FINITE_STATIC_DIR").ok();
    // With a shared store, servers find each other through its heartbeats.
    let database = std::env::var("FINITE_DATABASE_URL").ok();
    let schema = database_schema();
    let lease = Lease::from_env().unwrap_or_else(|error| fail(error));
    // `finite-server router` runs the front door for the servers in
    // FINITE_NODES, or for the live ones in FINITE_DATABASE_URL.
    if std::env::args().nth(1).as_deref() == Some("router") {
        let members = match &database {
            Some(url) => {
                let (_, registry) = shared_store(url, schema.as_deref(), "router", lease);
                let live = registry.live()?;
                let members = Arc::new(Members::fixed(Cluster::observer(live)));
                cluster::follow(members.clone(), registry, lease.every());
                members
            }
            None => {
                let Some(nodes) = Cluster::nodes_from_env().filter(|n| !n.is_empty()) else {
                    fail("the router needs FINITE_NODES or FINITE_DATABASE_URL");
                };
                Arc::new(Members::fixed(Cluster::observer(nodes)))
            }
        };
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
        tracing::info!(nodes = ?members.now().nodes(), "routing on http://{}", listener.local_addr()?);
        // With a shared FINITE_SESSION_DIR, any router can serve any MCP session.
        let sessions = match std::env::var("FINITE_SESSION_DIR") {
            Ok(dir) => Some(Arc::new(finite_server::relay::DirSessionStore::new(dir)?) as _),
            Err(_) => None,
        };
        let app = finite_server::router::app_with_members(members, static_dir.as_deref(), sessions);
        return axum::serve(listener, app)
            .with_graceful_shutdown(shutdown())
            .await;
    }
    let hub = match &database {
        // Designs are saved in Postgres, which every server shares.
        Some(url) => {
            if Cluster::nodes_from_env().is_some() {
                fail(
                    "with FINITE_DATABASE_URL, the servers come from the database; unset FINITE_NODES",
                );
            }
            // How the other servers and the router reach this one.
            let me = std::env::var("FINITE_NODE_URL")
                .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
            let me = me.trim_end_matches('/').to_owned();
            if !cluster::is_base_url(&me) {
                fail(format!(
                    "FINITE_NODE_URL must look like http://10.0.0.2:4100, not {me:?}"
                ));
            }
            let (store, registry) = shared_store(url, schema.as_deref(), &me, lease);
            let hub = Hub::shared(store, registry, &me, lease)?;
            tracing::info!(
                me,
                designs = hub.list().len(),
                ?lease,
                "joined the servers sharing the database"
            );
            hub
        }
        // Designs are saved here as JSON files.
        None => {
            let data_dir = std::env::var("FINITE_DATA_DIR").unwrap_or_else(|_| "data".into());
            let store = FileStore::new(&data_dir).unwrap_or_else(|error| fail(error));
            let cluster = Cluster::from_env().unwrap_or_else(|error| fail(error));
            let hub = Hub::with_cluster(Arc::new(store), cluster)?;
            tracing::info!(data_dir, designs = hub.list().len(), "loaded designs");
            hub
        }
    };

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
    // Saving talks to the store, which can block, so it runs off the async workers.
    let flushing = hub.clone();
    tokio::task::spawn_blocking(move || flushing.flush())
        .await
        .map_err(std::io::Error::other)?;
    tracing::info!("saved every open design; bye");
    Ok(())
}

/// The Postgres store at `url`, as the server at `me`: its designs, and the
/// heartbeats of the servers that share it.
#[cfg(feature = "postgres")]
fn shared_store(
    url: &str,
    schema: Option<&str>,
    me: &str,
    lease: Lease,
) -> (Arc<dyn Store>, Arc<dyn Registry>) {
    let store = finite_server::postgres::PgStore::connect_in(url, schema, me, lease.0)
        .unwrap_or_else(|error| fail(format!("couldn't open the database: {error}")));
    let store = Arc::new(store);
    (store.clone(), store)
}

/// Without the `postgres` feature, there's no shared store to open. A
/// database URL that was set on purpose must not be ignored: the server would
/// start on its own folder, and its designs would never reach the others.
#[cfg(not(feature = "postgres"))]
fn shared_store(
    _: &str,
    _: Option<&str>,
    _: &str,
    _: Lease,
) -> (Arc<dyn Store>, Arc<dyn Registry>) {
    fail(
        "FINITE_DATABASE_URL is set, but this finite-server was built without Postgres. \
         Build it with `cargo build -p finite-server --features postgres`, or unset FINITE_DATABASE_URL.",
    )
}

/// Where in the database Finite keeps its tables, if not the default schema:
/// `FINITE_DATABASE_SCHEMA`. It's for development, so each test run, like
/// `vp run e2e:shared`, gets empty tables in one shared database. A release
/// build refuses it rather than ignore it, which would quietly put a
/// deployment's tables somewhere else than its operator meant.
fn database_schema() -> Option<String> {
    let schema = std::env::var("FINITE_DATABASE_SCHEMA").ok()?;
    if !cfg!(debug_assertions) {
        fail("FINITE_DATABASE_SCHEMA is only for development builds; unset it");
    }
    Some(schema)
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
