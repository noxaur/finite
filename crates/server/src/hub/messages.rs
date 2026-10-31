//! What the hub tells viewers: who's acting, who's working on what, and the
//! messages sent on a design's WebSocket and on the design list's.

use std::sync::Arc;

use finite_design::{ActorId, Change, Design, DesignMeta, NodeId, Snapshot, comment::Comment};
use serde::Serialize;

/// Whoever is making a change, with a name to show in the UI.
#[derive(Clone, Debug, Serialize)]
pub struct Actor {
    pub id: ActorId,
    pub name: String,
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
    },
    Change {
        change: &'a Change,
        /// Display name of `change.actor`.
        actor_name: &'a str,
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
}

/// Messages pushed to the design list over WebSocket.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LobbyMessage<'a> {
    Designs { designs: &'a [DesignSummary] },
    Design { design: &'a DesignSummary },
}

/// A serialized message. `seq` is set for changes, so a subscriber can drop
/// the ones already included in the snapshot it started from.
#[derive(Clone, Debug)]
pub struct Outgoing {
    pub seq: Option<u64>,
    pub json: Arc<str>,
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
