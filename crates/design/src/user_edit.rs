//! Edits people make on the canvas, in the browser.
//!
//! A gesture (a drag, a resize, a key) turns into a few [`UserEdit`]s. Each
//! one states where things end up, never by how much they change, so
//! planning it again on a document an agent has changed since still means
//! what the person saw. [`plan`] turns them into ops. The server runs it
//! as the real edit, and the browser runs the same function through
//! WebAssembly to show the edit before the server answers.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    components,
    document::{Document, Op},
    edit::{self, EditError},
    node::NodeId,
};

/// One thing a person changes. A gesture sends a list of them as one undo step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UserEdit {
    /// Puts artboards at these canvas positions.
    SetPosition {
        moves: Vec<Position>,
    },
    /// Sets inline styles on nodes, or removes a style when its value is `None`.
    SetStyles {
        ids: Vec<NodeId>,
        styles: BTreeMap<String, Option<String>>,
    },
    /// Moves nodes under `parent` (the canvas when `None`), right before
    /// its child `before`, or at the end.
    Place {
        ids: Vec<NodeId>,
        parent: Option<NodeId>,
        before: Option<NodeId>,
    },
    Delete {
        ids: Vec<NodeId>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub id: NodeId,
    pub x: f64,
    pub y: f64,
}

/// The most edits one gesture can send, and nodes one edit can name. A
/// person selects a few things at a time; this bounds what a bad client can
/// make the server plan under the design's lock.
pub const MAX_EDITS: usize = 64;
pub const MAX_IDS: usize = 1_000;

/// Turns a gesture's edits into ops. Every edit is planned against `view`,
/// the document with instances expanded as it was before the gesture, so
/// edits can name nodes inside instances. `components::redirect` then turns
/// changes inside an instance into overrides on it, or refuses them, the
/// way it does for agents.
pub fn plan(
    doc: &Document,
    view: &Document,
    edits: &[UserEdit],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>, EditError> {
    if edits.len() > MAX_EDITS {
        return Err(EditError(format!(
            "a gesture can make at most {MAX_EDITS} edits"
        )));
    }
    let mut ops = Vec::new();
    for user_edit in edits {
        if user_edit.ids().count() > MAX_IDS {
            return Err(EditError(format!(
                "an edit can name at most {MAX_IDS} nodes"
            )));
        }
        ops.extend(match user_edit {
            UserEdit::SetPosition { moves } => {
                let mut ops = Vec::with_capacity(moves.len() * 2);
                for m in moves {
                    if !m.x.is_finite() || !m.y.is_finite() {
                        return Err(EditError(format!("{:?} needs a finite position", m.id)));
                    }
                    ops.extend(edit::set_position(view, &m.id, m.x.round(), m.y.round())?);
                }
                ops
            }
            UserEdit::SetStyles { ids, styles } => edit::update_styles(view, ids, styles)?,
            UserEdit::Place {
                ids,
                parent,
                before,
            } => edit::move_before(view, ids, parent.as_deref(), before.as_deref())?,
            UserEdit::Delete { ids } => edit::delete(view, ids)?,
        });
    }
    components::redirect(doc, ops, new_id)
}

/// What a gesture's edits are called in the activity list and the undo history.
pub fn label(edits: &[UserEdit]) -> &'static str {
    let mut kinds = edits.iter().map(|e| match e {
        UserEdit::SetPosition { .. } | UserEdit::Place { .. } => "Move",
        UserEdit::SetStyles { .. } => "Change styles",
        UserEdit::Delete { .. } => "Delete",
    });
    let first = kinds.next().unwrap_or("Edit");
    if kinds.all(|k| k == first) {
        first
    } else {
        "Edit"
    }
}

impl UserEdit {
    /// The nodes the edit names.
    pub fn ids(&self) -> Box<dyn Iterator<Item = &NodeId> + '_> {
        match self {
            Self::SetPosition { moves } => Box::new(moves.iter().map(|m| &m.id)),
            Self::SetStyles { ids, .. } | Self::Place { ids, .. } | Self::Delete { ids } => {
                Box::new(ids.iter())
            }
        }
    }

    /// One of each kind of edit, for the golden file the web app's schema is
    /// checked against (`fixtures/user_edits.json`).
    pub fn examples() -> Vec<UserEdit> {
        vec![
            Self::SetPosition {
                moves: vec![Position {
                    id: "board".into(),
                    x: 120.0,
                    y: -40.0,
                }],
            },
            Self::SetStyles {
                ids: vec!["card".into()],
                styles: BTreeMap::from([
                    ("left".into(), Some("24px".into())),
                    ("right".into(), None),
                ]),
            },
            Self::Place {
                ids: vec!["card".into()],
                parent: Some("list".into()),
                before: Some("other".into()),
            },
            Self::Place {
                ids: vec!["card".into()],
                parent: None,
                before: None,
            },
            Self::Delete {
                ids: vec!["card".into()],
            },
        ]
    }
}
