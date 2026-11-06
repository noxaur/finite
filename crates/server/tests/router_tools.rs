//! The six tools through the router, in front of two servers. A tool takes a
//! design's name, or the start of its id, for its id, and each server knows
//! only its own designs, so the relay resolves them across both.

use std::sync::Arc;

use finite_server::{
    Hub, app,
    cluster::Cluster,
    store::MemoryStore,
    testing::{front_for, listen, serve},
};
use rmcp::{
    ServiceExt,
    model::CallToolRequestParams,
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};

type Client = rmcp::service::RunningService<rmcp::RoleClient, ()>;

/// Two servers and a router in front of them, and an agent connected to the
/// router. Returns the agent, the servers' hubs and the cluster.
async fn deployment() -> (Client, Vec<Arc<Hub>>, Cluster) {
    let (a, a_url) = listen().await;
    let (b, b_url) = listen().await;
    let nodes = vec![a_url, b_url];
    let mut hubs = Vec::new();
    for (me, listener) in [a, b].into_iter().enumerate() {
        let cluster = Cluster::new(nodes.clone(), me).unwrap();
        let hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster).unwrap();
        hubs.push(hub.clone());
        serve(listener, app(hub, None));
    }
    let (front, front_url) = listen().await;
    let routes = front_for(nodes.clone());
    serve(front, routes);
    let mut headers = std::collections::HashMap::new();
    headers.insert(
        http::HeaderName::from_static("x-finite-agent"),
        http::HeaderValue::from_static("Alice"),
    );
    let config = StreamableHttpClientTransportConfig::with_uri(format!("{front_url}/mcp"))
        .custom_headers(headers);
    let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();
    (client, hubs, Cluster::new(nodes, 0).unwrap())
}

/// A tool's text, and whether it was an error.
async fn call(client: &Client, tool: &str, args: Value) -> (String, bool) {
    let params = CallToolRequestParams::new(tool.to_owned())
        .with_arguments(args.as_object().unwrap().clone());
    let result = client.call_tool(params).await.unwrap();
    let text: String = result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect();
    (text, result.is_error == Some(true))
}

async fn ok(client: &Client, tool: &str, args: Value) -> String {
    let (text, error) = call(client, tool, args).await;
    assert!(!error, "{tool} failed: {text}");
    text
}

async fn refused(client: &Client, tool: &str, args: Value) -> String {
    let (text, error) = call(client, tool, args).await;
    assert!(error, "{tool} should have failed: {text}");
    text
}

/// Creates designs named `names` through the router, and returns their ids.
async fn create(client: &Client, names: &[&str]) -> Vec<String> {
    let mut ids = Vec::new();
    for name in names {
        let created = ok(client, "designs", json!({ "create": name })).await;
        ids.push(
            created
                .split(|c: char| !c.is_ascii_alphanumeric())
                .find(|w| w.len() == 10)
                .expect("a design id")
                .to_owned(),
        );
    }
    ids
}

/// The artboards' names on the design `id`, as its owner holds it.
async fn boards(hubs: &[Arc<Hub>], cluster: &Cluster, id: &str) -> Vec<String> {
    let handle = hubs[cluster.owner(id).unwrap()].open(id).await.unwrap();
    handle.read(|d| {
        d.view()
            .artboards()
            .iter()
            .filter_map(|b| b.name.clone())
            .collect()
    })
}

