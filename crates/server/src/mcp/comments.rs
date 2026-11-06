//! The `comments` tool: the threads people pin to a design, which the server
//! sends to one agent each.

use std::collections::HashMap;

use finite_design::{
    Document,
    comment::{self, Listening},
};
use rmcp::{
    model::CallToolResult,
    schemars::{self, JsonSchema},
};
use serde::Deserialize;
use serde_json::Value;

use super::{
    FiniteMcp,
    format::comments_json,
    result::{ToolResult, fail, fit, joined, ok, with_note},
    selector::{Select, matched, page_id, selector_text},
};
use crate::hub::{Actor, DesignHandle};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    comment_id: String,
    message: String,
    #[serde(default)]
    resolve: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    comment_id: String,
    /// The element to pin it to: one match, an artboard or an element inside one.
    select: Select,
}

/// Seconds to wait, or true for 55.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Wait {
    Seconds(u64),
    Flag(bool),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommentsParams {
    pub(super) design_id: String,
    /// Seconds to wait for a new comment. true waits 55, the default and the most; a longer value waits 55.
    #[serde(default)]
    wait: Option<Wait>,
    /// Replies to send: [{"commentId": "…", "message": "…", "resolve": true}].
    #[serde(default)]
    reply: Option<Vec<Reply>>,
    /// Include resolved comments too.
    #[serde(default)]
    include_resolved: bool,
    /// Skip this many comments, to page through a long list.
    #[serde(default)]
    offset: usize,
    /// Only comments pinned to these elements or inside them, like read's select.
    #[serde(default)]
    select: Option<Select>,
    /// Only comments on this page's artboards: its name or id.
    #[serde(default)]
    page: Option<String>,
    /// Only comments a person addressed to you.
    #[serde(default)]
    mentions: bool,
    /// Pins comments to other elements, for a comment whose screen was removed and rebuilt: [{"commentId": "…", "select": "#k3x9a2bq"}].
    #[serde(default)]
    pin: Option<Vec<Pin>>,
    /// Comments to leave to others: they go to another agent and stop waking you until a person writes in them again.
    #[serde(default)]
    pass: Option<Vec<String>>,
    /// Comments that are notes between people, not requests: no agent gets them. A person can change that back.
    #[serde(default)]
    for_people: Option<Vec<String>>,
}

/// The longest a `wait` blocks, in seconds.
///
/// MCP clients commonly time out a tool call well under two minutes. A wait
/// of 120 seconds or more comes back as the client's own timeout, so the
/// agent never sees this server's answer. 55 still returns it. The default
/// wait is this same cap.
const MAX_WAIT_SECS: u64 = 55;

/// How many seconds to block for a comment. `None` is the default, which is
/// the maximum. A request above the maximum still waits the maximum, and a
/// request below 1 waits 1.
fn wait_secs(requested: Option<u64>) -> u64 {
    requested.unwrap_or(MAX_WAIT_SECS).clamp(1, MAX_WAIT_SECS)
}

/// What a wait says when nothing arrives. `seconds` is how long the call
/// actually blocked, after the cap above.
fn nothing_arrived(seconds: u64) -> String {
    format!("No comments arrived in {seconds} seconds. Call again to keep listening.")
}

