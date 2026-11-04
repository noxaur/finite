//! The six-tool surface, served at `/mcp` by default, driven over MCP the way
//! an agent drives it: every tool, and every op of `edit`.

mod agent;

use std::{sync::Arc, time::Duration};

use agent::{Agent, id_after};
use axum::Router;
use finite_design::comment::{Anchor, Audience, Author, AuthorKind};
use finite_server::{Hub, app, store::MemoryStore};
use serde_json::{Value, json};

/// A server, whose `/mcp` serves the doc6 tools by default.
fn doc6() -> (Router, Arc<Hub>) {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    (app(hub.clone(), None), hub)
}

/// A new design's id.
async fn design(agent: &mut Agent, name: &str) -> String {
    let created = agent.ok("designs", json!({ "create": name })).await;
    created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned()
}

/// Runs `ops` as one edit without the layout check, which needs a browser.
async fn edit(agent: &mut Agent, design: &str, ops: Value) -> String {
    agent
        .ok(
            "edit",
            json!({ "designId": design, "ops": ops, "check": false }),
        )
        .await
}

/// The same, expecting the edit to fail.
async fn refused(agent: &mut Agent, design: &str, ops: Value) -> String {
    let (text, error) = agent
        .call(
            "edit",
            json!({ "designId": design, "ops": ops, "check": false }),
        )
        .await;
    assert!(error, "the edit should have failed: {text}");
    text
}

async fn html(agent: &mut Agent, design: &str, select: &str) -> String {
    agent
        .ok(
            "read",
            json!({ "designId": design, "select": select, "as": "html" }),
        )
        .await
}

/// A design with a 600 × 400 artboard holding a heading and two cards.
async fn landing(agent: &mut Agent) -> (String, String) {
    let id = design(agent, "Landing").await;
    let made = edit(
        agent,
        &id,
        json!([{ "op": "artboard", "name": "Home", "width": 600, "height": 400,
                 "html": "<h1 data-name=\"Title\" style=\"color: #3b82f6\">Hello</h1>\
                          <div class=\"card\" data-name=\"One\"><p>First</p></div>\
                          <div class=\"card\" data-name=\"Two\"><p>Second</p></div>" }]),
    )
    .await;
    (id, id_after(&made, "Created artboard"))
}

#[tokio::test]
async fn it_serves_exactly_six_tools_and_their_instructions() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Six").await;
    let tools = agent.rpc("tools/list", None).await;
    let mut names: Vec<&str> = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["comments", "designs", "edit", "read", "render", "undo"]
    );
    let mut fresh = Agent::connect_doc6(&app, "Fresh").await;
    let init = fresh
        .rpc(
            "initialize",
            Some(json!({ "protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": { "name": "test", "version": "1" } })),
        )
        .await;
    let text = init["instructions"].as_str().unwrap();
    assert!(text.contains("There are six tools"), "{text}");
    assert!(!text.contains("write_html"), "{text}");
}

#[tokio::test]
async fn scripts_keep_todays_tools_at_mcp_classic() {
    let (app, _) = doc6();
    let mut script = Agent::connect_at(&app, "Seeder", "/mcp/classic").await;
    let created = script
        .ok("create_design", json!({ "name": "Seeded" }))
        .await;
    assert!(created.contains("Next: create_artboard."), "{created}");
    let mut agent = Agent::connect_doc6(&app, "Six").await;
    let read = agent.ok("read", json!({ "designId": "Seeded" })).await;
    assert!(read.contains("No artboards yet"), "{read}");
}

#[tokio::test]
async fn designs_are_listed_created_renamed_and_deleted() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Lister").await;
    let id = design(&mut agent, "Acme site").await;
    assert!(
        agent
            .ok("designs", json!({ "query": "acme" }))
            .await
            .contains(&id)
    );
    let renamed = agent
        .ok("designs", json!({ "designId": id, "rename": "Acme home" }))
        .await;
    assert!(renamed.contains("Acme home"), "{renamed}");
    let deleted = agent.ok("designs", json!({ "delete": "acme HOME" })).await;
    assert!(deleted.contains("permanently"), "{deleted}");
    let (gone, error) = agent.call("read", json!({ "designId": id })).await;
    assert!(error, "{gone}");
}

/// in: "text" changes what people read and leaves links, ids and titles
/// alone, which a rename through a long article needs.
#[tokio::test]
async fn replace_in_text_leaves_attributes_alone() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Replacer").await;
    let id = design(&mut agent, "Article").await;
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Page", "width": 600,
                 "html": "<p>Every typeface <a href=\"/wiki/typeface_design\" title=\"typeface design\">typeface</a></p>" }]),
    )
    .await;
    let done = edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "typeface", "replace": "font", "in": "text" }]),
    )
    .await;
    assert!(done.contains("Replaced"), "{done}");
    let page = html(&mut agent, &id, "p").await;
    assert!(
        page.contains("Every font") && page.contains(">font</a>"),
        "{page}"
    );
    assert!(
        page.contains("href=\"/wiki/typeface_design\"")
            && page.contains("title=\"typeface design\""),
        "{page}"
    );
    let wrong = refused(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "a", "replace": "b", "in": "everywhere" }]),
    )
    .await;
    assert!(wrong.contains("isn't a place to replace in"), "{wrong}");
}

