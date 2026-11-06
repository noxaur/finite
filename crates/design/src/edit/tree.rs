//! Deleting, moving, grouping and duplicating nodes.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use crate::{
    components::{self},
    document::{Document, MAX_DEPTH, Op},
    flow, fractional,
    html::Fragment,
    node::{Node, NodeId, NodeKind, PropKey},
};

use super::Placer;
use super::{Result, element, err, node, room_for};

/// Drops ids nested inside other ids in the list, so a subtree is handled once.
/// The ids in `ids` with none of their ancestors in `ids`, in order, each
/// once. Each node walks up its ancestors (at most `MAX_DEPTH`) instead of
/// being compared with every other id, which was quadratic.
pub(super) fn top_level<'a>(doc: &Document, ids: &'a [NodeId]) -> Vec<&'a NodeId> {
    let given: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter(|id| {
            let mut parent = doc.get(id).and_then(|n| n.parent.as_deref());
            while let Some(p) = parent {
                if given.contains(p) {
                    return false;
                }
                parent = doc.get(p).and_then(|n| n.parent.as_deref());
            }
            true
        })
        .collect()
}

pub fn delete(doc: &Document, ids: &[NodeId]) -> Result<Vec<Op>> {
    for id in ids {
        node(doc, id)?;
    }
    Ok(top_level(doc, ids)
        .into_iter()
        .map(|id| Op::Delete { id: id.clone() })
        .collect())
}

/// Moves nodes under `parent` at `index` (append when `None`), keeping their
/// relative order. With `parent: None` the nodes become artboards.
pub fn move_nodes(
    doc: &Document,
    ids: &[NodeId],
    parent: Option<&str>,
    index: Option<usize>,
) -> Result<Vec<Op>> {
    check_move(doc, ids, parent)?;
    let ids = top_level(doc, ids);
    let indexes = doc.insertion_indexes(parent, index, ids.len());
    move_to(doc, ids, parent, indexes)
}

/// Moves nodes under `parent`, right before its child `before` (at the end
/// when `None`, or when `before` isn't one of its children any more),
/// keeping their relative order. Naming a sibling instead of a position
/// means a sibling another actor adds meanwhile can't shift where they land.
pub fn move_before(
    doc: &Document,
    ids: &[NodeId],
    parent: Option<&str>,
    before: Option<&str>,
) -> Result<Vec<Op>> {
    check_move(doc, ids, parent)?;
    let ids = top_level(doc, ids);
    // The moved nodes leave their places first, so they never anchor themselves.
    let siblings: Vec<&Node> = doc
        .children(parent)
        .into_iter()
        .filter(|n| !ids.iter().any(|id| **id == n.id))
        .collect();
    let at = before
        .and_then(|b| siblings.iter().position(|n| n.id == b))
        .unwrap_or(siblings.len());
    let prev = at.checked_sub(1).map(|i| siblings[i].index.as_str());
    let next = siblings.get(at).map(|n| n.index.as_str());
    let indexes = fractional::keys_between(prev, next, ids.len());
    move_to(doc, ids, parent, indexes)
}

/// Refuses a move of `ids` under `parent` that would make a cycle, pass
/// the depth limit or put an instance inside its own component.
fn check_move(doc: &Document, ids: &[NodeId], parent: Option<&str>) -> Result<()> {
    if let Some(parent) = parent {
        element(doc, parent)?;
    }
    for id in ids {
        let n = node(doc, id)?;
        if parent == Some(id.as_str()) || parent.is_some_and(|p| doc.is_ancestor(id, p)) {
            return err(format!("can't move {id:?} into itself"));
        }
        if parent.is_none() && n.kind == NodeKind::Text {
            return err(format!("text node {id:?} can't become an artboard"));
        }
        let depth = parent.map_or(0, |p| doc.depth(p) + 1) + doc.height(id);
        if depth > MAX_DEPTH {
            return err(format!(
                "moving {id:?} there would nest {depth} levels deep; the limit is {MAX_DEPTH}"
            ));
        }
        // An instance can't end up inside the component it shows.
        if doc.has_instances() {
            for inner in doc.subtree(id) {
                if let Some(component) = &inner.instance_of {
                    components::check_cycle(doc, component, parent)?;
                }
            }
        }
    }
    Ok(())
}

