//! What the server's tests share, behind the `testing` feature, which only
//! this crate's tests turn on. [`crate::store::MemoryStore`] is the other
//! piece.
//!
//! Tests that need a browser or a database skip when there is none, and say
//! so on stderr. A CI job that must not skip sets `FINITE_REQUIRE_BROWSER` or
//! `FINITE_REQUIRE_POSTGRES`, and the skip becomes a failure.

use std::sync::Arc;

use axum::Router;
use tokio::{net::TcpListener, task::JoinHandle};

use crate::{
    cluster::{Cluster, Members},
    router,
};

/// Whether a result that reported `output` ran in a browser. `false` says the
/// test can't go on: `output` is the "no Chrome" error. With
/// `FINITE_REQUIRE_BROWSER` set, that fails the test instead.
pub fn require_browser(output: &str) -> bool {
    if !output.contains("no Chrome") {
        return true;
    }
    assert!(
        std::env::var_os("FINITE_REQUIRE_BROWSER").is_none(),
        "FINITE_REQUIRE_BROWSER is set but there is no browser: {output}"
    );
    eprintln!("SKIPPED, NOTHING WAS TESTED: no Chrome, Chromium or Edge found (set FINITE_CHROME)");
    false
}

/// The database the tests use: `FINITE_TEST_DATABASE_URL`. `None` says the
/// test can't go on. With `FINITE_REQUIRE_POSTGRES` set, that fails the test
/// instead.
pub fn require_postgres() -> Option<String> {
    let url = std::env::var("FINITE_TEST_DATABASE_URL").ok();
    assert!(
        url.is_some() || std::env::var_os("FINITE_REQUIRE_POSTGRES").is_none(),
        "FINITE_REQUIRE_POSTGRES is set but FINITE_TEST_DATABASE_URL isn't"
    );
    if url.is_none() {
        eprintln!(
            "SKIPPED, NOTHING WAS TESTED: set FINITE_TEST_DATABASE_URL to run the tests that need Postgres"
        );
    }
    url
}

/// A listener on a free local port, and the `http://` URL it answers at.
/// Bind first and serve later when the servers need each other's URLs.
pub async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (listener, url)
}

/// Serves `app` on `listener` until the test ends.
pub fn serve(listener: TcpListener, app: Router) -> JoinHandle<()> {
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    })
}

/// A router in front of the servers at `nodes`, a fixed list.
pub fn front_for(nodes: Vec<String>) -> Router {
    router::app(
        Arc::new(Members::fixed(Cluster::observer(nodes))),
        router::Options::default(),
    )
}
