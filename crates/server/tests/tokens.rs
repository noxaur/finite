//! The token tools, and old shared CSS moving into tokens when a design loads.

mod agent;

use std::sync::Arc;

use agent::{Agent, id_after, test_app};
use finite_design::{Design, DesignMeta, Op, edit::NewArtboard};
use finite_server::{
    Hub, app,
    store::{MemoryStore, Store},
};
use serde_json::{Value, json};

fn design_id(created: &str) -> String {
    created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned()
}

#[tokio::test]
async fn an_agent_sets_tokens_in_two_modes_and_undoes_them() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = design_id(&agent.ok("create_design", json!({ "name": "Flow" })).await);

    let saved = agent
        .ok(
            "set_tokens",
            json!({ "designId": design, "modes": ["Light", "Dark"],
                    "tokens": { "--brand": "#f97316", "--bg": { "Light": "#fff", "Dark": "#111" } } }),
        )
        .await;
    assert!(saved.contains("Saved 2 tokens"), "{saved}");
    assert!(saved.contains("in modes Light, Dark"), "{saved}");

    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Night", "width": 390, "height": 844, "mode": "dark",
                    "html": "<button style=\"background: var(--brand)\">Go</button>" }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    assert!(info.contains("\"tokenCount\": 2"), "{info}");
    assert!(info.contains("\"mode\": \"Dark\""), "{info}");

    // get_tokens reads back the way set_tokens takes them.
    let tokens: Value =
        serde_json::from_str(&agent.ok("get_tokens", json!({ "designId": design })).await).unwrap();
    assert_eq!(
        tokens,
        json!({
            "modes": ["Light", "Dark"],
            "tokens": { "--bg": { "Light": "#fff", "Dark": "#111" }, "--brand": "#f97316" },
            "artboardModes": { "Dark": [board] },
        })
    );

    // get_html says the artboard reads values it leaves out.
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(html.contains("2 tokens (get_tokens)"), "{html}");

    for (bad, why) in [
        (json!({ "--brand": "red; color: blue" }), "outside a string"),
        (json!({ "brand": "red" }), "start with --"),
        (
            json!({ "--brand": { "Sepia": "red" } }),
            "no mode \"Sepia\"",
        ),
    ] {
        let (error, failed) = agent
            .call("set_tokens", json!({ "designId": design, "tokens": bad }))
            .await;
        assert!(failed && error.contains(why), "{error}");
    }
    let (error, failed) = agent
        .call(
            "set_artboard_mode",
            json!({ "designId": design, "artboardIds": [board], "mode": "Sepia" }),
        )
        .await;
    assert!(
        failed && error.contains("its modes are Light, Dark"),
        "{error}"
    );

    // They're edits like any other, so undo takes them back.
    agent.ok("undo", json!({ "designId": design })).await;
    let undone = agent.ok("undo", json!({ "designId": design })).await;
    assert_eq!(undone, "Undid: Set tokens");
    let tokens: Value =
        serde_json::from_str(&agent.ok("get_tokens", json!({ "designId": design })).await).unwrap();
    assert_eq!(tokens, json!({ "modes": ["Default"], "tokens": {} }));
}

/// A design saved with shared CSS gets tokens the first time it loads, and
/// its artboards keep the rest of the CSS in their own `<style>`.
#[tokio::test]
async fn shared_css_becomes_tokens_when_a_design_loads() {
    let mut old = Design::new(DesignMeta {
        id: "oldcss0001".into(),
        name: "Old".into(),
        created_at: 0,
        updated_at: 0,
    });
    let spec = NewArtboard {
        name: "Home".into(),
        width: 100.0,
        height: Some(100.0),
        position: None,
        page: None,
        styles: Default::default(),
    };
    let mut ops = finite_design::edit::create_artboard(old.doc(), "home".into(), spec).unwrap();
    ops.push(Op::Css {
        css: Some(":root { --ink: #111 } .btn { color: var(--ink) }".into()),
    });
    old.commit("agent", "Old", &ops, 0).unwrap();
    let store = Arc::new(MemoryStore::default());
    store.save(&old.snapshot_to_save(), 0).unwrap();

    let app = app(Hub::new(store.clone()).unwrap(), None);
    let mut agent = Agent::connect(&app, "Alice").await;
    let tokens = agent
        .ok("get_tokens", json!({ "designId": "oldcss0001" }))
        .await;
    assert!(tokens.contains("\"--ink\": \"#111\""), "{tokens}");
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": "oldcss0001", "nodeId": "home" }),
        )
        .await;
    assert!(html.contains(".btn { color: var(--ink) }"), "{html}");
    // Nobody can undo back to the old CSS.
    assert_eq!(
        agent.ok("undo", json!({ "designId": "oldcss0001" })).await,
        "Nothing to undo."
    );
}
