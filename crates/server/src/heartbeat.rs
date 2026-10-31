//! Pings for the browser's WebSockets.
//!
//! A laptop that goes to sleep or changes networks can leave a **half-open**
//! connection: the server's end looks open, but nothing reaches the browser,
//! and no close ever arrives. Such a socket would hold its design in memory
//! for good, since a design only unloads once nobody is subscribed. So every
//! socket that faces a browser pings it every [`PING_EVERY`]. Browsers answer
//! pings by themselves, and a socket that hears nothing for [`SILENT_FOR`]
//! closes.
//!
//! Pings also keep proxies such as nginx, which close connections that are
//! quiet for a minute by default, from cutting off a viewer of a quiet design.
//!
//! Browsers can't see those pings, though, so they can't tell a dead
//! connection from a quiet design. So the web app also sends [`PING`] as a
//! message, and the server answers [`PONG`]. If the answer doesn't come, the
//! app reconnects (`socket.ts`).

use std::time::Duration;

use futures::{Sink, SinkExt};
use tokio::time::{Instant, Interval, MissedTickBehavior};

/// The web app's ping, and the server's answer.
pub const PING: &str = r#"{"type":"ping"}"#;
pub const PONG: &str = r#"{"type":"pong"}"#;

pub const PING_EVERY: Duration = Duration::from_secs(20);
pub const SILENT_FOR: Duration = Duration::from_secs(60);

pub struct Heartbeat {
    ticks: Interval,
    heard: Instant,
}

impl Heartbeat {
    pub fn new() -> Self {
        let mut ticks = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Self {
            ticks,
            heard: Instant::now(),
        }
    }

    /// Call on every frame from the browser, pongs included.
    pub fn heard(&mut self) {
        self.heard = Instant::now();
    }

    /// Waits until it's time to ping. Returns `false` instead if the browser
    /// has been silent for too long and the socket should close.
    pub async fn tick(&mut self) -> bool {
        self.ticks.tick().await;
        self.heard.elapsed() < SILENT_FOR
    }
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
    }
}

/// Sends one message, and says whether it went. Gives up after
/// [`SILENT_FOR`]: a browser that stopped reading fills the connection's
/// buffers, and then a plain send waits forever.
pub async fn send<S, M>(sink: &mut S, message: M) -> bool
where
    S: Sink<M> + Unpin,
{
    matches!(
        tokio::time::timeout(SILENT_FOR, sink.send(message)).await,
        Ok(Ok(()))
    )
}
