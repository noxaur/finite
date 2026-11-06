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
    id,
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
    /// Copies nodes, each right after its original. A copied artboard goes
    /// in free space on its page.
    Duplicate {
        ids: Vec<NodeId>,
    },
    /// Wraps sibling nodes in a new `<div>`, where the first of them was.
    Group {
        ids: Vec<NodeId>,
    },
    /// Puts each node's children in its place and deletes it.
    Ungroup {
        ids: Vec<NodeId>,
    },
    /// Replaces the text of a text node, or of an element holding only text.
    SetText {
        id: NodeId,
        text: String,
    },
    /// Makes an element a component, which instances can follow.
    MakeComponent {
        id: NodeId,
        name: Option<String>,
    },
    /// Turns instances into plain copies of what they show.
    Detach {
        ids: Vec<NodeId>,
    },
    /// Points links (`<a>`) at the artboard `to`, or takes their `href`
    /// away when it's `None`.
    SetLink {
        ids: Vec<NodeId>,
        to: Option<NodeId>,
    },
    /// Puts an artboard on a route, or on one made from its name when `None`.
    SetRoute {
        id: NodeId,
        route: Option<String>,
    },
    /// Sets attributes on elements, or removes one when its value is
    /// `None`. A person renames a layer with `data-name`, hides it with
    /// `hidden` and locks it with `data-locked`.
    SetAttributes {
        ids: Vec<NodeId>,
        attrs: BTreeMap<String, Option<String>>,
    },
    /// Adds a page after the others, with an id made like a new node's.
    CreatePage {
        name: String,
    },
    RenamePage {
        id: String,
        name: String,
    },
    /// Deletes a page and every artboard on it.
    DeletePage {
        id: String,
    },
    /// Moves artboards to another page, into free space there.
    MoveToPage {
        ids: Vec<NodeId>,
        page: String,
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
/// The longest text a person can type into one node.
pub const MAX_TEXT: usize = 100_000;

/// Ids for the nodes a tab's mutation `mid` makes, like a duplicate's. The
/// tab and the server make the same ones from the tab's stamp, so a person
/// can select a copy and keep editing it before the server answers. An id
/// the document already has is skipped.
pub fn new_ids<'a>(doc: &'a Document, client: &str, mid: u64) -> impl FnMut() -> NodeId + 'a {
    // FNV-1a: plain arithmetic, so the server and WebAssembly agree.
    let fnv = |h: u64, bytes: &[u8]| {
        bytes
            .iter()
            .fold(h, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
    };
    let seed = fnv(
        fnv(0xcbf2_9ce4_8422_2325, client.as_bytes()),
        &mid.to_le_bytes(),
    );
    let mut n = 0_u64;
    let alphabet = id::ALPHABET;
    let mut make = move || {
        n += 1;
        let mut h = fnv(seed, &n.to_le_bytes());
        (0..id::LEN)
            .map(|_| {
                let c = alphabet[(h % alphabet.len() as u64) as usize] as char;
                h /= alphabet.len() as u64;
                c
            })
            .collect::<String>()
    };
    move || id::fresh(&mut make, |id| doc.contains(id))
}

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
            UserEdit::Duplicate { ids } => edit::duplicate(view, ids, new_id)?.0,
            UserEdit::Group { ids } => edit::group(view, ids, new_id)?.0,
            UserEdit::Ungroup { ids } => edit::ungroup(view, ids)?,
            UserEdit::SetText { id, text } => {
                if text.len() > MAX_TEXT {
                    return Err(EditError(format!("text can be at most {MAX_TEXT} bytes")));
                }
                edit::set_text(view, id, text, new_id)?
            }
            UserEdit::MakeComponent { id, name } => {
                edit::create_component(view, id, name.as_deref(), &[])?
            }
            UserEdit::Detach { ids } => edit::detach_instances(view, ids, new_id)?,
            UserEdit::SetLink { ids, to } => edit::set_link(view, ids, to.as_deref())?,
            UserEdit::SetRoute { id, route } => edit::set_route(view, id, route.as_deref())?,
            UserEdit::SetAttributes { ids, attrs } => {
                if attrs.values().flatten().any(|v| v.len() > MAX_TEXT) {
                    return Err(EditError(format!(
                        "an attribute can be at most {MAX_TEXT} bytes"
                    )));
                }
                edit::update_attributes(view, ids, attrs)?
            }
            UserEdit::CreatePage { name } => {
                let id = id::fresh(new_id, |id| view.page(id).is_some());
                edit::create_page(view, id, name)?
            }
            UserEdit::RenamePage { id, name } => edit::rename_page(view, id, name)?,
            UserEdit::DeletePage { id } => edit::delete_page(view, id)?,
            UserEdit::MoveToPage { ids, page } => edit::move_to_page(view, ids, page)?,
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
        UserEdit::Duplicate { .. } => "Duplicate",
        UserEdit::Group { .. } => "Group",
        UserEdit::Ungroup { .. } => "Ungroup",
        UserEdit::SetText { .. } => "Edit text",
        UserEdit::MakeComponent { .. } => "Make component",
        UserEdit::Detach { .. } => "Detach instance",
        UserEdit::SetLink { .. } => "Link",
        UserEdit::SetRoute { .. } => "Set route",
        UserEdit::SetAttributes { attrs, .. } => attributes_label(attrs),
        UserEdit::CreatePage { .. } => "Add page",
        UserEdit::RenamePage { .. } => "Rename page",
        UserEdit::DeletePage { .. } => "Delete page",
        UserEdit::MoveToPage { .. } => "Move to page",
    });
    let first = kinds.next().unwrap_or("Edit");
    if kinds.all(|k| k == first) {
        first
    } else {
        "Edit"
    }
}