pub(super) async fn comments(
    mcp: &FiniteMcp,
    handle: &DesignHandle,
    actor: &Actor,
    p: CommentsParams,
) -> ToolResult {
    let me = || finite_design::comment::Author {
        id: actor.id.clone(),
        name: actor.name.clone(),
        kind: finite_design::comment::AuthorKind::Agent,
    };
    let mut pinned = Vec::new();
    for pin in p.pin.iter().flatten() {
        let done = match pinned.is_empty() {
            true => String::new(),
            false => format!(" Pinned {} before it.", pinned.join(", ")),
        };
        let selector = match selector_text(&pin.select.value(), &HashMap::new()) {
            Ok(selector) => selector,
            Err(error) => return fail(format!("{}: {error}.{done}", pin.comment_id)),
        };
        let found = match handle.read(|d| matched(d.view(), &selector, None)) {
            Ok(found) => found,
            Err(error) => return fail(format!("{}: {error}.{done}", pin.comment_id)),
        };
        let [target] = found.as_slice() else {
            return fail(format!(
                "{}: {selector:?} matches {} elements; pin takes one, like \"#k3x9a2bq\".{done}",
                pin.comment_id,
                found.len()
            ));
        };
        if let Err(error) = handle.repin(&pin.comment_id, target) {
            return fail(format!("{}: {error}.{done}", pin.comment_id));
        }
        pinned.push(pin.comment_id.as_str());
    }
    let pinned = (!pinned.is_empty()).then(|| {
        format!(
            "Pinned {} to the element you selected, at the same offset in its artboard.",
            pinned.join(", ")
        )
    });
    if let Some(replies) = p.reply {
        let many = replies.len() > 1;
        let mut out = Vec::new();
        for reply in replies {
            match handle.reply(&reply.comment_id, me(), &reply.message, reply.resolve) {
                Ok(comment) if many => {
                    out.push(format!("{}: {}", reply.comment_id, replied(&comment)))
                }
                Ok(comment) => out.push(replied(&comment)),
                Err(error) => {
                    let sent = if out.is_empty() {
                        String::new()
                    } else {
                        format!(" Replies before it were sent:\n{}", out.join("\n"))
                    };
                    return fail(format!("{}: {error}.{sent}", reply.comment_id));
                }
            }
        }
        return ok(joined([pinned, Some(out.join("\n"))]).unwrap_or_default());
    }
    let mut passed = Vec::new();
    for id in p.pass.iter().flatten() {
        if let Err(error) = handle.pass(id, me()) {
            let before = match passed.is_empty() {
                true => String::new(),
                false => format!(" Passed on {} before it.", passed.join(", ")),
            };
            return fail(format!("{id}: {error}.{before}"));
        }
        passed.push(id.as_str());
    }
    let passed = match passed.len() {
        0 => None,
        1 => Some(format!(
            "Passed on {}: it won't wake you again until a person writes in it.",
            passed[0]
        )),
        _ => Some(format!(
            "Passed on {}: they won't wake you again until a person writes in them.",
            passed.join(", ")
        )),
    };
    let mut noted = Vec::new();
    for id in p.for_people.iter().flatten() {
        if let Err(error) = handle.set_audience(id, finite_design::comment::Audience::People) {
            let before = match noted.is_empty() {
                true => String::new(),
                false => format!(" Marked {} as notes before it.", noted.join(", ")),
            };
            return fail(format!("{id}: {error}.{before}"));
        }
        noted.push(id.as_str());
    }
    let noted = (!noted.is_empty()).then(|| {
        format!(
            "Marked {} as for people: no agent gets {}.",
            noted.join(", "),
            if noted.len() == 1 { "it" } else { "them" }
        )
    });
    let passed = joined([pinned, joined([passed, noted])]);
    let selector = match p.select.as_ref() {
        Some(select) => match selector_text(&select.value(), &HashMap::new()) {
            Ok(selector) => Some(selector),
            Err(error) => return fail(error),
        },
        None => None,
    };
    // Built again on every look, since artboards come and go while an agent waits.
    let scope_in = |doc: &Document| -> Result<Listening, String> {
        let page = p
            .page
            .as_deref()
            .map(|page| page_id(doc, page, &HashMap::new()))
            .transpose()?;
        let within = match selector.as_deref() {
            Some(selector) => {
                let ids = matched(doc, selector, page.as_deref())?;
                if ids.is_empty() {
                    return Err(format!(
                        "{selector:?} matches no element. read with no select shows the outline with every id."
                    ));
                }
                Some(ids.into_iter().collect())
            }
            None => None,
        };
        Ok(Listening {
            within,
            page,
            mentions: p.mentions,
        })
    };
    let wait = match p.wait {
        Some(Wait::Seconds(seconds)) => Some(wait_secs(Some(seconds))),
        Some(Wait::Flag(true)) => Some(wait_secs(None)),
        Some(Wait::Flag(false)) | None => None,
    };
    if let Some(seconds) = wait {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            // Looked up again each time round, so deleting the design
            // ends the wait.
            let handle = &match mcp.design(&p.design_id).await {
                Ok(handle) => handle,
                Err(result) => return Ok(result),
            };
            let changed = handle.comments_changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let scope = match handle.read(|design| scope_in(design.view())) {
                Ok(scope) => scope,
                Err(error) => return fail(error),
            };
            let taken = handle.take_waiting(actor, scope);
            let waiting = handle.with_routes(|design, listening| {
                comments_json(design, &actor.id, listening, taken.iter())
            });
            if !waiting.is_empty() {
                let total = waiting.len();
                let (content, shown) = fit(waiting.into_iter().map(selects));
                let more = (shown < total).then(|| {
                        format!(
                            "Showing the oldest {shown} of {total} waiting comments. Reply to these, then call again for the rest."
                        )
                    });
                return Ok(CallToolResult::success(with_note(
                    content,
                    joined([passed, more]),
                )));
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                let none = nothing_arrived(seconds);
                return ok(joined([passed, Some(none)]).unwrap_or_default());
            }
        }
    }
    let scope = match handle.read(|design| scope_in(design.view())) {
        Ok(scope) => scope,
        Err(error) => return fail(error),
    };
    // Listing takes what's waiting for this agent too, so another agent
    // doesn't start on the same comment.
    handle.take_waiting(actor, scope.clone());
    let comments = handle.with_routes(|design, listening| {
        let doc = design.view();
        let shown = design
            .comments()
            .iter()
            .filter(|c| (p.include_resolved || !c.resolved) && scope.admits(doc, c, &actor.id));
        comments_json(design, &actor.id, listening, shown)
    });
    if comments.len() <= p.offset {
        let none = match (comments.is_empty(), p.include_resolved) {
            (false, _) => "No more comments.",
            (true, true) => "This design has no comments.",
            (true, false) => "No open comments.",
        };
        return ok(joined([passed, Some(none.to_owned())]).unwrap_or_default());
    }
    let total = comments.len();
    let (content, shown) = fit(comments.into_iter().skip(p.offset).map(selects));
    let to = p.offset + shown;
    let more = (to < total).then(|| {
        format!(
            "Showing comments {} to {to} of {total}, oldest first. Pass offset {to} for the rest.",
            p.offset + 1
        )
    });
    Ok(CallToolResult::success(with_note(
        content,
        joined([passed, more]),
    )))
}