#[tokio::test]
async fn designs_lists_both_servers_and_creates_take_turns() {
    let (client, _, cluster) = deployment().await;
    let tools = client.list_all_tools().await.unwrap();
    assert!(tools.iter().any(|t| t.name == "designs"));
    let info = client.peer_info().unwrap();
    assert!(
        info.instructions
            .as_deref()
            .is_some_and(|i| i.contains("There are six tools"))
    );
    let ids = create(&client, &["Alpha", "Beta"]).await;
    let mut owners: Vec<usize> = ids.iter().map(|id| cluster.owner(id).unwrap()).collect();
    owners.sort();
    assert_eq!(owners, [0, 1], "creation takes turns across both servers");
    let listed = ok(&client, "designs", json!({})).await;
    for id in &ids {
        assert!(listed.contains(id.as_str()), "{listed}");
    }
    let one = ok(&client, "designs", json!({ "limit": 1 })).await;
    assert_eq!(ids.iter().filter(|id| one.contains(id.as_str())).count(), 1);
    assert!(one.contains("Showing the 1 most recently edited"), "{one}");
    let beta = ok(&client, "designs", json!({ "query": "bet" })).await;
    assert!(beta.contains(ids[1].as_str()) && !beta.contains(ids[0].as_str()));
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn names_and_prefixes_reach_the_server_that_owns_the_design() {
    let (client, hubs, cluster) = deployment().await;
    let ids = create(&client, &["Alpha site", "Beta site"]).await;
    for (id, name) in ids.iter().zip(["alpha SITE", "Beta site"]) {
        let made = ok(
            &client,
            "edit",
            json!({ "designId": name, "check": false,
                    "op": "artboard", "name": format!("Home {id}"), "width": 400, "height": 300 }),
        )
        .await;
        assert!(made.contains("Created artboard"), "{made}");
        assert_eq!(boards(&hubs, &cluster, id).await, [format!("Home {id}")]);
        let read = ok(&client, "read", json!({ "designId": name })).await;
        assert!(read.contains(&format!("Home {id}")), "{read}");
        let by_prefix = ok(&client, "read", json!({ "designId": &id[..6] })).await;
        assert_eq!(by_prefix, read);
    }
    let rename = ok(
        &client,
        "designs",
        json!({ "designId": "beta site", "rename": "Gamma" }),
    )
    .await;
    assert!(
        rename.contains("Renamed the design to \"Gamma\""),
        "{rename}"
    );
    let listed = ok(&client, "designs", json!({ "query": "gamma" })).await;
    assert!(listed.contains(ids[1].as_str()), "{listed}");

    // Unknown names fail as on one server, suggesting what's near.
    let unknown = refused(&client, "read", json!({ "designId": "site" })).await;
    assert!(
        unknown.starts_with("there's no design \"site\". Did you mean \"Alpha site\""),
        "{unknown}"
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn a_name_on_both_servers_is_ambiguous() {
    let (client, _, cluster) = deployment().await;
    let ids = create(&client, &["Twin", "Twin"]).await;
    assert_ne!(cluster.owner(&ids[0]), cluster.owner(&ids[1]));
    let error = refused(&client, "read", json!({ "designId": "twin" })).await;
    assert!(
        error.starts_with(
            "there's no design \"twin\" with one name: several have it, so pass the id."
        ),
        "{error}"
    );
    for id in &ids {
        assert!(error.contains(id.as_str()), "{error}");
        ok(&client, "read", json!({ "designId": id })).await;
    }
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn delete_takes_an_exact_name_on_either_server_and_refuses_a_prefix() {
    let (client, hubs, cluster) = deployment().await;
    let ids = create(&client, &["Keep me", "Drop me"]).await;
    // The design on the second server, which a call routed to the first
    // server, or by the name's hash, could miss.
    let (on_b, name) = if cluster.owner(&ids[1]) == Some(1) {
        (&ids[1], "Drop me")
    } else {
        (&ids[0], "Keep me")
    };
    let prefix = refused(&client, "designs", json!({ "delete": &on_b[..6] })).await;
    assert_eq!(
        prefix,
        format!(
            "\"{}\" isn't a design's exact id or name, so nothing was deleted. Did you mean {name:?} ({on_b})? Pass its id to delete it.",
            &on_b[..6]
        )
    );
    assert!(hubs[1].list().iter().any(|d| &d.meta.id == on_b));
    let deleted = ok(&client, "designs", json!({ "delete": name.to_uppercase() })).await;
    assert_eq!(
        deleted,
        format!("Deleted design {name:?} ({on_b}) permanently.")
    );
    assert!(!hubs[1].list().iter().any(|d| &d.meta.id == on_b));
    let listed = ok(&client, "designs", json!({})).await;
    assert!(!listed.contains(on_b.as_str()), "{listed}");
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn an_edit_on_the_second_server_is_one_undo_step_there() {
    let (client, hubs, cluster) = deployment().await;
    let ids = create(&client, &["One", "Two"]).await;
    let (id, name) = if cluster.owner(&ids[1]) == Some(1) {
        (&ids[1], "Two")
    } else {
        (&ids[0], "One")
    };
    let text = ok(
        &client,
        "edit",
        json!({ "designId": name, "check": false, "ops": [
            { "op": "artboard", "name": "Home", "width": 400, "height": 300, "as": "home",
              "html": "<h1>Hello</h1>" },
            { "op": "css", "select": "@home h1", "css": "color: red" },
            { "op": "artboard", "name": "About", "width": 400, "height": 300 },
        ] }),
    )
    .await;
    assert!(text.contains("one step (3 ops)"), "{text}");
    assert_eq!(boards(&hubs, &cluster, id).await, ["Home", "About"]);
    let undone = ok(&client, "undo", json!({ "designId": name })).await;
    assert!(undone.starts_with("Undid your last edit"), "{undone}");
    assert!(boards(&hubs, &cluster, id).await.is_empty());
    let none = ok(&client, "undo", json!({ "designId": name })).await;
    assert_eq!(none, "Nothing to undo.");
    client.cancel().await.unwrap();
}