/// Deleting can't be undone, so the start of an id, which every other
/// tool accepts, isn't enough.
/// A copy is what x, y, page and mode place, not its original.
#[tokio::test]
async fn move_with_copy_places_the_copy() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Copier").await;
    let id = design(&mut agent, "Copies").await;
    let made = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Home", "width": 400, "height": 300, "x": 0, "y": 0 }]),
    )
    .await;
    let board = id_after(&made, "artboard");
    edit(
        &mut agent,
        &id,
        json!([{ "op": "move", "select": format!("#{board}"), "copy": true, "x": 2000, "y": 0 }]),
    )
    .await;
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains(&format!("#{board} (artboard at 0, 0)")),
        "the original stays: {overview}"
    );
    assert!(overview.contains("(artboard at 2000, 0)"), "{overview}");
}

#[tokio::test]
async fn delete_takes_only_an_exact_id_or_name() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Deleter").await;
    let id = design(&mut agent, "Keep me").await;
    let (refused, error) = agent.call("designs", json!({ "delete": &id[..6] })).await;
    assert!(
        error && refused.contains("nothing was deleted") && refused.contains(&id),
        "{refused}"
    );
    agent.ok("read", json!({ "designId": id })).await;
    let deleted = agent.ok("designs", json!({ "delete": id })).await;
    assert!(deleted.contains("permanently"), "{deleted}");
}

#[tokio::test]
async fn design_ids_take_a_name_or_the_start_of_an_id() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Namer").await;
    let id = design(&mut agent, "Checkout flow").await;
    for given in ["Checkout flow", "checkout FLOW", &id, &id[..6]] {
        let read = agent.ok("read", json!({ "designId": given })).await;
        assert!(
            read.contains(&format!("designId {id:?}")),
            "{given}: {read}"
        );
    }
    design(&mut agent, "Twin").await;
    design(&mut agent, "twin").await;
    let (twins, error) = agent.call("read", json!({ "designId": "Twin" })).await;
    assert!(error && twins.contains("several have it"), "{twins}");
    let (missing, error) = agent.call("read", json!({ "designId": "Checkout" })).await;
    assert!(
        error && missing.contains("Did you mean \"Checkout flow\""),
        "{missing}"
    );
}

#[tokio::test]
async fn read_shows_an_overview_outline_html_css_and_search() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Reader").await;
    let (id, board) = landing(&mut agent).await;
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains("1 artboard,") && overview.contains("\"Title\""),
        "{overview}"
    );
    let outline = agent
        .ok("read", json!({ "designId": id, "select": ".card" }))
        .await;
    assert!(
        outline.contains("<!-- 1 of 2") && outline.contains("\"Two\""),
        "{outline}"
    );
    let html = html(&mut agent, &id, "[data-name=One]").await;
    assert!(
        html.contains("data-read-at") && html.contains("<p data-id="),
        "{html}"
    );
    let found = agent
        .ok(
            "read",
            json!({ "designId": id, "contains": "rgb(59, 130, 246)" }),
        )
        .await;
    assert!(
        found.contains("In styles") && found.contains("\"Title\""),
        "{found}"
    );
    let inside = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ".card", "contains": "Second" }),
        )
        .await;
    assert!(inside.contains("In text: 1 element"), "{inside}");
    // States aren't elements, and the error says where they go.
    let (state, error) = agent
        .call("read", json!({ "designId": id, "select": ".card:hover" }))
        .await;
    assert!(
        error && state.contains("use a css op with to: \"style\""),
        "{state}"
    );
    let (nothing, error) = agent
        .call("read", json!({ "designId": id, "select": ".missing" }))
        .await;
    assert!(error && nothing.contains("matches no element"), "{nothing}");
    // The css view: inline styles, the rules that match, and what beats them.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "css": ".card { padding: 8px } h1 { color: red }", "to": "style" }]),
    )
    .await;
    let css = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "h1", "as": "css" }),
        )
        .await;
    assert!(
        css.contains("h1 { color: red }")
            && css.contains("Inline styles beat sheet rules for: color"),
        "{css}"
    );
    let sheet = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "style", "as": "css" }),
        )
        .await;
    assert!(sheet.contains("rule: .card { padding: 8px }"), "{sheet}");
    let sheets = agent
        .ok("read", json!({ "designId": id, "as": "css" }))
        .await;
    assert!(
        sheets.contains("no tokens") && sheets.contains("2 rules"),
        "{sheets}"
    );
    let _ = board;
}

