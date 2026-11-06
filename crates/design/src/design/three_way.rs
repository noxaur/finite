//! Three-way merge of HTML an agent rewrote, against the changes made since it read.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::{
    ActorId, NodeId,
    comment::{self},
    document::{Document, Op},
    node::PropKey,
};

use super::Design;

/// A rewrite after [`Design::merge`].
#[derive(Debug)]
pub struct Merged {
    pub ops: Vec<Op>,
    /// Values another actor changed after the read, which keep their value.
    pub kept: Vec<Kept>,
    /// Nodes another actor added or moved in after the read, which the
    /// rewrite would have deleted and which stay instead.
    pub kept_nodes: Vec<KeptNode>,
    /// Whether the log reached back to the read. If not, nothing was merged.
    pub reached: bool,
}

/// A value [`Design::merge`] kept: `key` on node `id`, last set by `by`.
#[derive(Clone, Debug, PartialEq)]
pub struct Kept {
    pub id: NodeId,
    pub key: PropKey,
    pub by: ActorId,
    /// The rewrite changed it too, to something else.
    pub conflict: bool,
}

/// A node [`Design::merge`] kept: `id`, added or moved in by `by`.
#[derive(Clone, Debug, PartialEq)]
pub struct KeptNode {
    pub id: NodeId,
    pub by: ActorId,
    /// It existed at the read, somewhere else, and was moved here.
    pub moved: bool,
}

/// The old value of every property each recent change set, and where each
/// node it created, deleted or moved was before, taken from its inverse. In
/// memory only: after a restart a merge can't look back further than the
/// load.
#[derive(Debug, Default)]
pub(super) struct SetLog {
    /// Changes after this seq are all here.
    since: u64,
    entries: VecDeque<Sets>,
    bytes: usize,
}

#[derive(Debug)]
pub(super) struct Sets {
    seq: u64,
    actor: ActorId,
    /// The `Set` ops of the change's inverse, in the inverse's order.
    old: Vec<Op>,
    /// Each node the change created, deleted or moved, and where it was
    /// before: `None` if it didn't exist, else its parent. In the
    /// inverse's order.
    places: Vec<(NodeId, Option<Option<NodeId>>)>,
    bytes: usize,
}

impl SetLog {
    /// How many changes it keeps, as many as the change log.
    const LIMIT: usize = comment::LOG_LIMIT;
    /// About how many bytes of values it keeps.
    const BYTE_LIMIT: usize = 8 << 20;

    pub(super) fn starting_at(seq: u64) -> Self {
        Self {
            since: seq,
            ..Self::default()
        }
    }

    pub(super) fn record(&mut self, seq: u64, actor: &str, inverse: &[Op]) {
        let Some(sets) = Sets::of(seq, actor, inverse) else {
            return;
        };
        self.bytes += sets.bytes;
        self.entries.push_back(sets);
        while self.entries.len() > Self::LIMIT || self.bytes > Self::BYTE_LIMIT {
            let Some(dropped) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= dropped.bytes;
            self.since = dropped.seq;
        }
    }
}

impl Sets {
    /// What a change with this inverse set and placed, or `None` if it did neither.
    pub(super) fn of<'a>(
        seq: u64,
        actor: &str,
        inverse: impl IntoIterator<Item = &'a Op>,
    ) -> Option<Self> {
        let mut old = Vec::new();
        let mut places = Vec::new();
        for op in inverse {
            match op {
                Op::Set { .. } => old.push(op.clone()),
                // Undoing a create deletes it, so it didn't exist before.
                Op::Delete { id } => places.push((id.clone(), None)),
                Op::Create { node } => places.push((node.id.clone(), Some(node.parent.clone()))),
                Op::Move { id, parent, .. } => places.push((id.clone(), Some(parent.clone()))),
                _ => {}
            }
        }
        if old.is_empty() && places.is_empty() {
            return None;
        }
        let bytes = old.iter().map(Op::size).sum::<usize>()
            + places
                .iter()
                .map(|(id, parent)| {
                    32 + id.len()
                        + parent
                            .as_ref()
                            .and_then(Option::as_ref)
                            .map_or(0, String::len)
                })
                .sum::<usize>();
        Some(Self {
            seq,
            actor: actor.to_owned(),
            old,
            places,
            bytes,
        })
    }
}

