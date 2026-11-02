//! How long a server takes to start with many stored designs, each with an
//! artboard of a few dozen elements.
//!
//!     cargo run --release -p finite-server --example startup
use std::{collections::BTreeMap, sync::Arc, time::Instant};

use finite_design::{
    Design, DesignMeta,
    edit::{self, NewArtboard, WriteMode},
};
use finite_server::{
    Hub,
    store::{FileStore, Store},
};

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(5000);
    let dir = std::env::temp_dir().join(format!("finite-startup-{}", std::process::id()));
    {
        let store = FileStore::new(&dir).unwrap();
        let card = r#"<div data-name="Card" style="display:flex;gap:8px;padding:16px"><h3>Title</h3><p>Body text</p><button>Go</button></div>"#.repeat(10);
        for i in 0..n {
            let mut design = Design::new(DesignMeta {
                id: format!("design{i:06}"),
                name: format!("Design {i}"),
                created_at: 0,
                updated_at: 0,
            });
            let spec = NewArtboard {
                name: "Home".into(),
                width: 1440.0,
                height: 900.0,
                position: None,
                page: None,
                styles: BTreeMap::new(),
            };
            let ops = edit::create_artboard(design.doc(), "board".into(), spec).unwrap();
            design.commit("agent", "board", &ops, 1);
            let mut k = 0;
            let (ops, _) = edit::write_html(
                design.doc(),
                "board",
                &card,
                WriteMode::Append,
                None,
                &mut || {
                    k += 1;
                    format!("n{k}")
                },
            )
            .unwrap();
            design.commit("agent", "cards", &ops, 2);
            store.save(&design.snapshot_to_save(), 0).unwrap();
        }
    }
    let bytes: u64 = std::fs::read_dir(dir.join("designs"))
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _inside = runtime.enter();
    let start = Instant::now();
    let hub = Hub::new(Arc::new(FileStore::new(&dir).unwrap())).unwrap();
    let took = start.elapsed();
    println!(
        "{n} designs, {} MB on disk: started in {took:?} ({:.0} µs per design), {} listed",
        bytes >> 20,
        took.as_micros() as f64 / n as f64,
        hub.list().len()
    );
    drop(hub);
    std::fs::remove_dir_all(dir).unwrap();
}
