//! How much memory a design costs while it isn't loaded: a server that
//! starts with 20,000 stored designs and opens none of them.
//!
//!     cargo run --release -p finite-server --example cold_designs
use std::sync::Arc;

use finite_design::{Design, DesignMeta};
use finite_server::{
    Hub,
    store::{MemoryStore, Store},
};

fn rss_kb() -> u64 {
    let pid = std::process::id().to_string();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

#[tokio::main]
async fn main() {
    let n = 20_000;
    let store = Arc::new(MemoryStore::default());
    for i in 0..n {
        let design = Design::new(DesignMeta {
            id: format!("design{i:05}"),
            name: format!("Design {i}"),
            created_at: 0,
            updated_at: 0,
        });
        store.save(&design.snapshot(), 0).unwrap();
    }
    let before = rss_kb();
    let hub = Hub::new(store).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let after = rss_kb();
    println!(
        "{} loaded, {} listed: {:.1} KB per cold design",
        hub.loaded(),
        hub.list().len(),
        (after - before) as f64 / n as f64
    );
}