/// The ops that move each of `ids` under `parent` at its index in `indexes`.
fn move_to(
    doc: &Document,
    ids: Vec<&NodeId>,
    parent: Option<&str>,
    indexes: Vec<String>,
) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    let mut placer = Placer::new(doc);
    for (id, index) in ids.into_iter().zip(indexes) {
        let n = node(doc, id)?;
        let board = doc.artboard_of(id).expect("node exists");
        ops.push(Op::Move {
            id: id.clone(),
            parent: parent.map(Into::into),
            index,
        });
        match (n.is_artboard(), parent.is_none()) {
            // Leaving the canvas: canvas positions and pages no longer apply.
            (true, false) => {
                for key in [PropKey::X, PropKey::Y, PropKey::Page] {
                    ops.push(Op::Set {
                        id: id.clone(),
                        key,
                        value: None,
                    });
                }
            }
            // Becoming an artboard: give it a free spot on its old artboard's page.
            (false, true) => {
                let (x, y) = placer.place(doc.page_of(board), n);
                let mut keys = vec![(PropKey::X, Value::from(x)), (PropKey::Y, Value::from(y))];
                if let Some(page) = &board.page {
                    keys.push((PropKey::Page, Value::from(page.as_str())));
                }
                for (key, value) in keys {
                    ops.push(Op::Set {
                        id: id.clone(),
                        key,
                        value: Some(value),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(ops)
}

/// Wraps sibling nodes in a new `<div>` named "Group", where the first of
/// them was, keeping their order. Returns the ops and the group's id.
pub fn group(
    doc: &Document,
    ids: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, NodeId)> {
    let ids = top_level(doc, ids);
    let Some(first) = ids.first() else {
        return err("name the nodes to group");
    };
    let parent = node(doc, first)?.parent.clone();
    let Some(parent) = parent else {
        return err("artboards can't be grouped; group what's inside one");
    };
    for id in &ids {
        if node(doc, id)?.parent.as_deref() != Some(parent.as_str()) {
            return err("only nodes with the same parent can be grouped");
        }
        let depth = doc.depth(&parent) + 2 + doc.height(id);
        if depth > MAX_DEPTH {
            return err(format!(
                "grouping {id:?} would nest {depth} levels deep; the limit is {MAX_DEPTH}"
            ));
        }
    }
    room_for(doc, 0, 1)?;
    // In sibling order, so the group keeps them as they were.
    let siblings = doc.children(Some(&parent));
    let members: Vec<&Node> = siblings
        .iter()
        .copied()
        .filter(|n| ids.iter().any(|id| **id == n.id))
        .collect();
    let at = siblings
        .iter()
        .position(|n| n.id == members[0].id)
        .expect("a member is a child");
    let prev = at.checked_sub(1).map(|i| siblings[i].index.as_str());
    let id = new_id();
    let mut ops = vec![Op::Create {
        node: Node {
            parent: Some(parent.clone()),
            index: fractional::key_between(prev, Some(&members[0].index)),
            name: Some("Group".into()),
            ..Node::element(id.clone(), "div")
        },
    }];
    let indexes = fractional::keys_between(None, None, members.len());
    for (member, index) in members.iter().zip(indexes) {
        ops.push(Op::Move {
            id: member.id.clone(),
            parent: Some(id.clone()),
            index,
        });
    }
    Ok((ops, id))
}

/// Takes the children out of each node in `ids`, into its parent where it
/// was, and deletes it.
pub fn ungroup(doc: &Document, ids: &[NodeId]) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    for id in top_level(doc, ids) {
        let group = element(doc, id)?;
        let Some(parent) = group.parent.clone() else {
            return err(format!(
                "{id:?} is an artboard; only a group inside one can be ungrouped"
            ));
        };
        if group.is_instance() {
            return err(format!(
                "{id:?} is an instance; detach it before ungrouping it"
            ));
        }
        let children = doc.children(Some(id));
        let next = doc.next_sibling(id).map(|n| n.index.as_str());
        let indexes = fractional::keys_between(Some(&group.index), next, children.len());
        for (child, index) in children.iter().zip(indexes) {
            ops.push(Op::Move {
                id: child.id.clone(),
                parent: Some(parent.clone()),
                index,
            });
        }
        ops.push(Op::Delete { id: id.clone() });
    }
    Ok(ops)
}

/// Copies nodes. Each copy lands right after its original; copied artboards
/// are placed in free canvas space. Returns the ops and the new root ids.
pub fn duplicate(
    doc: &Document,
    ids: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    let mut ops = Vec::new();
    let mut roots = Vec::new();
    let mut placer = Placer::new(doc);
    // Each copied instance, with the instance it copies.
    let mut instances: HashMap<NodeId, &str> = HashMap::new();
    for id in top_level(doc, ids) {
        let original = node(doc, id)?;
        let fragment = Fragment::from_document(doc, id).expect("node exists");
        let index = doc.index_after(id).expect("node exists");
        let position = original
            .is_artboard()
            .then(|| placer.place(doc.page_of(original), original));
        let parent = original.parent.clone();
        let first = ops.len();
        roots.push(fragment.create_ops(parent.as_deref(), index, position, new_id, &mut ops));
        // The nodes `Fragment::from_document` copied, in the order it made
        // them. It copies an instance, and a component's definition, as an
        // instance with no children of its own.
        let mut copied = Vec::new();
        let mut stack = vec![id.as_str()];
        while let Some(at) = stack.pop() {
            copied.push(at);
            if doc
                .get(at)
                .is_some_and(|n| !n.is_instance() && !n.component)
            {
                stack.extend(doc.children(Some(at)).iter().rev().map(|c| c.id.as_str()));
            }
        }
        for (original, op) in copied.into_iter().zip(&ops[first..]) {
            if let Op::Create { node } = op
                && doc
                    .get(original)
                    .is_some_and(|n| n.is_instance() || n.component)
            {
                instances.insert(node.id.clone(), original);
            }
        }
        // A copied artboard goes on its original's page.
        if let Some(Op::Create { node }) = ops.get_mut(first)
            && original.is_artboard()
        {
            node.page = original.page.clone();
        }
    }
    // Links between the artboards copied together go to the copies, so a
    // copied flow runs on its own.
    let copies: BTreeMap<&str, &str> = top_level(doc, ids)
        .into_iter()
        .zip(&roots)
        .filter(|(id, _)| doc.get(id).is_some_and(Node::is_artboard))
        .map(|(id, copy)| (id.as_str(), copy.as_str()))
        .collect();
    if !copies.is_empty() {
        // Copies of a flow drop their route, so they fall back to routes
        // made from their names instead of sharing the originals' at the
        // same widths. One copied artboard keeps it: that's how a mobile
        // version starts.
        let own_routes = copies.len() > 1;
        let copied: HashSet<&str> = copies.values().copied().collect();
        for op in &mut ops {
            if let Op::Create { node } = op {
                if let Some(copy) = flow::link_target(node).and_then(|to| copies.get(&*to)) {
                    let href = flow::link_href(copy);
                    node.attrs.insert("href".to_owned(), href);
                }
                if own_routes && copied.contains(node.id.as_str()) {
                    node.attrs.remove(flow::ROUTE_ATTR);
                }
                // An instance shows its component's links, which aren't
                // among the copied nodes. Override the ones that go to a
                // copied artboard, whether the component or an override set them.
                if let Some(&original) = instances.get(&node.id) {
                    for link in doc.subtree(original) {
                        let Some(copy) = flow::link_target(link).and_then(|to| copies.get(&*to))
                        else {
                            continue;
                        };
                        // Inside an instance a node's id is `instance/path`;
                        // in a definition it's the path itself.
                        let path = if link.id == original {
                            None
                        } else {
                            Some(
                                (link.id.strip_prefix(original))
                                    .and_then(|p| p.strip_prefix(components::SEPARATOR))
                                    .unwrap_or(&link.id),
                            )
                        };
                        let key = match path {
                            Some(path) => format!("{path}/attr:href"),
                            None => "attr:href".to_owned(),
                        };
                        node.overrides.insert(key, Some(flow::link_href(copy)));
                    }
                }
            }
        }
    }
    room_for(doc, 0, ops.len())?;
    Ok((ops, roots))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{support::*, *};

    #[test]
    fn many_nodes_delete_at_once() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let card = "<div><p>Card</p></div>";
        let (ops, _) = write_html(
            &doc,
            &board,
            &card.repeat(10_000),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        // Every card and every paragraph, some twice: only the cards are deleted.
        let mut all: Vec<NodeId> = doc
            .subtree(&board)
            .iter()
            .filter(|n| n.id != board && n.kind != NodeKind::Text)
            .map(|n| n.id.clone())
            .collect();
        all.extend(all[..100].to_vec());
        let started = std::time::Instant::now();
        let ops = delete(&doc, &all).unwrap();
        assert_eq!(ops.len(), 10_000);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn many_siblings_duplicate_at_once() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let (ops, cards) = write_html(
            &doc,
            &board,
            &"<div><p>Card</p></div>".repeat(10_000),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        let mut n = 0;
        let mut copy_id = || {
            n += 1;
            format!("copy{n}")
        };
        let started = std::time::Instant::now();
        let (ops, copies) = duplicate(&doc, &cards, &mut copy_id).unwrap();
        let took = started.elapsed();
        doc.apply_all(&ops);
        assert_eq!(copies.len(), 10_000);
        let order: Vec<String> = doc
            .children(Some(&board))
            .iter()
            .map(|n| n.id.clone())
            .collect();
        assert_eq!(
            order[..4],
            [
                cards[0].clone(),
                copies[0].clone(),
                cards[1].clone(),
                copies[1].clone()
            ]
        );
        assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    }

    #[test]
    fn duplicate_artboard_places_it_beside() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, _) = write_html(
            &doc,
            &board,
            "<p>a</p>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let (ops, roots) = duplicate(&doc, std::slice::from_ref(&board), &mut new_id).unwrap();
        doc.apply_all(&ops);
        let copy = doc.get(&roots[0]).unwrap();
        assert_eq!(copy.x, Some(1440.0 + ARTBOARD_GAP));
        assert_eq!(doc.subtree(&roots[0]).len(), 3);
    }

    #[test]
    fn move_into_descendant_fails() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, roots) = write_html(
            &doc,
            &board,
            "<div><p>a</p></div>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        assert!(move_nodes(&doc, std::slice::from_ref(&board), Some(&roots[0]), None).is_err());
    }
}