/// What setting `attrs` does, in the words of the layers panel's buttons.
fn attributes_label(attrs: &BTreeMap<String, Option<String>>) -> &'static str {
    let mut keys = attrs.iter();
    match (keys.next(), keys.next()) {
        (Some((key, value)), None) => match (key.as_str(), value.is_some()) {
            ("data-name", _) => "Rename",
            ("hidden", true) => "Hide",
            ("hidden", false) => "Show",
            ("data-locked", true) => "Lock",
            ("data-locked", false) => "Unlock",
            _ => "Change attributes",
        },
        _ => "Change attributes",
    }
}

impl UserEdit {
    /// The nodes the edit names.
    pub fn ids(&self) -> Box<dyn Iterator<Item = &NodeId> + '_> {
        match self {
            Self::SetPosition { moves } => Box::new(moves.iter().map(|m| &m.id)),
            Self::SetStyles { ids, .. }
            | Self::Place { ids, .. }
            | Self::Delete { ids }
            | Self::Duplicate { ids }
            | Self::Group { ids }
            | Self::Ungroup { ids }
            | Self::Detach { ids }
            | Self::SetLink { ids, .. }
            | Self::SetAttributes { ids, .. }
            | Self::MoveToPage { ids, .. } => Box::new(ids.iter()),
            Self::CreatePage { .. } | Self::RenamePage { .. } | Self::DeletePage { .. } => {
                Box::new(std::iter::empty())
            }
            Self::SetText { id, .. }
            | Self::MakeComponent { id, .. }
            | Self::SetRoute { id, .. } => Box::new(std::iter::once(id)),
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
            Self::Duplicate {
                ids: vec!["card".into()],
            },
            Self::Group {
                ids: vec!["card".into(), "other".into()],
            },
            Self::Ungroup {
                ids: vec!["group".into()],
            },
            Self::SetText {
                id: "title".into(),
                text: "Hello".into(),
            },
            Self::MakeComponent {
                id: "card".into(),
                name: Some("Card".into()),
            },
            Self::Detach {
                ids: vec!["instance".into()],
            },
            Self::SetLink {
                ids: vec!["button".into()],
                to: Some("board".into()),
            },
            Self::SetLink {
                ids: vec!["button".into()],
                to: None,
            },
            Self::SetRoute {
                id: "board".into(),
                route: Some("/checkout".into()),
            },
            Self::SetRoute {
                id: "board".into(),
                route: None,
            },
            Self::SetAttributes {
                ids: vec!["card".into()],
                attrs: BTreeMap::from([
                    ("hidden".into(), Some(String::new())),
                    ("data-locked".into(), None),
                ]),
            },
            Self::CreatePage {
                name: "Flows".into(),
            },
            Self::RenamePage {
                id: "page".into(),
                name: "Drafts".into(),
            },
            Self::DeletePage { id: "page".into() },
            Self::MoveToPage {
                ids: vec!["board".into()],
                page: "page".into(),
            },
        ]
    }
}
