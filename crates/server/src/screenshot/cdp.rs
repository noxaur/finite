//! A minimal Chrome DevTools Protocol client: start a headless Chrome, open
//! one tab, and send it commands. Screenshots need more than Chrome's
//! `--screenshot` flag offers (cropping to an element, measuring layout,
//! several captures per page), and the protocol has all of it.
//!
//! Commands go out one at a time and wait for their reply. Events that
//! arrive meanwhile are kept, so [`Tab::wait_for`] still sees an event that
//! fired during an earlier command.

use std::{path::PathBuf, process::Stdio, time::Duration};

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

/// How long Chrome may take to start and print its DevTools address.
const STARTUP: Duration = Duration::from_secs(15);
/// How long one command may take, such as a capture of a large page.
const COMMAND: Duration = Duration::from_secs(30);

/// A running headless Chrome, killed when dropped.
pub struct Browser {
    child: Child,
    dir: PathBuf,
}

impl Drop for Browser {
    fn drop(&mut self) {
        // Stop Chrome before removing its profile, so it can't write it back.
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// One page in a [`Browser`], attached with a flat session.
pub struct Tab {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    session: String,
    next_id: u64,
    events: Vec<(String, Value)>,
}

impl Browser {
    /// Starts `chrome` with a fresh profile in `dir` and opens a blank tab.
    pub async fn launch(chrome: &std::path::Path, dir: PathBuf) -> Result<(Self, Tab), String> {
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        let mut child = Command::new(chrome)
            .arg("--headless")
            .arg("--disable-gpu")
            .arg("--hide-scrollbars")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--mute-audio")
            .arg("--disable-extensions")
            .arg("--disable-background-networking")
            .arg("--disable-sync")
            .arg(format!("--user-data-dir={}", dir.join("profile").display()))
            // Port 0 picks a free port; Chrome prints the address it chose.
            .arg("--remote-debugging-port=0")
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("couldn't start the browser: {e}"))?;
        let stderr = child.stderr.take().expect("stderr is piped");
        let browser = Self { child, dir };
        let mut lines = BufReader::new(stderr).lines();
        // Chrome's last lines, to say why it failed if it does.
        let mut log = std::collections::VecDeque::new();
        let started = tokio::time::timeout(STARTUP, async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = line.strip_prefix("DevTools listening on ") {
                    return Some(url.trim().to_owned());
                }
                if log.len() == 5 {
                    log.pop_front();
                }
                log.push_back(line);
            }
            None
        })
        .await;
        let said = || {
            let lines: Vec<_> = log.iter().map(|l| l.trim()).collect();
            if lines.is_empty() {
                String::new()
            } else {
                format!(". It said: {}", lines.join(" | "))
            }
        };
        let endpoint = match started {
            Ok(Some(endpoint)) => endpoint,
            Ok(None) => return Err(format!("the browser exited before it was ready{}", said())),
            Err(_) => return Err(format!("the browser took too long to start{}", said())),
        };
        // Keep reading Chrome's log so a full pipe never blocks it.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(None)
            .max_frame_size(None);
        let (ws, _) = tokio_tungstenite::connect_async_with_config(endpoint, Some(config), false)
            .await
            .map_err(|e| format!("couldn't connect to the browser: {e}"))?;
        let mut tab = Tab {
            ws,
            session: String::new(),
            next_id: 1,
            events: Vec::new(),
        };
        let target = tab
            .browser_call("Target.createTarget", json!({ "url": "about:blank" }))
            .await?;
        let target_id = target["targetId"]
            .as_str()
            .ok_or("no target id")?
            .to_owned();
        let attached = tab
            .browser_call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        tab.session = attached["sessionId"]
            .as_str()
            .ok_or("no session id")?
            .to_owned();
        Ok((browser, tab))
    }

    /// Asks Chrome to quit, and waits a moment for it to. Chrome then stops
    /// its helper processes too; killing only the main process can leave
    /// them running on Linux.
    pub async fn close(mut self, mut tab: Tab) {
        let _ = tab.browser_call("Browser.close", json!({})).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}

impl Tab {
    /// Sends a command to the page and returns its result.
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let session = self.session.clone();
        self.send(method, params, Some(&session)).await
    }

    async fn browser_call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.send(method, params, None).await
    }

    async fn send(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.ws
            .send(Message::text(message.to_string()))
            .await
            .map_err(|e| format!("lost the browser: {e}"))?;
        tokio::time::timeout(COMMAND, async {
            loop {
                let message = self.receive().await?;
                if message["id"].as_u64() == Some(id) {
                    if let Some(error) = message.get("error") {
                        let text = error["message"].as_str().unwrap_or("unknown error");
                        return Err(format!("{method}: {text}"));
                    }
                    return Ok(message["result"].clone());
                }
                self.keep(message);
            }
        })
        .await
        .map_err(|_| format!("the browser didn't answer {method} in time"))?
    }

    /// Waits for the page event `method`, or for `timeout` to pass.
    /// Returns whether it arrived. Events seen earlier count, and are consumed.
    pub async fn wait_for(&mut self, method: &str, timeout: Duration) -> Result<bool, String> {
        if let Some(i) = self.events.iter().position(|(m, _)| m == method) {
            self.events.remove(i);
            return Ok(true);
        }
        let waited = tokio::time::timeout(timeout, async {
            loop {
                let message = self.receive().await?;
                if message["method"] == method && message["sessionId"] == self.session.as_str() {
                    return Ok::<_, String>(());
                }
                self.keep(message);
            }
        })
        .await;
        match waited {
            Ok(result) => result.map(|()| true),
            Err(_) => Ok(false),
        }
    }

    /// Forgets the events seen so far, before an action whose events matter.
    pub fn clear_events(&mut self) {
        self.events.clear();
    }

    /// Evaluates `expression` in the page, awaiting it if it's a promise, and
    /// returns its value. A thrown exception is an error.
    pub async fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            let text = exception["exception"]["description"]
                .as_str()
                .or(exception["text"].as_str())
                .unwrap_or("the script threw");
            return Err(text.to_owned());
        }
        Ok(result["result"]["value"].clone())
    }

    fn keep(&mut self, message: Value) {
        if let Some(method) = message["method"].as_str()
            && message["sessionId"] == self.session.as_str()
        {
            // Only page events are waited for; a page that logs a lot shouldn't fill memory.
            if self.events.len() < 1000 {
                self.events
                    .push((method.to_owned(), message["params"].clone()));
            }
        }
    }

    async fn receive(&mut self) -> Result<Value, String> {
        loop {
            let message = self
                .ws
                .next()
                .await
                .ok_or("the browser closed the connection")?
                .map_err(|e| format!("lost the browser: {e}"))?;
            if let Message::Text(text) = message {
                return serde_json::from_str(&text).map_err(|e| e.to_string());
            }
        }
    }
}
