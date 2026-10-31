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
    }

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
        client.cancel().await.unwrap();
    }

    /// A server on its own runtime, so stopping it drops every connection at
    /// once, the way a crash would.
    struct Node {
        runtime: Option<tokio::runtime::Runtime>,
        hub: Arc<Hub>,
    }

    impl Node {
        fn start(listener: std::net::TcpListener, cluster: Cluster, store: Arc<MemoryStore>) -> Self {
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
