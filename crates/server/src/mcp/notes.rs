//! The notes that follow a tool's answer: what an edit did to components,
//! to links, and to values other agents changed in the meantime. The model
//! reads a change (`finite_design::{components, flow}`); this words it for
//! an agent.

use std::collections::BTreeMap;

use finite_design::{
    Change, Document, Kept, KeptNode, NodeKind, PropKey, components, flow, html, html::Dropped,
};

use super::format::{self, outline};
use crate::hub::{Actor, DesignHandle, PRESENCE_NODES};

/// How many changed nodes a note names before it just counts them.
const NAMED: usize = 12;

/// How many instances a component note names before it counts the rest.
const OVERRIDDEN_NAMED: usize = 3;

/// The first line of a node's outline: what it is, for a note to name.
fn headline(doc: &Document, id: &str) -> String {
    outline(doc, id, 0)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_owned()
}

/// Says what HTML parsing left out, so the agent isn't surprised by a missing
/// handler or iframe. Empty when nothing was.
pub(super) fn left_out(dropped: &[Dropped]) -> String {
    if dropped.is_empty() {
        return String::new();
    }
    let mut text = format!("\nLeft out {} thing(s) that can't run here:", dropped.len());
    for d in dropped {
        text.push_str(&format!("\n- {} at {}: {}", d.what, d.path, d.reason));
    }
    text
}

/// Tells an agent that `n` instances in a copy still follow their components,
/// and how to cut them loose.
pub(super) fn following_note(n: usize) -> String {
    let (s, verb, its) = match n {
        1 => ("", "s", "its"),
        _ => ("s", "", "their"),
    };
    format!(
        "{n} instance{s} still follow{verb} {its} component{s}; pass detach: true for a frozen copy."
    )
}

/// Names the values a merged rewrite kept because another agent set them
/// after the HTML was read (see `Design::merge`).
pub(super) fn kept_note(doc: &Document, kept: &[Kept]) -> String {
    let mut text = String::new();
    for k in kept.iter().take(NAMED) {
        let Some(node) = doc.get(&k.id) else { continue };
        let value = match node.get(&k.key) {
            Some(serde_json::Value::String(s)) => Some(s),
            Some(v) => Some(v.to_string()),
            None => None,
        };
        let what = match (&k.key, value) {
            (PropKey::Style(name), Some(v)) => format!("{name}: {v}"),
            (PropKey::Attr(name), Some(v)) => format!("{name}=\"{v}\""),
            (PropKey::Text, Some(v)) => format!("the text {v:?}"),
            (PropKey::Name, Some(v)) => format!("the layer name {v:?}"),
            (key, Some(v)) => format!("{key} {v:?}"),
            (PropKey::Style(name) | PropKey::Attr(name), None) => format!("{name} unset"),
            (key, None) => format!("{key} unset"),
        };
        let element = match node.kind {
            NodeKind::Text => node.parent.as_deref().unwrap_or(&node.id),
            _ => &node.id,
        };
        text.push_str(&format!(
            "\nNote: kept {what} on {}, which another agent set after you read it{}",
            headline(doc, element),
            if k.conflict {
                ", instead of your change. Set it again if you meant to replace theirs."
            } else {
                "."
            }
        ));
    }
    if kept.len() > NAMED {
        text.push_str(&format!(
            "\n…and {} more values kept the same way.",
            kept.len() - NAMED
        ));
    }
    text
}

/// Names the elements a merged rewrite kept because another agent added
/// them, or moved them in, after the HTML was read (see `Design::merge`).
pub(super) fn kept_nodes_note(doc: &Document, kept: &[KeptNode]) -> String {
    let mut text = String::new();
    for k in kept.iter().take(NAMED) {
        if doc.get(&k.id).is_none() {
            continue;
        }
        text.push_str(&format!(
            "\nNote: kept {}, which another agent {} after you read it. Delete it if you meant to remove it.",
            headline(doc, &k.id),
            if k.moved { "moved here" } else { "added" }
        ));
    }
    if kept.len() > NAMED {
        text.push_str(&format!(
            "\n…and {} more elements kept the same way.",
            kept.len() - NAMED
        ));
    }
    text
}

