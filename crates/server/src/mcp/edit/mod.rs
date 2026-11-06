//! The `edit` tool: one call is one transaction. Its ops apply in order
//! against the document as the ops before them left it, all or nothing, as
//! one change and one undo step ([`DesignHandle::transact`]).

mod ops;
mod run;

pub(super) use ops::Kind;

use std::sync::Arc;

use finite_design::{NodeId, label};
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{
    FiniteMcp,
    notes::{component_note, flow_note, show_working},
    result::{ToolResult, fail, ok},
    watch,
};
use crate::hub::{Actor, DesignHandle, PRESENCE_NODES};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditParams {
    pub(super) design_id: String,
    /// The changes, in order: artboard, html, css, attrs, move, remove, replace, page, tokens, import. See the description for each op's fields. One op can go at the top level instead.
    #[serde(default)]
    #[schemars(with = "Option<Vec<Map<String, Value>>>")]
    ops: Option<Value>,
    /// A few words shown to people watching, like "Restyling pricing".
    #[serde(default)]
    status: Option<String>,
    /// A layout check of the artboards this edit touched follows the result. false skips it.
    #[serde(default)]
    check: Option<bool>,
    /// Report what the ops would change, then change nothing.
    #[serde(default)]
    dry_run: bool,
    /// One op passed flat: its "op" and its fields at the top level.
    #[serde(flatten)]
    #[schemars(skip)]
    flat: Map<String, Value>,
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Shows people `status` on the artboards `boards`, or on every artboard
/// when the edit touched none. An empty status clears it.
fn show_status(handle: &DesignHandle, actor: &Actor, status: &str, boards: Vec<NodeId>) {
    if status.trim().is_empty() {
        handle.clear_presence(&actor.id);
        return;
    }
    let mut boards = boards;
    if boards.is_empty() {
        boards = handle.read(|d| {
            d.view()
                .artboards()
                .iter()
                .take(10)
                .map(|b| b.id.clone())
                .collect()
        });
    }
    boards.truncate(PRESENCE_NODES);
    handle.set_presence(actor, boards, Some(status.to_owned()));
}

impl FiniteMcp {
    pub(super) async fn edit(
        &self,
        handle: &Arc<DesignHandle>,
        actor: &Actor,
        p: EditParams,
    ) -> ToolResult {
        let steps = match ops::prepare(&self.hub, &p).await {
            Ok(steps) => steps,
            Err(error) => return fail(error),
        };
        let count = steps.len();
        let label = match p.status.as_deref().map(str::trim) {
            Some(status) if !status.is_empty() => label::clip(status, label::STATUS),
            _ => ops::summary(&steps),
        };
        if p.dry_run {
            return match handle.dry_run(actor, |tx| run::run(tx, steps)) {
                Ok((applied, sections)) => {
                    let head = if applied.is_empty() {
                        "Dry run: nothing was changed, and these ops would change nothing:"
                            .to_owned()
                    } else {
                        format!(
                            "Dry run: nothing was changed. Without dryRun, this edit would make {count} op{} as one step:",
                            plural(count)
                        )
                    };
                    ok(run::result(head, sections))
                }
                Err(error) => fail(error),
            };
        }
        let (sections, change) = match handle.transact(actor, &label, |tx| run::run(tx, steps)) {
            Ok(done) => done,
            Err(error) => return fail(error),
        };
        let boards: Vec<NodeId> = change
            .as_ref()
            .map(|change| {
                handle.read(|d| {
                    let mut boards: Vec<NodeId> = Vec::new();
                    for op in &change.ops {
                        if let Some(board) = d.view().artboard_of(op.id())
                            && !boards.contains(&board.id)
                        {
                            boards.push(board.id.clone());
                        }
                    }
                    boards
                })
            })
            .unwrap_or_default();
        match (&p.status, &change) {
            (Some(status), _) => show_status(handle, actor, status, boards),
            (None, Some(change)) => show_working(handle, actor, change),
            (None, None) => {}
        }
        let head = match (&change, count) {
            (_, 0) => match p.status.as_deref().map(str::trim) {
                Some(status) if !status.is_empty() => format!("People now see {status:?}."),
                Some(_) => "Cleared your status.".to_owned(),
                None => "No ops, so nothing changed.".to_owned(),
            },
            (Some(_), n) => format!(
                "Changed the design in one step ({n} op{}); undo reverses all of it.",
                plural(n)
            ),
            (None, _) => "Nothing changed: the design already looked like that.".to_owned(),
        };
        let mut text = run::result(head, sections);
        if let Some(change) = &change {
            for note in [component_note(handle, change), flow_note(handle, change)]
                .into_iter()
                .flatten()
            {
                text.push('\n');
                text.push_str(&note);
            }
            if p.check != Some(false) {
                let clean = self
                    .watch
                    .after_edit(&p.design_id, handle, change, self.hub.layout_wait())
                    .await;
                let notes = self.watch.take_for_result(&p.design_id);
                if !notes.is_empty() {
                    text.push('\n');
                    text.push_str(&watch::Taken::text(&notes));
                } else if clean {
                    text.push_str(
                        "\nLayout: nothing is cut off, overflowing or overlapping on the artboards this edit touched.",
                    );
                }
            } else {
                self.watch.invalidate(&p.design_id);
            }
        }
        ok(text)
    }
}