#[tokio::test]
async fn every_op_runs_in_one_edit() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Builder").await;
    let (id, board) = landing(&mut agent).await;
    let text = edit(
        &mut agent,
        &id,
        json!([
            { "op": "html", "select": format!("#{board}"), "html": "<footer data-name=\"Footer\">Bye</footer>", "as": "f" },
            { "op": "html", "select": "@f", "mode": "before", "html": "<hr data-name=\"Rule\">" },
            { "op": "html", "select": "h1", "mode": "inner", "html": "Welcome" },
            { "op": "html", "select": ".card", "mode": "prepend", "html": "<span class=\"tag\">New</span>" },
            { "op": "css", "select": ".card", "css": "border-radius: 12px" },
            { "op": "css", "css": ".tag { color: green } .card:hover { opacity: 0.9 }", "to": "style" },
            { "op": "attrs", "select": "@f", "set": { "data-name": "Page footer", "role": "contentinfo" } },
            { "op": "move", "select": "[data-name=Two]", "to": "[data-name=One]", "position": "before" },
            { "op": "remove", "select": "[data-name=Rule]" },
            { "op": "replace", "find": "#3b82f6", "replace": "#f97316" },
            { "op": "page", "create": "Drafts", "as": "d" },
            { "op": "artboard", "name": "Draft", "width": 300, "page": "@d", "as": "b" },
            { "op": "move", "select": "[data-name=One]", "copy": true, "to": "@b", "as": "c" },
            { "op": "tokens", "set": { "--brand": "#f97316", "--bg": { "Light": "#ffffff", "Dark": "#000000" } }, "modes": ["Light", "Dark"] },
            { "op": "move", "select": "@b", "mode": "Dark" },
            { "op": "import", "name": "about.html", "content": "<html><body><h2>About</h2></body></html>", "page": "Drafts" },
        ]),
    )
    .await;
    assert!(
        text.starts_with("Changed the design in one step (16 ops)"),
        "{text}"
    );
    for section in 1..=16 {
        assert!(
            text.contains(&format!("\n{section}. ")),
            "section {section}: {text}"
        );
    }
    let page = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ":root", "as": "outline", "depth": 6 }),
        )
        .await;
    assert!(
        page.contains("\"Page footer\" #") && page.contains("\"Welcome\""),
        "{page}"
    );
    assert!(!page.contains("\"Rule\""), "{page}");
    let home = html(&mut agent, &id, &format!("#{board}")).await;
    let (two, one) = (home.find("\"Two\"").unwrap(), home.find("\"One\"").unwrap());
    assert!(two < one, "Two moved before One: {home}");
    assert!(
        home.contains("border-radius: 12px") && home.contains("#f97316"),
        "{home}"
    );
    assert!(
        home.contains(".tag { color: green }") && home.contains(":hover"),
        "{home}"
    );
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains("Pages: \"Page 1\"") && overview.contains("\"Drafts\""),
        "{overview}"
    );
    assert!(
        overview.contains("\"About\"") || overview.contains("About"),
        "{overview}"
    );
    let tokens = agent
        .ok("read", json!({ "designId": id, "as": "css" }))
        .await;
    assert!(
        tokens.contains("\"--brand\": \"#f97316\"") && tokens.contains("\"Dark\": \"#000000\""),
        "{tokens}"
    );
    assert!(
        tokens.contains("artboardModes"),
        "the draft is in Dark: {tokens}"
    );
    // replace changes token values too.
    let replaced = edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "#000000", "replace": "#111111" }]),
    )
    .await;
    assert!(
        replaced.contains("--bg (Dark): #000000 → #111111"),
        "{replaced}"
    );
    let found = agent
        .ok("read", json!({ "designId": id, "contains": "#111" }))
        .await;
    assert!(
        found.contains("In tokens") && found.contains("--bg (Dark)"),
        "{found}"
    );
    // Rename and remove pages, and turn an element into an artboard.
    let pages = edit(
        &mut agent,
        &id,
        json!([
            { "op": "page", "rename": "Drafts", "name": "Archive" },
            { "op": "move", "select": "[data-name=Footer], [data-name='Page footer']", "to": "canvas" },
            { "op": "page", "remove": "archive" },
        ]),
    )
    .await;
    assert!(
        pages.contains("Renamed page \"Drafts\" to \"Archive\""),
        "{pages}"
    );
    assert!(pages.contains("Deleted page \"archive\""), "{pages}");
    let after = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        !after.contains("Archive") && after.contains("\"Page footer\""),
        "{after}"
    );
}