/// A node as a note names it: `"Name" #id`.
fn named(doc: &Document, id: &str) -> String {
    doc.get(id)
        .map(|n| format!("{:?} #{id}", n.display_name()))
        .unwrap_or_else(|| format!("#{id}"))
}

/// Broken links, bad routes and screens that share a route and a width (see
/// [`finite_design::flow`]), for the end of the result of a change that could
/// have made them.
pub(super) fn flow_note(handle: &DesignHandle, change: &Change) -> Option<String> {
    handle.read(|d| {
        // The design as it renders, so links inside instances count.
        let doc = d.view();
        if !flow::can_break(doc, &change.ops) {
            return None;
        }
        let flow = flow::flow(doc);
        if flow.broken.is_empty() && flow.bad_routes.is_empty() && flow.shared_widths.is_empty() {
            return None;
        }
        const SHOWN: usize = 5;
        let mut lines = Vec::new();
        if !flow.broken.is_empty() {
            let n = flow.broken.len();
            lines.push(format!(
                "Links: {n} {} to no artboard. Set href to #finite-artboard=<an artboard's id>, or remove the link; if you deleted the artboard, undo brings it back.",
                if n == 1 { "link goes" } else { "links go" }
            ));
            for b in flow.broken.iter().take(SHOWN) {
                let why = if b.not_artboard {
                    "isn't an artboard"
                } else {
                    "doesn't exist"
                };
                lines.push(format!(
                    "- {} on {}: {:?} {why}",
                    named(doc, &b.element),
                    named(doc, &b.from),
                    b.to
                ));
            }
            if n > SHOWN {
                lines.push(format!("- and {} more", n - SHOWN));
            }
        }
        for bad in flow.bad_routes.iter().take(SHOWN) {
            lines.push(format!(
                "Route: data-route={:?} on {} isn't a path like /checkout, so it's ignored.",
                bad.route,
                named(doc, &bad.artboard)
            ));
        }
        if let Some(shared) = flow.shared_widths.first() {
            let n = flow.shared_widths.len();
            let boards: Vec<String> = shared.artboards.iter().map(|id| named(doc, id)).collect();
            let more = if n > 1 {
                format!(" ({} more routes have this too)", n - 1)
            } else {
                String::new()
            };
            lines.push(format!(
                "Route: {} has {} at {}px wide, so a link can't tell them apart. Give one of them its own data-route{more}.",
                shared.route,
                boards.join(" and "),
                shared.width,
            ));
        }
        Some(lines.join("\n"))
    })
}