impl Design {
    /// Three-way merges a rewrite of HTML read when the design was at
    /// `read_at`. `ops` are what the rewrite would do to the document as it
    /// is now, so each `Set` changes a value the HTML differs in. A value
    /// that was changed since the read is the base's old value in the HTML,
    /// unless the rewrite changed it too:
    ///
    /// - The HTML has the value as it was at the read: the author didn't
    ///   change it, so the newer one stays and the `Set` is dropped.
    /// - The HTML changed it, and so did another actor since: theirs stays.
    /// - The HTML changed it, and `actor` made the last change since: the rewrite wins.
    ///
    /// Values kept from another actor are listed in [`Merged::kept`], so the
    /// author knows and can set one again on purpose.
    ///
    /// A `Delete` of a node the HTML left out is dropped when the node
    /// wasn't under its parent at the read: another actor created it or
    /// moved it there since, so the HTML couldn't hold it. Those nodes stay
    /// where they are and are listed in [`Merged::kept_nodes`]. Nodes
    /// `actor` added or moved in since follow the HTML. Other moves and
    /// creates are kept as they are. If the log no longer reaches back to
    /// `read_at`, the ops are returned unchanged with [`Merged::reached`] false.
    pub fn merge(&self, actor: &str, read_at: u64, ops: Vec<Op>) -> Merged {
        merge(&self.sets, None, &self.doc, actor, read_at, ops)
    }
}

/// [`Design::merge`] over the changes in `sets`, then the one being staged
/// in `staged`, against `doc`.
pub(super) fn merge(
    sets: &SetLog,
    staged: Option<&Sets>,
    doc: &Document,
    actor: &str,
    read_at: u64,
    mut ops: Vec<Op>,
) -> Merged {
    if read_at < sets.since {
        return Merged {
            ops,
            kept: Vec::new(),
            kept_nodes: Vec::new(),
            reached: false,
        };
    }
    // Each value set since the read: its value at the read, and who set it last.
    let mut changed: HashMap<(&str, &PropKey), (&Option<serde_json::Value>, &str)> = HashMap::new();
    let first = sets.entries.partition_point(|e| e.seq <= read_at);
    // Each node the rewrite deletes that was created, deleted or moved
    // since the read: where it was at the read, and who placed it last.
    let deleted: HashSet<&str> = ops
        .iter()
        .filter_map(|op| match op {
            Op::Delete { id } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    let mut placed: HashMap<&str, (&Option<Option<NodeId>>, &str)> = HashMap::new();
    for entry in sets.entries.range(first..).chain(staged) {
        // Backwards for the same reason as values below.
        for (id, before) in entry.places.iter().rev() {
            if deleted.contains(id.as_str()) {
                placed
                    .entry(id.as_str())
                    .or_insert((before, &entry.actor))
                    .1 = &entry.actor;
            }
        }
        // An inverse runs backwards, so its last op on a value holds
        // what the value was before the change.
        for op in entry.old.iter().rev() {
            if let Op::Set { id, key, value } = op {
                changed
                    .entry((id.as_str(), key))
                    .or_insert((value, &entry.actor))
                    .1 = &entry.actor;
            }
        }
    }
    let mut kept = Vec::new();
    if !changed.is_empty() {
        ops.retain(|op| {
            let Op::Set { id, key, value } = op else {
                return true;
            };
            let Some(&(base, by)) = changed.get(&(id.as_str(), key)) else {
                return true;
            };
            let conflict = base != value;
            if by == actor {
                return conflict;
            }
            kept.push(Kept {
                id: id.clone(),
                key: key.clone(),
                by: by.to_owned(),
                conflict,
            });
            false
        });
    }
    let mut kept_nodes = Vec::new();
    if !placed.is_empty() {
        ops.retain(|op| {
            let Op::Delete { id } = op else { return true };
            let Some(&(before, by)) = placed.get(id.as_str()) else {
                return true;
            };
            let Some(now) = doc.get(id) else {
                return true;
            };
            let here = before.as_ref() == Some(&now.parent);
            if here || by == actor {
                return true;
            }
            kept_nodes.push(KeptNode {
                id: id.clone(),
                by: by.to_owned(),
                moved: before.is_some(),
            });
            false
        });
    }
    Merged {
        ops,
        kept,
        kept_nodes,
        reached: true,
    }
}