#[tokio::test]
async fn a_flat_op_and_old_habits_work() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Habits").await;
    let (id, _) = landing(&mut agent).await;
    let flat = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "replace", "find": "Hello", "replace": "Hi",
                    "includeText": true, "check": false }),
        )
        .await;
    assert!(flat.contains("Replaced 1 use"), "{flat}");
    let h1 = agent
        .ok("read", json!({ "designId": id, "select": "h1" }))
        .await;
    let h1_id = id_after(&h1, "h1");
    // nodeIds instead of select, and update_styles' name for the op.
    let styled = edit(
        &mut agent,
        &id,
        json!([{ "op": "update_styles", "nodeIds": [h1_id], "styles": { "font-size": "40px" } }]),
    )
    .await;
    assert!(styled.contains("1 value changed"), "{styled}");
}

#[tokio::test]
async fn an_edit_is_one_undo_step_and_one_broadcast() {
    let (app, hub) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Atomic").await;
    let (id, board) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let (_, seq, mut changes) = handle.subscribe();
    let text = agent
        .ok(
            "edit",
            json!({ "designId": id, "status": "Restyling the cards", "check": false, "ops": [
                { "op": "css", "select": ".card", "css": "padding: 24px" },
                { "op": "html", "select": ".card", "html": "<em>!</em>" },
                { "op": "attrs", "select": "h1", "set": { "title": "Hi" } },
            ] }),
        )
        .await;
    assert!(text.contains("one step (3 ops)"), "{text}");
    let mut broadcasts = Vec::new();
    while let Ok(message) = changes.try_recv() {
        if message.seq.is_some() {
            broadcasts.push(message);
        }
    }
    assert_eq!(broadcasts.len(), 1, "one change for the whole edit");
    assert_eq!(broadcasts[0].seq, Some(seq + 1));
    assert!(broadcasts[0].json.contains("Restyling the cards"));
    // People see the status on the artboard.
    let presence = handle.presence();
    assert!(
        presence
            .iter()
            .any(|p| p.status.as_deref() == Some("Restyling the cards")
                && p.node_ids.contains(&board)),
        "{presence:?}"
    );
    let undone = agent.ok("undo", json!({ "designId": id })).await;
    assert_eq!(undone, "Undid your last edit (Restyling the cards).");
    let after = html(&mut agent, &id, ".card").await;
    assert!(
        !after.contains("24px") && !after.contains("<em>"),
        "{after}"
    );
    let redone = agent
        .ok("undo", json!({ "designId": id, "redo": true }))
        .await;
    assert!(redone.starts_with("Redid your last edit"), "{redone}");
    // Without a status, the label sums up the ops.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "#3b82f6", "replace": "#f97316" },
               { "op": "css", "select": ".card", "css": "margin: 0" }]),
    )
    .await;
    let undone = agent
        .ok("undo", json!({ "designId": id, "steps": 2 }))
        .await;
    assert_eq!(
        undone,
        "Undid your last 2 edits (Replace #3b82f6 → #f97316, css on .card, Restyling the cards)."
    );
}

#[tokio::test]
async fn a_failing_op_changes_nothing_and_nobody_sees_it() {
    let (app, hub) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Careful").await;
    let (id, _) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let before = handle.read(|d| d.seq());
    let (_, _, mut changes) = handle.subscribe();
    let error = refused(
        &mut agent,
        &id,
        json!([
            { "op": "css", "select": "h1", "css": "color: red" },
            { "op": "html", "select": ".nothing", "html": "<p>x</p>" },
        ]),
    )
    .await;
    assert!(
        error.starts_with("op 2 (html): select \".nothing\" matches no element")
            && error.ends_with("Nothing was changed."),
        "{error}"
    );
    assert_eq!(handle.read(|d| d.seq()), before);
    assert!(changes.try_recv().is_err(), "nothing was broadcast");
    assert!(!html(&mut agent, &id, "h1").await.contains("red"));
    assert_eq!(
        agent.ok("undo", json!({ "designId": id })).await,
        "Undid your last edit (Artboard \"Home\")."
    );
    // Errors name doc6's own ops.
    let unknown = refused(&mut agent, &id, json!([{ "op": "paint" }])).await;
    assert!(unknown.contains("Ops are artboard, html, css"), "{unknown}");
    let missing = refused(&mut agent, &id, json!([{ "op": "attrs", "select": "h1" }])).await;
    assert!(
        missing.contains("\"attrs\" needs set, like {\"op\": \"attrs\""),
        "{missing}"
    );
}

