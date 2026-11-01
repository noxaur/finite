//! Two servers behind the router, over real sockets: designs created through
//! the router spread across both servers, and every request and WebSocket
//! reaches the right one.

use std::sync::Arc;

use finite_server::{Hub, app, cluster::Cluster, router, store::MemoryStore};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (listener, url)
}

/// Starts two servers and a router in front of them. Returns the router's URL
/// and the servers' URLs.
async fn deployment() -> (String, Vec<String>) {
    let (a, a_url) = listen().await;
    let (b, b_url) = listen().await;
    let nodes = vec![a_url, b_url];
    for (me, listener) in [a, b].into_iter().enumerate() {
        let cluster = Cluster::new(nodes.clone(), me).unwrap();
        let hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster).unwrap();
        tokio::spawn(async move { axum::serve(listener, app(hub, None)).await });
    }
    let (front, front_url) = listen().await;
    let routes = router::app(nodes.clone(), None);
    tokio::spawn(async move { axum::serve(front, routes).await });
    (front_url, nodes)
}

async fn first_text(url: &str) -> Value {
    let ws = url.replacen("http://", "ws://", 1);
    let (mut socket, _) = tokio_tungstenite::connect_async(ws).await.unwrap();
    match socket.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn the_router_makes_two_servers_look_like_one() {
    let (front, nodes) = deployment().await;
    let http = reqwest::Client::new();

    let mut ids = Vec::new();
    for i in 0..6 {
        let created: Value = http
            .post(format!("{front}/api/designs"))
            .json(&json!({ "name": format!("Design {i}") }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        ids.push(created["id"].as_str().unwrap().to_owned());
    }

    // Creation takes turns, so both servers hold designs.
    for node in &nodes {
        let own: Vec<Value> = http
            .get(format!("{node}/api/designs"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(own.len(), 3, "{node} holds half the designs");
    }

    // The router's list merges both.
    let all: Vec<Value> = http
        .get(format!("{front}/api/designs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(all.len(), 6);

    for id in &ids {
        // Plain requests reach the owner.
        let res = http
            .get(format!("{front}/api/designs/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{id}");

        // So do comments, which carry a body.
        let res = http
            .post(format!("{front}/api/designs/{id}/comments"))
            .json(
                &json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Hi", "x": 1, "y": 2 }),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 201, "{id}");

        // And the design's WebSocket, which starts with its snapshot.
        let first = first_text(&format!("{front}/api/designs/{id}/ws")).await;
        assert_eq!(first["type"], "snapshot");
        assert_eq!(first["snapshot"]["meta"]["id"], id.as_str());
        assert_eq!(first["snapshot"]["comments"].as_array().unwrap().len(), 1);

        // A viewer that reconnects says where it left off, and that reaches
        // the owner too, so it resumes instead of starting over.
        let epoch = first["epoch"].as_str().unwrap();
        let seq = first["snapshot"]["seq"].as_u64().unwrap();
        let url = format!("{front}/api/designs/{id}/ws?epoch={epoch}&since={seq}");
        assert_eq!(first_text(&url).await["type"], "resume");
    }

    // A search reaches every server, and the merged list keeps its limit.
    let found: Vec<Value> = http
        .get(format!("{front}/api/designs?q=design%203"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    let two: Vec<Value> = http
        .get(format!("{front}/api/designs?limit=2"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(two.len(), 2);

    // The design list's WebSocket starts with every server's designs, then
    // relays new ones from whichever server creates them.
    let ws = format!("{front}/api/designs/ws").replacen("http://", "ws://", 1);
    let (mut lobby, _) = tokio_tungstenite::connect_async(ws).await.unwrap();
    let mut next = async || match lobby.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str::<Value>(text.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    };
    let first = next().await;
    assert_eq!(first["type"], "designs");
    assert_eq!(first["total"], 6, "the total adds up every server's");
    assert_eq!(first["designs"].as_array().unwrap().len(), 6);
    for name in ["Seventh", "Eighth"] {
        http.post(format!("{front}/api/designs"))
            .json(&json!({ "name": name }))
            .send()
            .await
            .unwrap();
        let update = next().await;
        assert_eq!(update["type"], "design");
        assert_eq!(update["design"]["name"], name);
    }
}

/// Two servers that know about each other, and a router that only knows the
/// first, as while a server is being added. Returns the router's URL and a
/// design that lives on the second server.
async fn lagging_router() -> (String, String) {
    let (a, a_url) = listen().await;
    let (b, b_url) = listen().await;
    let nodes = vec![a_url.clone(), b_url];
    let hub_a = Hub::with_cluster(
        Arc::new(MemoryStore::default()),
        Cluster::new(nodes.clone(), 0).unwrap(),
    )
    .unwrap();
    let hub_b = Hub::with_cluster(
        Arc::new(MemoryStore::default()),
        Cluster::new(nodes, 1).unwrap(),
    )
    .unwrap();
    let id = hub_b.create("On B").meta.id;
    tokio::spawn(async move { axum::serve(a, app(hub_a, None)).await });
    tokio::spawn(async move { axum::serve(b, app(hub_b, None)).await });
    let (front, front_url) = listen().await;
    let routes = router::app(vec![a_url], None);
    tokio::spawn(async move { axum::serve(front, routes).await });
    (front_url, id)
}

/// The router sends B's design to A, the only server it knows. A answers
/// `421` with B's URL, and the router follows it, for requests and sockets.
#[tokio::test]
async fn the_router_follows_a_misdirected_answer_to_the_owner() {
    let (front, id) = lagging_router().await;
    let res = reqwest::get(format!("{front}/api/designs/{id}"))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let first = first_text(&format!("{front}/api/designs/{id}/ws")).await;
    assert_eq!(first["type"], "snapshot");
}

/// With one server down, the design list still shows the others' designs,
/// over plain HTTP and over its socket.
#[tokio::test]
async fn the_design_list_survives_a_server_being_down() {
    let (a, a_url) = listen().await;
    // Port 9 (discard) refuses connections on a normal machine.
    let nodes = vec![a_url, "http://127.0.0.1:9".to_owned()];
    let hub = Hub::with_cluster(
        Arc::new(MemoryStore::default()),
        Cluster::new(nodes.clone(), 0).unwrap(),
    )
    .unwrap();
    let id = hub.create("Still here").meta.id;
    tokio::spawn(async move { axum::serve(a, app(hub, None)).await });
    let (front, front_url) = listen().await;
    let routes = router::app(nodes, None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    let listed: Vec<Value> = reqwest::get(format!("{front_url}/api/designs"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    let first = first_text(&format!("{front_url}/api/designs/ws")).await;
    assert_eq!(first["type"], "designs");
    assert_eq!(first["designs"][0]["id"], id.as_str());

    // New designs skip the server that's down, whoever's turn it is.
    let http = reqwest::Client::new();
    for _ in 0..2 {
        let res = http
            .post(format!("{front_url}/api/designs"))
            .json(&json!({ "name": "New" }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 201);
    }
    use rmcp::{
        ServiceExt,
        transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        },
    };
    let config = StreamableHttpClientTransportConfig::with_uri(format!("{front_url}/mcp"));
    let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();
    for _ in 0..2 {
        let params = rmcp::model::CallToolRequestParams::new("create_design")
            .with_arguments(json!({ "name": "By agent" }).as_object().unwrap().clone());
        let result = client.call_tool(params).await.unwrap();
        assert_ne!(result.is_error, Some(true));
    }
    client.cancel().await.unwrap();
}

/// Another site can't read designs through a WebSocket (cross-site
/// WebSocket hijacking) or a name that points here (DNS rebinding). The
/// app's own pages, and clients that send no Origin, still can.
#[tokio::test]
async fn other_sites_cant_read_the_api() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let (server, server_url) = listen().await;
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    tokio::spawn(async move { axum::serve(server, app(hub, None)).await });
    let (front, front_url) = listen().await;
    let routes = router::app(vec![server_url.clone()], None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    for base in [&server_url, &front_url] {
        let ws = format!("{base}/api/designs/ws").replacen("http://", "ws://", 1);
        let open = |origin: Option<&str>| {
            let mut request = ws.as_str().into_client_request().unwrap();
            if let Some(origin) = origin {
                request
                    .headers_mut()
                    .insert("origin", origin.parse().unwrap());
            }
            tokio_tungstenite::connect_async(request)
        };
        let refused = open(Some("https://evil.example")).await;
        assert!(
            matches!(&refused, Err(tokio_tungstenite::tungstenite::Error::Http(res)) if res.status() == 403),
            "{base}: {refused:?}"
        );
        assert!(
            open(Some(base)).await.is_ok(),
            "{base}: the app's own origin"
        );
        assert!(open(None).await.is_ok(), "{base}: no origin");

        let rebound = reqwest::Client::new()
            .get(format!("{base}/api/designs"))
            .header("host", "evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), 403, "{base}");

        // Nor can it drive an agent session from the page.
        let init = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": { "name": "page", "version": "1" } },
        });
        let mcp = reqwest::Client::new()
            .post(format!("{base}/mcp"))
            .header("origin", "https://evil.example")
            .header("accept", "application/json, text/event-stream")
            .json(&init)
            .send()
            .await
            .unwrap();
        assert_eq!(mcp.status(), 403, "{base}");
    }
}

mod relay {
    use super::*;
    use rmcp::{
        ServiceExt,
        model::CallToolRequestParams,
        transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        },
    };

    type Client = rmcp::service::RunningService<rmcp::RoleClient, ()>;

    async fn call(client: &Client, tool: &str, args: Value) -> String {
        let params = CallToolRequestParams::new(tool.to_owned())
            .with_arguments(args.as_object().unwrap().clone());
        let result = client.call_tool(params).await.unwrap();
        let text: String = result
            .content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.clone()))
            .collect();
        assert_ne!(result.is_error, Some(true), "{tool} failed: {text}");
        text
    }

    fn design_id(text: &str) -> String {
        text.split(|c: char| !c.is_ascii_alphanumeric())
            .find(|w| w.len() == 10)
            .expect("a design id")
            .to_owned()
    }

    #[tokio::test]
    async fn one_agent_session_reaches_every_server() {
        let (front, nodes) = deployment().await;
        let mut headers = std::collections::HashMap::new();
        headers.insert(
            http::HeaderName::from_static("x-finite-agent"),
            http::HeaderValue::from_static("Alice"),
        );
        let config = StreamableHttpClientTransportConfig::with_uri(format!("{front}/mcp"))
            .custom_headers(headers);
        let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();

        let tools = client.list_all_tools().await.unwrap();
        assert!(tools.iter().any(|t| t.name == "write_html"));

        // Two designs: creation takes turns, so one lands on each server.
        let mut ids = Vec::new();
        for name in ["First", "Second"] {
            ids.push(design_id(
                &call(&client, "create_design", json!({ "name": name })).await,
            ));
        }
        let cluster = Cluster::new(nodes.clone(), 0).unwrap();
        let mut owners: Vec<usize> = ids.iter().map(|id| cluster.owner(id)).collect();
        owners.sort();
        assert_eq!(owners, [0, 1]);

        for id in &ids {
            let board = call(
                &client,
                "create_artboard",
                json!({ "designId": id, "name": "Home", "width": 400, "height": 300 }),
            )
            .await;
            let board = board
                .split('#')
                .nth(1)
                .unwrap()
                .split('.')
                .next()
                .unwrap()
                .to_owned();
            call(
                &client,
                "update_styles",
                json!({ "designId": id, "updates": [{ "nodeIds": [board], "styles": { "color": "red" } }] }),
            )
            .await;
            // Undo works per server, because the relay keeps one session on each.
            call(&client, "undo", json!({ "designId": id })).await;
            let html = call(
                &client,
                "get_html",
                json!({ "designId": id, "nodeId": board }),
            )
            .await;
            assert!(!html.contains("red"), "{html}");
            let history = call(&client, "get_history", json!({ "designId": id })).await;
            assert!(history.contains("Create artboard"), "{history}");
        }

        let listed = call(&client, "list_designs", json!({})).await;
        for id in &ids {
            assert!(listed.contains(id.as_str()), "{listed}");
        }
        // The merged list is cut to the limit too, and says so.
        let one = call(&client, "list_designs", json!({ "limit": 1 })).await;
        let shown = ids.iter().filter(|id| one.contains(id.as_str())).count();
        assert_eq!(shown, 1, "{one}");
        assert!(one.contains("Showing the 1 most recently edited"), "{one}");
        client.cancel().await.unwrap();
    }

    /// The relay follows a tool error that names the design's owner, as the
    /// HTTP router follows a `421`.
    #[tokio::test]
    async fn the_relay_follows_a_server_that_says_its_elsewhere() {
        let (front, id) = lagging_router().await;
        let config = StreamableHttpClientTransportConfig::with_uri(format!("{front}/mcp"));
        let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();
        let info = call(&client, "get_basic_info", json!({ "designId": id })).await;
        assert!(info.contains("On B"), "{info}");
        client.cancel().await.unwrap();
    }

    /// A server on its own runtime, so stopping it drops every connection at
    /// once, the way a crash would.
    struct Node {
        runtime: Option<tokio::runtime::Runtime>,
        hub: Arc<Hub>,
    }

    impl Node {
        fn start(
            listener: std::net::TcpListener,
            cluster: Cluster,
            store: Arc<MemoryStore>,
        ) -> Self {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let _inside = runtime.enter();
            listener.set_nonblocking(true).unwrap();
            let listener = TcpListener::from_std(listener).unwrap();
            let hub = Hub::with_cluster(store, cluster).unwrap();
            runtime.spawn(axum::serve(listener, app(hub.clone(), None)).into_future());
            Self {
                runtime: Some(runtime),
                hub,
            }
        }
    }

    impl Drop for Node {
        fn drop(&mut self) {
            self.hub.flush();
            if let Some(runtime) = self.runtime.take() {
                runtime.shutdown_background();
            }
        }
    }

    #[tokio::test]
    async fn the_relay_rides_out_a_server_restart() {
        let a = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let b = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let b_addr = b.local_addr().unwrap();
        let nodes: Vec<String> = [&a, &b]
            .map(|l| format!("http://{}", l.local_addr().unwrap()))
            .to_vec();
        let cluster = |me| Cluster::new(nodes.clone(), me).unwrap();
        let _a = Node::start(a, cluster(0), Arc::new(MemoryStore::default()));
        let b_store = Arc::new(MemoryStore::default());
        let b_node = Node::start(b, cluster(1), b_store.clone());
        let (front, front_url) = listen().await;
        let routes = router::app(nodes.clone(), None);
        tokio::spawn(async move { axum::serve(front, routes).await });

        let config = StreamableHttpClientTransportConfig::with_uri(format!("{front_url}/mcp"));
        let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();
        // Creation takes turns: the first design is A's, the second B's.
        let on_a = design_id(&call(&client, "create_design", json!({ "name": "On A" })).await);
        let on_b = design_id(&call(&client, "create_design", json!({ "name": "On B" })).await);
        assert_eq!(cluster(0).owner(&on_b), 1);
        call(&client, "get_basic_info", json!({ "designId": on_b })).await;

        // While B is down, its designs fail, but the list still shows A's.
        drop(b_node);
        let params = CallToolRequestParams::new("get_basic_info")
            .with_arguments(json!({ "designId": on_b }).as_object().unwrap().clone());
        let down = client.call_tool(params).await;
        assert!(down.is_err() || down.unwrap().is_error == Some(true));
        let listed = call(&client, "list_designs", json!({})).await;
        assert!(listed.contains(&on_a), "{listed}");
        assert!(listed.contains("didn't answer"), "{listed}");

        // Once B is back, the same agent session reaches it again.
        let b = std::net::TcpListener::bind(b_addr).unwrap();
        let _b = Node::start(b, cluster(1), b_store);
        let info = call(&client, "get_basic_info", json!({ "designId": on_b })).await;
        assert!(info.contains("On B"), "{info}");
        let listed = call(&client, "list_designs", json!({})).await;
        assert!(listed.contains(&on_a) && listed.contains(&on_b), "{listed}");
        client.cancel().await.unwrap();
    }
}

mod failover {
    use super::*;
    use finite_server::relay::DirSessionStore;

    /// A bare MCP client over HTTP, so a test can send one session's requests
    /// to different routers.
    struct Session {
        http: reqwest::Client,
        id: Option<String>,
        next: u64,
    }

    impl Session {
        async fn post(&mut self, base: &str, body: Value) -> (u16, Option<Value>) {
            let mut req = self
                .http
                .post(format!("{base}/mcp"))
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", "2025-06-18")
                .json(&body);
            if let Some(id) = &self.id {
                req = req.header("mcp-session-id", id);
            }
            let res = req.send().await.unwrap();
            if let Some(id) = res.headers().get("mcp-session-id") {
                self.id = Some(id.to_str().unwrap().to_owned());
            }
            let status = res.status().as_u16();
            let text = res.text().await.unwrap();
            let data: String = text
                .lines()
                .filter_map(|l| l.strip_prefix("data: "))
                .collect();
            (
                status,
                (!data.trim().is_empty()).then(|| serde_json::from_str(&data).unwrap()),
            )
        }

        async fn start(base: &str) -> Self {
            let mut session = Self {
                http: reqwest::Client::new(),
                id: None,
                next: 1,
            };
            let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "Tester", "version": "1" } } });
            session.post(base, init).await;
            session
                .post(
                    base,
                    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                )
                .await;
            session
        }

        /// Calls a tool through `base`. Returns the HTTP status and the tool's text.
        async fn call(&mut self, base: &str, tool: &str, args: Value) -> (u16, String) {
            self.next += 1;
            let body = json!({ "jsonrpc": "2.0", "id": self.next, "method": "tools/call",
                               "params": { "name": tool, "arguments": args } });
            let (status, response) = self.post(base, body).await;
            let text = response
                .and_then(|r| r["result"]["content"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|c| c["text"].as_str().map(String::from))
                .collect();
            (status, text)
        }
    }

    async fn two_routers(sessions: Option<&std::path::Path>) -> (String, String) {
        let (_, nodes) = deployment().await;
        let mut urls = Vec::new();
        for _ in 0..2 {
            let store = sessions.map(|dir| {
                Arc::new(DirSessionStore::new(dir).unwrap())
                    as Arc<
                        dyn rmcp::transport::streamable_http_server::session::store::SessionStore,
                    >
            });
            let (listener, url) = listen().await;
            let routes = router::app_with_sessions(nodes.clone(), None, store);
            tokio::spawn(async move { axum::serve(listener, routes).await });
            urls.push(url);
        }
        (urls[0].clone(), urls[1].clone())
    }

    #[tokio::test]
    async fn a_session_moves_between_routers_and_keeps_its_undo() {
        let dir = std::env::temp_dir().join(format!("finite-sessions-{}", uuid::Uuid::new_v4()));
        let (a, b) = two_routers(Some(&dir)).await;

        // An unnamed agent starts on router A.
        let mut agent = Session::start(&a).await;
        let (_, created) = agent
            .call(&a, "create_design", json!({ "name": "Moving" }))
            .await;
        let id: String = created
            .split(|c: char| !c.is_ascii_alphanumeric())
            .find(|w| w.len() == 10)
            .unwrap()
            .to_owned();
        let (_, board) = agent
            .call(
                &a,
                "create_artboard",
                json!({ "designId": id, "name": "Home", "width": 400, "height": 300 }),
            )
            .await;
        let board = board
            .split('#')
            .nth(1)
            .unwrap()
            .split('.')
            .next()
            .unwrap()
            .to_owned();
        agent
            .call(
                &a,
                "update_styles",
                json!({ "designId": id,
                "updates": [{ "nodeIds": [board], "styles": { "color": "red" } }] }),
            )
            .await;

        // Router A goes away; the same session carries on at router B.
        let (status, undone) = agent.call(&b, "undo", json!({ "designId": id })).await;
        assert_eq!(status, 200);
        assert!(
            undone.contains("Update styles"),
            "B undid A's edit: {undone}"
        );
        let (_, html) = agent
            .call(&b, "get_html", json!({ "designId": id, "nodeId": board }))
            .await;
        assert!(!html.contains("red"), "{html}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn without_a_shared_store_routers_dont_know_each_others_sessions() {
        let (a, b) = two_routers(None).await;
        let mut agent = Session::start(&a).await;
        let (status, _) = agent.call(&b, "list_designs", json!({})).await;
        assert_eq!(status, 404);
    }
}

/// A server sends a design's snapshot as one WebSocket frame, and the router
/// passes on designs larger than tungstenite's default 16 MB frame limit.
#[tokio::test]
async fn the_router_relays_large_designs() {
    use finite_design::edit::{self, NewArtboard, WriteMode};
    use finite_server::hub::Actor;

    let (server, server_url) = listen().await;
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("Big").meta.id;
    let design = hub.get(&id).unwrap();
    let agent = Actor {
        id: "agent:big".into(),
        name: "Big".into(),
    };
    let artboard = NewArtboard {
        name: "Page".into(),
        width: 800.0,
        height: 600.0,
        position: None,
        styles: Default::default(),
    };
    design
        .edit(&agent, "Add page", |doc| {
            Ok((edit::create_artboard(doc, "page".into(), artboard)?, ()))
        })
        .unwrap();
    for i in 0..18 {
        let html = format!("<p>{}</p>", "x".repeat(1 << 20));
        let mut n = 0;
        let mut new_id = || {
            n += 1;
            format!("p{i}-{n}")
        };
        design
            .edit(&agent, "Write", |doc| {
                let (ops, _) =
                    edit::write_html(doc, "page", &html, WriteMode::Append, None, &mut new_id)?;
                Ok((ops, ()))
            })
            .unwrap();
    }
    tokio::spawn(async move { axum::serve(server, app(hub, None)).await });
    let (front, front_url) = listen().await;
    let routes = router::app(vec![server_url], None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    // Like a browser, the test's client takes a frame of any size.
    let url = format!("{front_url}/api/designs/{id}/ws").replacen("http://", "ws://", 1);
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    let (mut socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
        .await
        .unwrap();
    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
        panic!("expected a snapshot");
    };
    assert!(text.len() > 18 << 20);
    let snapshot: Value = serde_json::from_str(text.as_str()).unwrap();
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["snapshot"]["nodes"].as_array().unwrap().len(), 37);
}

/// A stand-in server whose design list socket sends `messages`, 50 ms apart,
/// then stays open.
async fn scripted_lobby(messages: Vec<Value>) -> String {
    use axum::extract::ws::{Message as WsMessage, WebSocketUpgrade};
    let (listener, url) = listen().await;
    let app = axum::Router::new().route(
        "/api/designs/ws",
        axum::routing::get(move |ws: WebSocketUpgrade| {
            let messages = messages.clone();
            async move {
                ws.on_upgrade(move |mut socket| async move {
                    for message in messages {
                        let _ = socket.send(WsMessage::text(message.to_string())).await;
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    std::future::pending::<()>().await;
                })
            }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await });
    url
}

/// A server whose design list socket falls behind sends its full list again.
/// The router replaces only that server's part, so the others' designs stay.
#[tokio::test]
async fn a_server_resending_its_list_keeps_the_others() {
    let design = |id: &str, at: u64| json!({ "id": id, "name": id, "updatedAt": at });
    let list = |designs: Vec<Value>| json!({ "type": "designs", "total": designs.len(), "designs": designs });
    let a = scripted_lobby(vec![
        list(vec![design("a1", 1)]),
        // Fell behind: its whole list again, now with a second design.
        list(vec![design("a1", 1), design("a2", 3)]),
    ])
    .await;
    let b = scripted_lobby(vec![list(vec![design("b1", 2)])]).await;
    let (front, front_url) = listen().await;
    let routes = router::app(vec![a, b], None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    let url = format!("{front_url}/api/designs/ws").replacen("http://", "ws://", 1);
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let mut next = async || loop {
        if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
            break serde_json::from_str::<Value>(text.as_str()).unwrap();
        }
    };
    let ids = |message: &Value| -> Vec<String> {
        message["designs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let first = next().await;
    assert_eq!(ids(&first), ["b1", "a1"]);
    let again = next().await;
    assert_eq!(again["type"], "designs");
    assert_eq!(ids(&again), ["a2", "b1", "a1"], "b1 is still there");
    assert_eq!(again["total"], 3);
}

/// Every server has the same tools, so an agent can list them while the
/// first server is down.
#[tokio::test]
async fn tools_are_listed_while_the_first_server_is_down() {
    use rmcp::{
        ServiceExt,
        transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        },
    };
    let (up, up_url) = listen().await;
    // Port 9 (discard) refuses connections on a normal machine.
    let nodes = vec!["http://127.0.0.1:9".to_owned(), up_url];
    let cluster = Cluster::new(nodes.clone(), 1).unwrap();
    let hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster).unwrap();
    tokio::spawn(async move { axum::serve(up, app(hub, None)).await });
    let (front, front_url) = listen().await;
    let routes = router::app(nodes, None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    let config = StreamableHttpClientTransportConfig::with_uri(format!("{front_url}/mcp"));
    let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert!(tools.iter().any(|t| t.name == "write_html"));
    client.cancel().await.unwrap();
}
