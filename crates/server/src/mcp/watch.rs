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
//! later one.
//!
//! A note describes the design as of one edit, so anything that changes the
//! design afterwards drops it: a newer `write_html` or `update_styles` on the
//! artboard replaces it, any other edit clears every note on the design (see
//! [`LayoutWatch::invalidate`]), and `get_layout` and `get_screenshot` drop it
//! because they report the layout themselves. A tool that fails leaves a note
//! where it was.
//!
//! Measurements run one at a time, and one whose artboard has been edited
//! again by the time its turn comes is skipped, so six edits sent together
//! start one browser, not six.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use finite_design::Change;

use super::format::layout_notes;
use crate::{hub::DesignHandle, screenshot};

/// How long an edit waits for its layout check before it answers without one.
/// `FINITE_LAYOUT_WAIT_MS` sets it; the deferred-note tests set 0.
fn wait() -> Duration {
    static WAIT: OnceLock<Duration> = OnceLock::new();
    *WAIT.get_or_init(|| {
        std::env::var("FINITE_LAYOUT_WAIT_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map_or(Duration::from_millis(1_000), Duration::from_millis)
    })
}

/// The longest one measurement may hold up the next. A hung browser is killed
/// by `screenshot::layout`'s own, longer timeout.
const MEASURE_LIMIT: Duration = Duration::from_secs(8);

/// How many artboards one edit has measured, so an edit across a whole design
/// doesn't start a browser for each. The note says when it left some out.
const BOARDS_PER_EDIT: usize = 3;

/// What `layout_notes` starts with when it found nothing to report.
const CLEAN: &str = "Layout: nothing is cut off";

/// The entry for what one edit left unchecked, which no artboard has an id like.
const UNCHECKED: &str = "+unchecked";

/// One measurement at a time, across every design.
fn measuring() -> &'static tokio::sync::Semaphore {
    static SLOT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOT.get_or_init(|| tokio::sync::Semaphore::new(1))
}

#[derive(Default)]
struct Entry {
    /// Counts the edits to this artboard, so a measurement that finishes
    /// after a newer edit can tell it's out of date.
    generation: u64,
    note: Option<String>,
}

/// A note taken from the watch, to put on a result, or back if that result is an error.
pub(super) struct Taken {
    board: String,
    generation: u64,
    note: String,
}