#[tokio::test]
async fn a_dry_run_changes_nothing() {
    let (app, hub) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Dry").await;
    let (id, _) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let before = handle.read(|d| d.seq());
    let (_, _, mut changes) = handle.subscribe();
    let text = agent
        .ok(
            "edit",
            json!({ "designId": id, "dryRun": true, "ops": [
                { "op": "remove", "select": ".card" },
                { "op": "replace", "find": "#3b82f6", "replace": "red" },
            ] }),
        )
        .await;
    assert!(text.starts_with("Dry run: nothing was changed"), "{text}");
    assert!(text.contains("Deleted 2 nodes"), "{text}");
    assert_eq!(handle.read(|d| d.seq()), before);
    assert!(changes.try_recv().is_err());
    assert!(html(&mut agent, &id, ".card").await.contains("First"));
}

#[tokio::test]
async fn refs_name_what_earlier_ops_made() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Refs").await;
    let id = design(&mut agent, "Refs").await;
    // A ref inside a quoted string is text, not a ref.
    edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Mobile", "width": 390, "html": "<header>Top</header>", "as": "m" },
            { "op": "html", "select": "@m", "html": "<section data-name=\"Body\"><p>me@example.com</p></section>", "as": "s" },
            { "op": "css", "css": "@s { padding: 16px } @m > header { color: blue }" },
            { "op": "html", "select": "@s p:contains(\"me@example.com\")", "html": "<i>x</i>" },
        ]),
    )
    .await;
    let body = html(&mut agent, &id, "[data-name=Body]").await;
    assert!(
        body.contains("padding: 16px") && body.contains("<i "),
        "{body}"
    );
    let header = html(&mut agent, &id, "header").await;
    assert!(header.contains("color: blue"), "{header}");
    let error = refused(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": "@nope", "html": "<p>x</p>" }]),
    )
    .await;
    assert!(
        error.contains(
            "\"@nope\" isn't defined. Give an earlier op in the same edit \"as\": \"nope\""
        ),
        "{error}"
    );
}

#[tokio::test]
async fn remove_refuses_matches_nested_inside_each_other() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Guard").await;
    let (id, _) = landing(&mut agent).await;
    // :has(p) matches the artboard and both cards.
    let error = refused(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": ":has(p)" }]),
    )
    .await;
    assert!(
        error.contains("nested inside each other, so it would remove div \"Home\"")
            && error.contains("Nothing was changed."),
        "{error}"
    );
    let removed = edit(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": ":has(> p)" }]),
    )
    .await;
    assert!(removed.contains("Deleted 2 nodes"), "{removed}");
}

#[tokio::test]
async fn html_inner_and_replace_take_one_match() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "One").await;
    let (id, _) = landing(&mut agent).await;
    let error = refused(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": ".card", "mode": "inner", "html": "x" }]),
    )
    .await;
    assert!(
        error.contains("matches 2 elements; mode inner takes one"),
        "{error}"
    );
}

#[tokio::test]
async fn a_stale_rewrite_keeps_another_agents_change() {
    let (app, _) = doc6();
    let mut alice = Agent::connect_doc6(&app, "Alice").await;
    let mut bob = Agent::connect_doc6(&app, "Bob").await;
    let (id, _) = landing(&mut alice).await;
    let read = html(&mut alice, &id, "[data-name=One]").await;
    let card = read.trim().to_owned();
    // Bob changes the paragraph after Alice read it.
    edit(
        &mut bob,
        &id,
        json!([{ "op": "css", "select": "[data-name=One] p", "css": "color: purple" }]),
    )
    .await;
    // Alice writes her copy back with her own change to the card.
    let mine = card
        .replace("<p ", "<p title=\"mine\" ")
        .replace("class=\"card\"", "class=\"card wide\"");
    let text = edit(
        &mut alice,
        &id,
        json!([{ "op": "html", "select": "[data-name=One]", "mode": "replace", "html": mine }]),
    )
    .await;
    assert!(text.contains("Rewrote it in place"), "{text}");
    assert!(text.contains("kept color: purple"), "{text}");
    let after = html(&mut alice, &id, "[data-name=One]").await;
    assert!(
        after.contains("color: purple") && after.contains("card wide") && after.contains("mine"),
        "{after}"
    );
}

#[tokio::test]
async fn two_agents_edit_at_once() {
    let (app, _) = doc6();
    let mut alice = Agent::connect_doc6(&app, "Alice").await;
    let mut bob = Agent::connect_doc6(&app, "Bob").await;
    let (id, _) = landing(&mut alice).await;
    let a = json!({ "designId": id, "check": false, "ops": [
        { "op": "html", "select": "[data-name=One]", "html": "<b>alice</b>" },
        { "op": "css", "select": "[data-name=One]", "css": "color: red" } ] });
    let b = json!({ "designId": id, "check": false, "ops": [
        { "op": "html", "select": "[data-name=Two]", "html": "<b>bob</b>" },
        { "op": "css", "select": "[data-name=Two]", "css": "color: blue" } ] });
    let (ra, rb) = tokio::join!(alice.ok("edit", a), bob.ok("edit", b));
    assert!(
        ra.contains("one step") && rb.contains("one step"),
        "{ra}\n{rb}"
    );
    let cards = html(&mut alice, &id, ".card").await;
    assert!(cards.contains("alice") && cards.contains("bob"), "{cards}");
    // Each undoes only its own edit.
    bob.ok("undo", json!({ "designId": id })).await;
    let cards = html(&mut alice, &id, ".card").await;
    assert!(cards.contains("alice") && !cards.contains("bob"), "{cards}");
    assert!(
        cards.contains("color: red") && !cards.contains("color: blue"),
        "{cards}"
    );
}