/// What a reply did: whether the comment is open, and the changes it links.
fn replied(comment: &comment::Comment) -> String {
    let labels: Vec<&str> = comment
        .messages
        .last()
        .map(|m| m.changes.iter().map(|c| c.label.as_str()).collect())
        .unwrap_or_default();
    let state = if comment.resolved { "resolved" } else { "open" };
    let linked = match labels.len() {
        0 => "links none of your changes".to_owned(),
        n => format!(
            "links your {n} change{} to this artboard: {}",
            if n == 1 { "" } else { "s" },
            labels.join(", ")
        ),
    };
    format!("Replied. The comment is {state}, and your reply {linked}.")
}

/// A comment as an agent sees it: its element as a selector, `#id`, rather
/// than a node id.
fn selects(mut comment: Value) -> Value {
    if let Some(map) = comment.as_object_mut() {
        if let Some(Value::String(id)) = map.remove("nodeId") {
            map.insert("select".into(), format!("#{id}").into());
        }
        if let Some(Value::Array(also)) = map.get_mut("alsoSelected") {
            for item in also {
                if let Some(item) = item.as_object_mut()
                    && let Some(Value::String(id)) = item.remove("nodeId")
                {
                    item.insert("select".into(), format!("#{id}").into());
                }
            }
        }
    }
    comment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_clamp_to_55_seconds() {
        assert_eq!(wait_secs(None), MAX_WAIT_SECS);
        assert_eq!(wait_secs(Some(0)), 1);
        assert_eq!(wait_secs(Some(1)), 1);
        assert_eq!(wait_secs(Some(55)), 55);
        assert_eq!(wait_secs(Some(60)), 55);
        assert_eq!(wait_secs(Some(120)), 55);
        assert_eq!(wait_secs(Some(300)), 55);
        assert_eq!(
            nothing_arrived(55),
            "No comments arrived in 55 seconds. Call again to keep listening."
        );
    }
}
