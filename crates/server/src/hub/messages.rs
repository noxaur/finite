//! What the hub tells viewers: who's acting, who's working on what, and the
//! messages sent on a design's WebSocket and on the design list's.

use finite_design::{ActorId, Change, Design, DesignMeta, NodeId, Snapshot, comment::Comment};
use serde::{Deserialize, Serialize};

/// The id prefix of an agent known only by its MCP session on this server.
/// Sessions live in memory, so such an agent never comes back once its
/// session ends or the server restarts.
pub const SESSION_ACTOR: &str = "mcp:";

/// Whoever is making a change, with a name to show in the UI.
#[derive(Clone, Debug, Serialize)]
pub struct Actor {
    pub id: ActorId,
    pub name: String,
}

/// Names one mutation a browser tab sent: the tab's random `client` id
/// and the tab's counter. A change made by a mutation carries its stamp, so
/// the tab that sent it knows the change is its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub client: String,
    pub mid: u64,
}

/// Shows what an actor is working on, like an agent's indicator on an artboard.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub actor: ActorId,
    pub name: String,
    pub node_ids: Vec<NodeId>,
    pub status: Option<String>,
    pub updated_at: u64,
    /// Set by an edit rather than by start_working_on_nodes, so it expires
    /// sooner: the agent never said it was done.
    #[serde(skip)]
    pub automatic: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSummary {
    #[serde(flatten)]
    pub meta: DesignMeta,
    pub seq: u64,
    pub artboard_count: usize,
    pub node_count: usize,
}

impl DesignSummary {
    pub(super) fn of(design: &Design) -> Self {
        Self {
            meta: design.meta.clone(),
            seq: design.seq(),
            artboard_count: design.doc().artboards().len(),
            node_count: design.doc().len(),
        }
    }
}

/// Messages pushed to design viewers over WebSocket.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DesignMessage<'a> {
    Snapshot {
        snapshot: &'a Snapshot,
        presence: Vec<&'a Presence>,
        /// Names this load of the design. A viewer that reconnects sends it
        /// back with its `seq` to resume (see [`super::Since`]).
        epoch: &'a str,
    },
    /// Sent instead of a snapshot to a viewer that reconnects within the same
    /// epoch, while the server still has every change it missed.
    Resume {
        changes: Vec<Missed<'a>>,
        comments: &'a [Comment],
        presence: Vec<&'a Presence>,
        meta: &'a DesignMeta,
    },
    Change {
        change: &'a Change,
        /// Display name of `change.actor`.
        actor_name: &'a str,
        /// The mutation that made the change, when a person's tab sent it.
        #[serde(skip_serializing_if = "Option::is_none")]
        mutation: Option<&'a Stamp>,
    },
    /// Sent only to the tab that sent mutation `mid`, when it changed
    /// nothing: `error` says why it was refused, or is `None` when the
    /// design already looked like that. `seq` is the design's seq when it
    /// ran, so the tab first applies every change before it.
    Settled {
        mid: u64,
        seq: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Presence {
        presence: Vec<&'a Presence>,
    },
    Meta {
        meta: &'a DesignMeta,
    },
    /// A comment was created or its thread changed. Replaces any comment with the same id.
    Comment {
        comment: &'a Comment,
    },
    /// A person deleted a comment and its thread.
    CommentDeleted {
        id: &'a str,
    },
}

/// A change a reconnecting viewer missed, as its `change` message had it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Missed<'a> {
    pub change: &'a Change,
    pub actor_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutation: Option<&'a Stamp>,
}

/// Messages pushed to the design list over WebSocket.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LobbyMessage<'a> {
    /// The most recently edited designs, at most `LOBBY_LIMIT`, and how
    /// many there are in all. Search finds the rest (`GET /api/designs?q=`).
    Designs {
        designs: &'a [DesignSummary],
        total: usize,
    },
    Design {
        design: &'a DesignSummary,
    },
}

/// A serialized message. `seq` is set for changes, so a subscriber can drop
/// the ones already included in the snapshot it started from.
#[derive(Clone, Debug)]
pub struct Outgoing {
    pub seq: Option<u64>,
    /// The message as JSON, once for every socket. It's reference-counted
    /// bytes, so sending it to a socket doesn't copy it: a 15 MB change sent
    /// to ten viewers used to be ten 15 MB copies.
    pub json: axum::extract::ws::Utf8Bytes,
}

impl Outgoing {
    pub(super) fn new(seq: Option<u64>, message: &impl Serialize) -> Self {
        let json = serde_json::to_string(message).expect("messages serialize");
        Self {
            seq,
            json: json.into(),
        }
    }
}