#[tokio::test]
async fn jsx_and_export_are_read_views() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Exporter").await;
    let (id, board) = landing(&mut agent).await;
    let jsx = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "h1", "as": "jsx" }),
        )
        .await;
    assert!(jsx.contains("<h1") && jsx.contains("style={{"), "{jsx}");
    let exported = agent
        .ok("read", json!({ "designId": id, "export": "finite" }))
        .await;
    assert!(exported.contains("\"Title\""), "{exported}");
    let one = agent
        .ok(
            "read",
            json!({ "designId": id, "select": format!("#{board}"), "export": "jsx" }),
        )
        .await;
    assert!(
        one.contains("export default") || one.contains("function"),
        "{one}"
    );
    let (error, failed) = agent
        .call("read", json!({ "designId": id, "export": "jsx" }))
        .await;
    assert!(failed && error.contains("takes one artboard"), "{error}");
}

#[tokio::test]
async fn comments_are_listed_awaited_and_answered() {
    let (app, hub) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Helper").await;
    let (id, board) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let h1 = handle.read(|d| {
        d.view()
            .subtree(&board)
            .iter()
            .find(|n| n.tag() == Some("h1"))
            .unwrap()
            .id
            .clone()
    });
    let person = Author {
        id: "user:ada".into(),
        name: "Ada".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some(board.clone()),
        node_id: Some(h1.clone()),
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 10.0,
    };
    let comment = handle
        .add_comment(person, anchor, Audience::Agents, "Make it orange")
        .unwrap();
    let listed = agent.ok("comments", json!({ "designId": id })).await;
    assert!(
        listed.contains("Make it orange") && listed.contains(&format!("\"select\": \"#{h1}\"")),
        "{listed}"
    );
    assert!(!listed.contains("\"nodeId\""), "{listed}");
    let waited = agent
        .ok("comments", json!({ "designId": id, "wait": 5 }))
        .await;
    assert!(waited.contains("Make it orange"), "{waited}");
    agent
        .ok(
            "edit",
            json!({ "designId": id, "status": "Making the title orange", "check": false,
                    "op": "css", "select": "h1", "css": "color: orange" }),
        )
        .await;
    let replied = agent
        .ok(
            "comments",
            json!({ "designId": id, "reply": [{ "commentId": comment.id,
                    "message": "Made it orange.", "resolve": true }] }),
        )
        .await;
    assert!(
        replied.contains("resolved") && replied.contains("Making the title orange"),
        "{replied}"
    );
    let none = agent
        .ok("comments", json!({ "designId": id, "wait": 1 }))
        .await;
    assert!(none.contains("No comments arrived"), "{none}");
}

#[tokio::test]
async fn render_and_the_layout_check_after_an_edit() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Checker").await;
    let (id, board) = landing(&mut agent).await;
    let (probe, _) = agent
        .call("render", json!({ "designId": id, "output": "layout" }))
        .await;
    if probe.contains("no Chrome") {
        assert!(
            std::env::var_os("FINITE_REQUIRE_BROWSER").is_none(),
            "FINITE_REQUIRE_BROWSER is set but there is no browser: {probe}"
        );
        eprintln!("SKIPPED, NOTHING WAS TESTED: no Chrome, Chromium or Edge found");
        return;
    }
    assert!(
        probe.contains("Layout:") && probe.contains(&board),
        "{probe}"
    );
    // A clean check says so, so agents needn't render to find out.
    let clean = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "css", "select": "h1", "css": "letter-spacing: 1px" }),
        )
        .await;
    assert!(clean.contains("Layout: nothing is cut off"), "{clean}");
    // It checks overlapping text, as render's layout output does.
    let overlap = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "html", "select": format!("#{board}"),
                    "html": "<div data-name=\"Badge\" style=\"position: absolute; top: 30px; left: 0; font-size: 32px\">New Hello</div>" }),
        )
        .await;
    assert!(
        overlap.contains("pair of text elements overlap"),
        "{overlap}"
    );
    agent.ok("undo", json!({ "designId": id })).await;
    let tall = "<div data-name=\"Tall\" style=\"height: 900px; flex-shrink: 0\">Tall</div>";
    // check: false leaves the check out.
    let unchecked = edit(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": format!("#{board}"), "html": tall }]),
    )
    .await;
    assert!(!unchecked.contains("Layout:"), "{unchecked}");
    agent.ok("undo", json!({ "designId": id })).await;
    // By default the edit waits for the check, as the layout note does.
    let mut checked = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "html", "select": format!("#{board}"), "html": tall }),
        )
        .await;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !checked.contains("Layout:") && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        checked = agent.ok("comments", json!({ "designId": id })).await;
    }
    assert!(
        checked.contains("cut off by the artboard's edge") && checked.contains("\"Tall\""),
        "{checked}"
    );
    assert!(
        checked.contains(&format!(
            "{{\"op\": \"css\", \"css\": \"#{board} {{ height:"
        )),
        "the fix is a doc6 op: {checked}"
    );
    assert!(!checked.contains("update_styles"), "{checked}");
    let (shot, error) = agent
        .call("render", json!({ "designId": id, "select": "h1" }))
        .await;
    assert!(!error, "{shot}");
}