impl Taken {
    pub(super) fn text(taken: &[Taken]) -> String {
        taken
            .iter()
            .map(|t| t.note.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Default)]
pub(super) struct LayoutWatch {
    /// By design id, then artboard id.
    boards: Mutex<HashMap<String, HashMap<String, Entry>>>,
}

impl LayoutWatch {
    /// Starts measuring the artboards `change` touched, and waits up to
    /// [`wait`] for it. What it finds is then waiting in [`Self::take`].
    pub(super) async fn after_edit(
        self: &Arc<Self>,
        design: &str,
        handle: &Arc<DesignHandle>,
        change: &Change,
    ) {
        let mut boards: Vec<String> = handle.read(|d| {
            let mut boards: Vec<String> = Vec::new();
            for op in &change.ops {
                if let Some(board) = d.doc().artboard_of(op.id())
                    && !boards.contains(&board.id)
                {
                    boards.push(board.id.clone());
                }
            }
            boards
        });
        let left_out = boards.len().saturating_sub(BOARDS_PER_EDIT);
        boards.truncate(BOARDS_PER_EDIT);
        let generation = self.bump(design, UNCHECKED);
        if left_out > 0 {
            self.finish(
                design,
                UNCHECKED,
                generation,
                Some(format!(
                    "Layout: this edit touched {} artboards and only the first {BOARDS_PER_EDIT} were checked. {} checks the rest.",
                    boards.len() + left_out,
                    layout_tool()
                )),
            );
        }
        let mut tasks = Vec::new();
        for board in boards {
            let generation = self.bump(design, &board);
            let (watch, handle, design) = (Arc::clone(self), Arc::clone(handle), design.to_owned());
            tasks.push(tokio::spawn(async move {
                // Let edits sent together all count before the first one measures.
                tokio::time::sleep(Duration::from_millis(25)).await;
                let Ok(_turn) = measuring().acquire().await else {
                    return;
                };
                if !watch.is_current(&design, &board, generation) {
                    return;
                }
                let note = measure(&handle, &board).await;
                watch.finish(&design, &board, generation, note);
            }));
        }
        // On time out the tasks carry on and leave their notes for later.
        let _ = tokio::time::timeout(wait(), futures::future::join_all(tasks)).await;
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

    fn is_current(&self, design: &str, board: &str, generation: u64) -> bool {
        let all = self.boards.lock().expect("layout watch lock");
        all.get(design)
            .and_then(|d| d.get(board))
            .is_some_and(|e| e.generation == generation)
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
    pub(super) fn take(&self, design: &str) -> Vec<Taken> {
        let mut all = self.boards.lock().expect("layout watch lock");
        let Some(boards) = all.get_mut(design) else {
            return Vec::new();
        };
        let mut taken: Vec<Taken> = boards
            .iter_mut()
            .filter_map(|(board, e)| {
                Some(Taken {
                    board: board.clone(),
                    generation: e.generation,
                    note: e.note.take()?,
                })
            })
            .collect();
        // Artboards in a steady order, the unchecked count last.
        taken.sort_by(|a, b| {
            (a.board == UNCHECKED, &a.board).cmp(&(b.board == UNCHECKED, &b.board))
        });
        taken
    }

    /// The `taken` notes whose artboard hasn't been edited since, which is
    /// the ones still true of the design. A tool that ran after they were
    /// taken may have fixed what they name.
    pub(super) fn still_current(&self, design: &str, taken: Vec<Taken>) -> Vec<Taken> {
        taken
            .into_iter()
            .filter(|t| self.is_current(design, &t.board, t.generation))
            .collect()
    }

    /// Puts back notes whose result failed, unless the artboard has been
    /// edited since.
    pub(super) fn restore(&self, design: &str, taken: Vec<Taken>) {
        let mut all = self.boards.lock().expect("layout watch lock");
        for t in taken {
            if let Some(entry) = all.get_mut(design).and_then(|d| d.get_mut(&t.board))
                && entry.generation == t.generation
                && entry.note.is_none()
            {
                entry.note = Some(t.note);
            }
        }
    }

    /// Forgets what's waiting on `design`, and cancels measurements under
    /// way: the design changed, or the agent is looking at the layout.
    pub(super) fn invalidate(&self, design: &str) {
        let mut all = self.boards.lock().expect("layout watch lock");
        for entry in all.get_mut(design).into_iter().flat_map(|d| d.values_mut()) {
            entry.generation += 1;
            entry.note = None;
        }
    }
}

/// What the layout check says about `board`, if it found anything.
async fn measure(handle: &DesignHandle, board: &str) -> Option<String> {
    let plan = handle
        .read(|d| screenshot::plan_measurement(d.view(), board, screenshot::Options::default()));
    let boxes = tokio::time::timeout(MEASURE_LIMIT, screenshot::layout(plan.ok()?))
        .await
        .ok()?
        .ok()?;
    let notes = handle.read(|d| layout_notes(d.view(), board, &boxes));
    if notes.is_empty() || notes.starts_with(CLEAN) {
        return None;
    }
    Some(format!(
        "{notes}\n(From checking artboard #{board} after your last edit. {} shows more.)",
        layout_tool()
    ))
}

/// The tool that shows the whole layout, as this surface names it.
fn layout_tool() -> &'static str {
    if super::doc6() {
        "render with output: \"layout\""
    } else {
        "get_layout"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(watch: &LayoutWatch, design: &str, board: &str, text: &str) {
        let g = watch.bump(design, board);
        watch.finish(design, board, g, Some(text.into()));
    }

    #[test]
    fn a_note_is_spent_once_it_is_read() {
        let watch = LayoutWatch::default();
        note(&watch, "d", "a", "clipped");
        assert_eq!(Taken::text(&watch.take("d")), "clipped");
        assert!(watch.take("d").is_empty());
    }

    #[test]
    fn a_measurement_from_before_a_newer_edit_is_dropped() {
        let watch = LayoutWatch::default();
        let old = watch.bump("d", "a");
        let new = watch.bump("d", "a");
        assert!(!watch.is_current("d", "a", old));
        watch.finish("d", "a", old, Some("stale".into()));
        assert!(watch.take("d").is_empty());
        watch.finish("d", "a", new, Some("fresh".into()));
        assert_eq!(Taken::text(&watch.take("d")), "fresh");
    }

    #[test]
    fn invalidating_clears_notes_and_cancels_measurements_under_way() {
        let watch = LayoutWatch::default();
        note(&watch, "d", "a", "clipped");
        let running = watch.bump("d", "b");
        watch.invalidate("d");
        assert!(!watch.is_current("d", "b", running));
        watch.finish("d", "b", running, Some("late".into()));
        assert!(watch.take("d").is_empty());
    }

    #[test]
    fn a_failed_result_gives_its_notes_back_unless_the_artboard_changed() {
        let watch = LayoutWatch::default();
        note(&watch, "d", "a", "kept");
        note(&watch, "d", "b", "replaced");
        let taken = watch.take("d");
        watch.bump("d", "b");
        watch.restore("d", taken);
        assert_eq!(Taken::text(&watch.take("d")), "kept");
    }

    #[test]
    fn a_note_is_not_current_once_its_artboard_is_edited() {
        let watch = LayoutWatch::default();
        note(&watch, "d", "a", "fixed since");
        note(&watch, "d", "b", "still true");
        let taken = watch.take("d");
        watch.bump("d", "a");
        assert_eq!(Taken::text(&watch.still_current("d", taken)), "still true");
    }

    #[test]
    fn notes_are_kept_per_design() {
        let watch = LayoutWatch::default();
        note(&watch, "d1", "a", "note d1");
        note(&watch, "d2", "a", "note d2");
        watch.invalidate("d1");
        assert!(watch.take("d1").is_empty());
        assert_eq!(Taken::text(&watch.take("d2")), "note d2");
    }
}
