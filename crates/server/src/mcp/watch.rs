//! The layout note on edit results, behind `FINITE_MCP_EXTRA=layout`.
//!
//! Agents rarely call `get_layout` or `get_screenshot` to check an edit, and
//! content that overflows its artboard or box goes unnoticed. Measuring takes
//! a browser: about 0.5 s with Chrome warm and 2 s for the first call, against
//! 1 ms for the edit itself. So the edit starts the measuring and waits for it
//! up to [`WAIT`]. If the note is ready, it goes on that edit's result. If not
//! (a cold browser, a busy one), the measuring finishes after the response and
//! the note goes on the agent's next result for that design. Agents often send
//! several edits at once, so a note from an earlier edit can arrive with a
//! later one. A newer edit to the same artboard replaces a note, and
//! `get_layout` and `get_screenshot` drop it, since they report the layout
//! themselves.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use finite_design::Change;

use super::format::layout_notes;
use crate::{hub::DesignHandle, screenshot};

/// How long an edit waits for its layout check before it answers without one.
pub(super) const WAIT: Duration = Duration::from_millis(1_000);

/// How many artboards one edit has measured, so an edit across a whole design
/// doesn't start a browser for each.
const BOARDS_PER_EDIT: usize = 3;

/// What `layout_notes` starts with when it found nothing to report.
const CLEAN: &str = "Layout: nothing is cut off";

#[derive(Default)]
struct Entry {
    /// Counts the edits to this artboard, so a measurement that finishes
    /// after a newer edit can tell it's out of date.
    generation: u64,
    note: Option<String>,
}

#[derive(Default)]
pub(super) struct LayoutWatch {
    /// By design id, then artboard id.
    boards: Mutex<HashMap<String, HashMap<String, Entry>>>,
}

impl LayoutWatch {
    /// Starts measuring the artboards `change` touched, and waits up to
    /// [`WAIT`] for it. What it finds is then waiting in [`Self::take`].
    pub(super) async fn after_edit(
        self: &Arc<Self>,
        design: &str,
        handle: &Arc<DesignHandle>,
        change: &Change,
    ) {
        let boards: Vec<String> = handle.read(|d| {
            let mut boards: Vec<String> = Vec::new();
            for op in &change.ops {
                if let Some(board) = d.doc().artboard_of(op.id())
                    && !boards.contains(&board.id)
                {
                    boards.push(board.id.clone());
                }
            }
            boards.truncate(BOARDS_PER_EDIT);
            boards
        });
        let mut tasks = Vec::new();
        for board in boards {
            let generation = self.bump(design, &board);
            let (watch, handle, design) = (Arc::clone(self), Arc::clone(handle), design.to_owned());
            tasks.push(tokio::spawn(async move {
                let note = measure(&handle, &board).await;
                watch.finish(&design, &board, generation, note);
            }));
        }
        // On time out the tasks carry on and leave their notes for later.
        let _ = tokio::time::timeout(WAIT, futures::future::join_all(tasks)).await;
    }

    fn bump(&self, design: &str, board: &str) -> u64 {
        let mut all = self.boards.lock().expect("layout watch lock");
        let entry = all
            .entry(design.to_owned())
            .or_default()
            .entry(board.to_owned())
            .or_default();
        entry.generation += 1;
        entry.note = None;
        entry.generation
    }

    fn finish(&self, design: &str, board: &str, generation: u64, note: Option<String>) {
        let mut all = self.boards.lock().expect("layout watch lock");
        if let Some(entry) = all.get_mut(design).and_then(|d| d.get_mut(board))
            && entry.generation == generation
        {
            entry.note = note;
        }
    }

    /// The notes waiting on `design`, which are then spent.
    pub(super) fn take(&self, design: &str) -> Option<String> {
        let mut all = self.boards.lock().expect("layout watch lock");
        let notes: Vec<String> = all
            .get_mut(design)?
            .values_mut()
            .filter_map(|e| e.note.take())
            .collect();
        (!notes.is_empty()).then(|| notes.join("\n"))
    }

    /// Forgets what's waiting on `design`: the agent is looking at the layout.
    pub(super) fn discard(&self, design: &str) {
        let _ = self.take(design);
    }
}

/// What the layout check says about `board`, if it found anything.
async fn measure(handle: &DesignHandle, board: &str) -> Option<String> {
    let plan = handle
        .read(|d| screenshot::plan_measurement(d.doc(), board, screenshot::Options::default()));
    let boxes = screenshot::layout(plan.ok()?).await.ok()?;
    let notes = handle.read(|d| layout_notes(d.doc(), board, &boxes));
    if notes.is_empty() || notes.starts_with(CLEAN) {
        return None;
    }
    Some(format!(
        "{notes}\n(From checking artboard #{board} after your last edit. get_layout shows more.)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_spent_once_it_is_read() {
        let watch = LayoutWatch::default();
        let g = watch.bump("d", "a");
        watch.finish("d", "a", g, Some("clipped".into()));
        assert_eq!(watch.take("d").as_deref(), Some("clipped"));
        assert_eq!(watch.take("d"), None);
    }

    #[test]
    fn a_measurement_from_before_a_newer_edit_is_dropped() {
        let watch = LayoutWatch::default();
        let old = watch.bump("d", "a");
        let new = watch.bump("d", "a");
        watch.finish("d", "a", old, Some("stale".into()));
        assert_eq!(watch.take("d"), None);
        watch.finish("d", "a", new, Some("fresh".into()));
        assert_eq!(watch.take("d").as_deref(), Some("fresh"));
    }

    #[test]
    fn a_newer_edit_clears_the_note_it_replaces() {
        let watch = LayoutWatch::default();
        let g = watch.bump("d", "a");
        watch.finish("d", "a", g, Some("clipped".into()));
        watch.bump("d", "a");
        assert_eq!(watch.take("d"), None);
    }

    #[test]
    fn notes_are_kept_per_design_and_discarded_on_request() {
        let watch = LayoutWatch::default();
        for design in ["d1", "d2"] {
            let g = watch.bump(design, "a");
            watch.finish(design, "a", g, Some(format!("note {design}")));
        }
        watch.discard("d1");
        assert_eq!(watch.take("d1"), None);
        assert_eq!(watch.take("d2").as_deref(), Some("note d2"));
    }
}