/// A component op makes one top bar the component and its copies on the
/// other screens instances, in the same edit that built the screens, and an
/// edit to the component reaches every instance.
#[tokio::test]
async fn components_are_made_used_and_detached_in_edits() {
    let (app, _) = doc6();
    let mut agent = Agent::connect_doc6(&app, "Builder").await;
    let id = design(&mut agent, "App").await;
    let nav = |title: &str| {
        format!(
            "<header data-name=\"Nav\" style=\"background: #111827\"><h1 data-name=\"Title\">{title}</h1></header>"
        )
    };
    let made = edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Home", "width": 400, "height": 300, "html": nav("Home") },
            { "op": "artboard", "name": "Settings", "width": 400, "height": 300, "html": nav("Settings") },
            { "op": "component", "select": "[data-name=Nav]", "name": "Top bar", "as": "bar" },
            { "op": "css", "select": "@bar", "css": "background: #f97316" },
        ]),
    )
    .await;
    assert!(made.contains("is a component"), "{made}");
    assert!(!made.contains("New in the component"), "{made}");
    assert!(made.contains("Replaced 1 copy with instances"), "{made}");
    assert!(
        made.contains("#") && made.contains(": 1 override"),
        "{made}"
    );
    let home = id_after(&made, "Created artboard");
    let bar = id_after(&made, "3. component: header");
    let instance = id_after(&made, "Replaced 1 copy with instances, keeping their ids:");

    // The overview lists it, and the instance shows the component's new
    // color with its own title.
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains(&format!("Components: \"Top bar\" #{bar} (1 instance)")),
        "{overview}"
    );
    let shown = html(&mut agent, &id, &format!("#{instance}")).await;
    assert!(
        shown.contains("#f97316") && shown.contains("Settings"),
        "{shown}"
    );
    assert!(
        shown.contains("Elements with data-instance-of are instances"),
        "{shown}"
    );
    let root = html(&mut agent, &id, &format!("#{bar}")).await;
    assert!(root.contains("which 1 instance shows"), "{root}");

    // An edit to the component says it reached the instance, and one
    // inside the instance says only it changed.
    let recolored = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": &format!("#{bar}"), "css": "color: #fff" }]),
    )
    .await;
    assert!(
        recolored.contains("so all 1 instance show it too"),
        "{recolored}"
    );
    let marker = format!("data-id=\"{instance}/");
    let at = shown.find(&marker).expect("a node inside the instance") + marker.len();
    let title: String = shown[at..]
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    let own = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": &format!("#{instance}/{title}"), "css": "color: #22c55e" }]),
    )
    .await;
    assert!(own.contains(&format!("Only instance #{instance}")), "{own}");

    // data-instance-of in html adds another instance.
    let added = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Profile", "width": 400, "height": 300,
                 "html": format!("<header data-instance-of=\"{bar}\"></header>") }]),
    )
    .await;
    assert!(
        added.contains(&format!("instance of \"Top bar\" #{bar}")),
        "{added}"
    );

    // Detach makes it a plain copy, and undo makes it an instance again.
    let detached = edit(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": &format!("#{instance}"), "detach": true }]),
    )
    .await;
    assert!(detached.contains("Detached 1 instance"), "{detached}");
    let plain = html(&mut agent, &id, &format!("#{instance}")).await;
    assert!(
        !plain.contains("data-instance-of") && plain.contains("Settings"),
        "{plain}"
    );
    agent.ok("undo", json!({ "designId": id })).await;
    let back = html(&mut agent, &id, &format!("#{instance}")).await;
    assert!(back.contains("data-instance-of"), "{back}");

    // A copy built differently can't become an instance, and nothing changes.
    let refusal = refused(
        &mut agent,
        &id,
        json!([
            { "op": "html", "select": format!("#{home}"), "html": "<header data-name=\"Nav\"><p>Other</p></header>" },
            { "op": "component", "select": "[data-name=\"Top bar\"], [data-name=Nav]" },
        ]),
    )
    .await;
    assert!(
        refusal.contains("op 2 (component)") && refusal.contains("Nothing was changed"),
        "{refusal}"
    );
}