/// What a change did to components, for the end of an edit's result:
/// agents can't tell from the HTML whether an edit inside an instance
/// changed only that instance or the component every instance shows.
pub(super) fn component_note(handle: &DesignHandle, change: &Change) -> Option<String> {
    handle.read(|d| {
        let doc = d.doc();
        let summary = components::summarize(doc, &change.ops);
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let mut notes = Vec::new();
        // Instances that changed the same way share a line, so eleven rows
        // given one override each are one note.
        let mut grouped: BTreeMap<(String, usize, usize), Vec<&str>> = BTreeMap::new();
        for o in &summary.overridden {
            let component = o
                .component
                .as_deref()
                .map(|id| named(doc, id))
                .unwrap_or_default();
            grouped
                .entry((component, o.set, o.cleared))
                .or_default()
                .push(&o.instance);
        }
        for ((component, set, cleared), instances) in grouped {
            let mut text = match instances.as_slice() {
                [only] => {
                    let mut text = format!("Only instance #{only} of {component} changed");
                    if set > 0 {
                        text.push_str(&format!(
                            ": {set} value{} became its overrides",
                            plural(set)
                        ));
                    }
                    if cleared > 0 {
                        text.push_str(&format!(
                            "{}{cleared} value{} follow{} the component again",
                            if set > 0 { ", and " } else { ": " },
                            plural(cleared),
                            if cleared == 1 { "s" } else { "" },
                        ));
                    }
                    text
                }
                _ => {
                    let mut did = Vec::new();
                    if set > 0 {
                        did.push(format!("got {set} override{}", plural(set)));
                    }
                    if cleared > 0 {
                        did.push(format!(
                            "have {cleared} value{} following the component again",
                            plural(cleared)
                        ));
                    }
                    format!(
                        "{} instances of {component} {} each ({})",
                        instances.len(),
                        did.join(" and "),
                        format::some_ids(&instances, OVERRIDDEN_NAMED)
                    )
                }
            };
            text.push_str(". To change every instance, edit the component instead.");
            notes.push(text);
        }
        for id in &summary.defined {
            notes.push(format!(
                "Defined component {}. Write data-component={:?} again for an instance of it.",
                named(doc, id),
                doc.get(id).map(|n| n.display_name()).unwrap_or_default()
            ));
        }
        for edited in &summary.edited {
            if edited.instances.is_empty() {
                notes.push(format!(
                    "This edited component {}, which has no instances yet.",
                    named(doc, &edited.component)
                ));
                continue;
            }
            // New nodes have no overrides yet, so name their ids in each
            // instance: an agent giving each instance its own text needs them.
            for node in &edited.added {
                let ids: Vec<String> = edited
                    .direct
                    .iter()
                    .map(|i| format!("{i}/{node}"))
                    .collect();
                notes.push(format!(
                    "New in the component: {}. In its instances it's {}: set those to give each instance its own value.",
                    headline(doc, node),
                    format::some_ids(&ids, OVERRIDDEN_NAMED)
                ));
            }
            notes.push(format!(
                "This edited component {}, so all {} instance{} show it too ({}), except where they override a value.",
                named(doc, &edited.component),
                edited.instances.len(),
                plural(edited.instances.len()),
                format::some_ids(&edited.instances, OVERRIDDEN_NAMED)
            ));
        }
        if !summary.detached.is_empty() {
            let ids: Vec<String> = summary.detached.iter().map(|i| format!("#{i}")).collect();
            notes.push(format!(
                "Detached {}: {} plain cop{} now, no longer following a component.",
                ids.join(", "),
                if ids.len() == 1 { "it's a" } else { "they're" },
                if ids.len() == 1 { "y" } else { "ies" }
            ));
        }
        (!notes.is_empty()).then(|| notes.join("\n"))
    })
}

/// What read's HTML says about components, so an agent knows where an edit
/// would land: instances show their component's content, and ids inside one
/// edit only it.
pub(super) fn html_component_note(
    design: &finite_design::Design,
    id: &str,
    html: &str,
) -> Option<String> {
    let doc = design.doc();
    let mut notes = Vec::new();
    if let Some((instance, component)) = components::instance_of(doc, id) {
        notes.push(format!(
            "This is inside instance #{} of component {}. Editing it changes only this instance (an override); edit the component to change them all.",
            instance.id,
            component.map_or_else(String::new, |c| format!("{:?} #{}", c.display_name(), c.id)),
        ));
    } else if let Some(component) = components::component_of(doc, id) {
        let count = doc.instances_of(&component.id).count();
        notes.push(format!(
            "This is {} component {:?} #{}, which {count} instance{} show{}: editing it changes all of them.",
            if component.id == id { "the root of" } else { "inside" },
            component.display_name(),
            component.id,
            if count == 1 { "" } else { "s" },
            if count == 1 { "s" } else { "" },
        ));
    }
    if html.contains(html::INSTANCE_ATTR) && !components::is_virtual(id) {
        notes.push(format!(
            "Elements with {} are instances: their content comes from that component, and is shown expanded here. Ids inside one look like instanceId/nodeId, and editing those changes only that instance. To copy this HTML into another design, remove the {} attributes: that design doesn't have the component.",
            html::INSTANCE_ATTR,
            html::INSTANCE_ATTR
        ));
    }
    (!notes.is_empty()).then(|| notes.join("\n"))
}

/// Shows people which artboards an agent is editing, so edits don't land
/// with no one named. The indicator goes a minute after the agent's last
/// edit.
pub(super) fn show_working(handle: &DesignHandle, actor: &Actor, change: &Change) {
    let boards: Vec<String> = handle.read(|d| {
        let mut boards = Vec::new();
        for op in &change.ops {
            if let Some(board) = d.view().artboard_of(op.id())
                && !boards.contains(&board.id)
            {
                boards.push(board.id.clone());
            }
            if boards.len() >= PRESENCE_NODES {
                break;
            }
        }
        boards
    });
    if !boards.is_empty() {
        handle.show_editing(actor, boards);
    }
}
