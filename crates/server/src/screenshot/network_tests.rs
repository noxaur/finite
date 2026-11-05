//! A captured page can't reach internal addresses, and only an explicit
//! allowance in a test lets it reach a local server. Needs Chrome (or
//! FINITE_CHROME); without one, each test says so and passes.

use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use finite_design::{Document, html};

use super::{Options, Policy, Shot, capture_with, plan};

/// A local server that counts the connections it is offered.
struct Probe {
    addr: SocketAddr,
    hits: Arc<AtomicUsize>,
}

impl Probe {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                // Closed at once: the page gets a failed request.
                drop(stream);
            }
        });
        Self { addr, hits }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

fn artboard(body: &str) -> (Document, String) {
    let mut ops = Vec::new();
    let mut n = 0;
    html::parse(body).unwrap().remove(0).create_ops(
        None,
        "V".into(),
        Some((0.0, 0.0)),
        &mut || {
            n += 1;
            format!("n{n}")
        },
        &mut ops,
    );
    let mut doc = Document::default();
    doc.apply_all(&ops);
    (doc, "n1".to_owned())
}

/// Captures the artboard, returning false when there's no browser.
async fn run(body: &str, policy: Policy) -> bool {
    let (doc, board) = artboard(body);
    let options = Options {
        settle: Duration::from_millis(1500),
        ..Default::default()
    };
    let plan = plan(&doc, vec![Shot::node(board)], options).unwrap();
    match capture_with(plan, policy).await {
        Ok(images) => {
            images.into_iter().for_each(|i| {
                i.unwrap();
            });
            true
        }
        Err(error) if error.contains("no Chrome") => {
            eprintln!("skipped: {error}");
            false
        }
        Err(error) => panic!("{error}"),
    }
}

/// An artboard that tries every way a page has to reach `addr`: an image,
/// `fetch`, a WebSocket, a stylesheet and a font.
fn reaching(host: &str, port: u16) -> String {
    format!(
        r#"<div data-name="Board" style="width: 100px; height: 100px"><img src="http://{host}:{port}/a.png" width="10" height="10"><img src="https://{host}:{port}/b.png" width="10" height="10"><div style="width: 10px; height: 10px; background: url(https://{host}:{port}/c.png)"></div><script>
fetch("https://{host}:{port}/").catch(() => {{}});
try {{ new WebSocket("wss://{host}:{port}/"); }} catch (e) {{}}
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = "https://{host}:{port}/d.css";
document.head.append(css);
const s = document.createElement("script");
s.src = "https://{host}:{port}/e.js";
document.head.append(s);
</script></div>"#
    )
}

#[tokio::test]
async fn pages_cannot_reach_a_local_server() {
    let probe = Probe::start().await;
    let port = probe.addr.port();
    for host in [
        "127.0.0.1",
        "localhost",
        "[::1]",
        "0.0.0.0",
        "127.1",
        "2130706433",
    ] {
        if !run(&reaching(host, port), Policy::default()).await {
            return;
        }
        assert_eq!(probe.hits(), 0, "{host} reached the local server");
    }
}

#[tokio::test]
async fn pages_cannot_reach_a_local_server_without_scripts() {
    let probe = Probe::start().await;
    let body = format!(
        r#"<div data-name="Board" style="width: 100px; height: 100px"><img src="http://127.0.0.1:{0}/a.png"><img src="https://127.0.0.1:{0}/b.png"><div style="background: url(http://localhost:{0}/c.png); width: 10px; height: 10px"></div></div>"#,
        probe.addr.port()
    );
    if !run(&body, Policy::default()).await {
        return;
    }
    assert_eq!(probe.hits(), 0);
}

#[tokio::test]
async fn an_explicit_allowance_reaches_the_server_through_the_proxy() {
    // The control: the same pages do connect once the test allows the address,
    // so the zero above is the proxy refusing and not the page failing.
    let probe = Probe::start().await;
    let policy = Policy {
        allow: vec![probe.addr],
    };
    if !run(&reaching("127.0.0.1", probe.addr.port()), policy).await {
        return;
    }
    assert!(probe.hits() > 0, "the allowed server saw nothing");
}