#[tokio::test]
async fn each_comment_goes_to_one_agent() {
    let (app, hub) = doc6();
    let mut ada = Agent::connect_doc6(&app, "Ada").await;
    let mut bo = Agent::connect_doc6(&app, "Bo").await;
    let (id, board) = landing(&mut ada).await;
    edit(&mut ada, &id, json!([{ "op": "page", "create": "Drafts" }])).await;
    let handle = hub.open(&id).await.unwrap();
    let person = Author {
        id: "user:cy".into(),
        name: "Cy".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some(board.clone()),
        node_id: None,
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 10.0,
    };
    let post = |audience, body| {
        handle
            .add_comment(person.clone(), anchor.clone(), audience, body)
            .unwrap()
    };
    let wait = json!({ "designId": id, "wait": 1 });

    let none = |reply: String| reply.contains("No comments arrived");
    // Both agents listen. Ada made the board, so its comments go to Ada.
    assert!(none(ada.ok("comments", wait.clone()).await));
    assert!(none(bo.ok("comments", wait.clone()).await));
    let orange = post(Audience::Agents, "Make it orange");
    assert!(none(bo.ok("comments", wait.clone()).await));
    let mine = ada.ok("comments", wait.clone()).await;
    assert!(
        mine.contains("Make it orange") && mine.contains("\"for\": \"you\""),
        "{mine}"
    );
    let listed = bo.ok("comments", json!({ "designId": id })).await;
    assert!(
        listed.contains("\"for\": \"Ada (another agent)\""),
        "{listed}"
    );

    // Passing hands it to the other agent, and a person's follow-up goes
    // back to the agent that took it.
    let passed = ada
        .ok(
            "comments",
            json!({ "designId": id, "pass": [orange.id], "wait": 1 }),
        )
        .await;
    assert!(
        passed.contains("Passed on") && none(passed.clone()),
        "{passed}"
    );
    let theirs = bo.ok("comments", wait.clone()).await;
    assert!(
        theirs.contains("Make it orange") && theirs.contains("passedBy"),
        "{theirs}"
    );
    handle
        .reply(&orange.id, person.clone(), "Darker, please", None)
        .unwrap();
    assert!(none(ada.ok("comments", wait.clone()).await));
    assert!(
        bo.ok("comments", wait.clone())
            .await
            .contains("Darker, please")
    );

    // A person's pick wins.
    handle
        .set_audience(
            &orange.id,
            Audience::Agent {
                id: "agent:Ada".into(),
                name: "Ada".into(),
            },
        )
        .unwrap();
    assert!(none(bo.ok("comments", wait.clone()).await));
    let mentions = json!({ "designId": id, "mentions": true, "wait": 1 });
    assert!(
        ada.ok("comments", mentions)
            .await
            .contains("Darker, please")
    );

    // An agent marks a note between people, and then nobody gets it.
    let note = post(Audience::Agents, "Ask the client about blue");
    let marked = ada
        .ok(
            "comments",
            json!({ "designId": id, "forPeople": [note.id], "wait": 1 }),
        )
        .await;
    assert!(
        marked.contains("Marked") && !marked.contains("Ask the client"),
        "{marked}"
    );
    let listed = bo.ok("comments", json!({ "designId": id })).await;
    assert!(listed.contains("\"for\": \"people\""), "{listed}");
    let overview = bo.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains("2 open comments (0 waiting for you)"),
        "{overview}"
    );
    assert!(
        !overview.contains("waiting for you: call comments"),
        "{overview}"
    );

    // Filters narrow what an agent hears.
    handle
        .reply(&orange.id, person.clone(), "Even darker", None)
        .unwrap();
    let drafts = json!({ "designId": id, "page": "Drafts", "wait": 1 });
    assert!(none(ada.ok("comments", drafts).await));
    let home = json!({ "designId": id, "select": format!("#{board}"), "wait": 1 });
    assert!(ada.ok("comments", home).await.contains("Even darker"));

    // An agent listening to another page doesn't hold up comments here.
    let drafts = json!({ "designId": id, "page": "Drafts", "wait": 1 });
    assert!(none(ada.ok("comments", drafts).await));
    post(Audience::Agents, "Make it pink");
    assert!(
        bo.ok("comments", wait.clone())
            .await
            .contains("Make it pink")
    );
}
