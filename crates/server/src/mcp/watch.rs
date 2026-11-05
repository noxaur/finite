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
//! An edit's note reports what that edit changed. Each check remembers what it
//! found on the artboard, and the next one lists a finding only if it's new
//! or about a node the edit touched (or one around it). It counts the rest in
//! one line. Designs often carry a finding that is on purpose or not worth
//! fixing, and repeating it on every edit taught agents to switch the check
//! off, which hid the real regressions too.
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
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use finite_design::{Change, Document};

use super::layout::{Found, Named, Report, Texts};
use crate::{hub::DesignHandle, screenshot};

/// How long a doc6 edit waits at least: its check is on by default, and AX
/// runs saw a cold browser miss the classic wait on most first edits, so
/// agents rendered to find out instead.
const DOC6_WAIT: Duration = Duration::from_secs(5);

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

/// The entry for what one edit left unchecked, which no artboard has an id like.
const UNCHECKED: &str = "+unchecked";

/// Stands among an artboard's touched nodes when its `<style>` block changed,
/// which restyles elements without editing them: all of its findings count
/// as touched. No node has an id like it.
const RESTYLED: &str = "+restyled";

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
    /// What the check behind `note` found, as `Found::key`s. It becomes
    /// `seen` once a response carries the note ([`LayoutWatch::deliver`]), so
    /// a note that never reaches the agent doesn't hide what it said from the
    /// next one.
    found: Option<HashSet<u64>>,
    /// The nodes edited since the last check the agent heard about, which the
    /// next check reports on. Edits sent together share one check.
    touched: HashSet<String>,
    /// What the last check the agent heard about found, as `Found::key`s.
    /// `None` before the first, when everything counts as new.
    seen: Option<HashSet<u64>>,
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
    /// Whose tools the notes name.
    surface: super::Surface,
}

impl LayoutWatch {
    pub(super) fn new(surface: super::Surface) -> Self {
        Self {
            surface,
            ..Self::default()
        }
    }

    /// Starts measuring the artboards `change` touched, and waits up to
    /// [`wait`] for it. What it finds is then waiting in [`Self::take`].
    /// Returns whether every artboard it touched was measured in time and
    /// had nothing to report.
    pub(super) async fn after_edit(
        self: &Arc<Self>,
        design: &str,
        handle: &Arc<DesignHandle>,
        change: &Change,
    ) -> bool {
        let touched: HashSet<String> = change
            .ops
            .iter()
            .map(|op| op.id())
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect();
        let (mut boards, restyled): (Vec<String>, HashSet<String>) = handle.read(|d| {
            let doc = d.doc();
            let in_sheet = |id: &str| {
                let is_style = |n: &finite_design::Node| {
                    n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style"))
                };
                doc.get(id).is_some_and(|n| {
                    is_style(n)
                        || n.parent
                            .as_deref()
                            .and_then(|p| doc.get(p))
                            .is_some_and(is_style)
                })
            };
            let mut boards: Vec<String> = Vec::new();
            let mut restyled = HashSet::new();
            for op in &change.ops {
                if let Some(board) = doc.artboard_of(op.id()) {
                    if !boards.contains(&board.id) {
                        boards.push(board.id.clone());
                    }
                    if in_sheet(op.id()) {
                        restyled.insert(board.id.clone());
                    }
                }
            }
            (boards, restyled)
        });
        let left_out = boards.len().saturating_sub(BOARDS_PER_EDIT);
        boards.truncate(BOARDS_PER_EDIT);
        let generation = self.bump(design, UNCHECKED);
        if left_out > 0 {
            self.finish(
                design,
                UNCHECKED,
                generation,
                Some(Measured {
                    note: Some(format!(
                        "Layout: this edit touched {} artboards and only the first {BOARDS_PER_EDIT} were checked. {} checks the rest.",
                        boards.len() + left_out,
                        layout_tool(self.surface)
                    )),
                    found: HashSet::new(),
                }),
            );
        }
        let mut tasks = Vec::new();
        for board in boards {
            let generation = self.bump(design, &board);
            let mut touched = touched.clone();
            if restyled.contains(&board) {
                touched.insert(RESTYLED.to_owned());
            }
            self.touch(design, &board, &touched);
            let (watch, handle, design) = (Arc::clone(self), Arc::clone(handle), design.to_owned());
            tasks.push(tokio::spawn(async move {
                // Let edits sent together all count before the first one measures.
                tokio::time::sleep(Duration::from_millis(25)).await;
                let Ok(_turn) = measuring().acquire().await else {
                    return false;
                };
                if !watch.is_current(&design, &board, generation) {
                    return false;
                }
                let (touched, before) = watch.checked_so_far(&design, &board);
                let measured = measure(&handle, &board, watch.surface, &touched, before).await;
                let clean = matches!(&measured, Some(m) if m.note.is_none());
                watch.finish(&design, &board, generation, measured);
                clean
            }));
        }
        // On time out the tasks carry on and leave their notes for later.
        let wait = if self.surface.doc6() {
            wait().max(DOC6_WAIT)
        } else {
            wait()
        };
        match tokio::time::timeout(wait, futures::future::join_all(tasks)).await {
            Ok(done) => {
                left_out == 0 && !done.is_empty() && done.into_iter().all(|d| d.unwrap_or(false))
            }
            Err(_) => false,
        }
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
        entry.found = None;
        entry.generation
    }

    /// Adds `ids` to the nodes the next check of `board` reports on.
    fn touch(&self, design: &str, board: &str, ids: &HashSet<String>) {
        let mut all = self.boards.lock().expect("layout watch lock");
        if let Some(entry) = all.get_mut(design).and_then(|d| d.get_mut(board)) {
            entry.touched.extend(ids.iter().cloned());
        }
    }

    /// The nodes edited since `board` was last checked, and what that check
    /// found.
    fn checked_so_far(&self, design: &str, board: &str) -> (HashSet<String>, Option<HashSet<u64>>) {
        let all = self.boards.lock().expect("layout watch lock");
        all.get(design)
            .and_then(|d| d.get(board))
            .map_or_else(Default::default, |e| (e.touched.clone(), e.seen.clone()))
    }

    fn is_current(&self, design: &str, board: &str, generation: u64) -> bool {
        let all = self.boards.lock().expect("layout watch lock");
        all.get(design)
            .and_then(|d| d.get(board))
            .is_some_and(|e| e.generation == generation)
    }

    /// Keeps what a check found for [`Self::take`], unless the artboard was
    /// edited meanwhile. A check with nothing to say is heard about already.
    fn finish(&self, design: &str, board: &str, generation: u64, measured: Option<Measured>) {
        let mut all = self.boards.lock().expect("layout watch lock");
        if let Some(entry) = all.get_mut(design).and_then(|d| d.get_mut(board))
            && entry.generation == generation
        {
            match measured {
                Some(Measured { note: None, found }) => {
                    entry.seen = Some(found);
                    entry.touched.clear();
                    entry.note = None;
                }
                Some(Measured { note, found }) => {
                    entry.note = note;
                    entry.found = Some(found);
                }
                None => entry.note = None,
            }
        }
    }

    /// Counts what a note that reached the agent said as heard.
    fn heard(entry: &mut Entry) {
        if let Some(found) = entry.found.take() {
            entry.seen = Some(found);
            entry.touched.clear();
        }
    }

    /// The notes waiting on `design`, which are then spent unless
    /// [`Self::restore`]d. They aren't heard until a response carries them
    /// ([`Self::deliver`]).
    pub(super) fn take(&self, design: &str) -> Vec<Taken> {
        let mut all = self.boards.lock().expect("layout watch lock");
        let Some(boards) = all.get_mut(design) else {
            return Vec::new();
        };
        let mut taken: Vec<Taken> = boards
            .iter_mut()
            .filter_map(|(board, e)| {
                let note = e.note.take()?;
                Some(Taken {
                    board: board.clone(),
                    generation: e.generation,
                    note,
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
    /// the ones still true of the design, and which the response carrying
    /// them tells the agent. A tool that ran after they were taken may have
    /// fixed what the rest name, so those are dropped and not counted as heard.
    pub(super) fn deliver(&self, design: &str, taken: Vec<Taken>) -> Vec<Taken> {
        let mut all = self.boards.lock().expect("layout watch lock");
        taken
            .into_iter()
            .filter(|t| {
                let Some(entry) = all.get_mut(design).and_then(|d| d.get_mut(&t.board)) else {
                    return false;
                };
                if entry.generation != t.generation {
                    return false;
                }
                Self::heard(entry);
                true
            })
            .collect()
    }

    /// The notes waiting on `design` for a result that is being built now
    /// and carries them: taken, and heard.
    pub(super) fn take_for_result(&self, design: &str) -> Vec<Taken> {
        self.deliver(design, self.take(design))
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
            entry.found = None;
        }
    }
}

/// What a layout check of one artboard came to.
struct Measured {
    /// What to tell the agent, or `None` when there is nothing to tell.
    note: Option<String>,
    /// Every finding, as `Found::key`s, whether the note lists it or not.
    found: HashSet<u64>,
}

/// The nodes an edit touched and everything above them, to tell whether a
/// finding is about something the edit changed.
struct Touched<'a> {
    doc: &'a Document,
    /// The artboard's `<style>` block changed, so anything in it may have.
    restyled: bool,
    nodes: HashSet<&'a str>,
    /// The touched nodes and their ancestors.
    above: HashSet<String>,
}

impl<'a> Touched<'a> {
    /// The nodes of `ids` that are in `doc`, other than `board`: editing the
    /// artboard itself (its size, say) is judged by what is new afterwards.
    fn new(doc: &'a Document, board: &str, ids: &'a HashSet<String>) -> Self {
        let nodes: HashSet<&str> = ids
            .iter()
            .map(String::as_str)
            .filter(|id| *id != board && doc.contains(id))
            .collect();
        let mut above = HashSet::new();
        for id in &nodes {
            let mut current = Some(*id);
            while let Some(c) = current {
                if !above.insert(c.to_owned()) {
                    break;
                }
                current = doc.get(c).and_then(|n| n.parent.as_deref());
            }
        }
        Self {
            doc,
            restyled: ids.contains(RESTYLED),
            nodes,
            above,
        }
    }

    /// Whether `id` is a touched node, holds one, or is inside one.
    fn reaches(&self, id: &str) -> bool {
        if self.restyled || self.above.contains(id) {
            return true;
        }
        let mut current = Some(id);
        while let Some(c) = current {
            if self.nodes.contains(c) {
                return true;
            }
            current = self.doc.get(c).and_then(|n| n.parent.as_deref());
        }
        false
    }
}

/// What the layout check says about `board`. `touched` is what edits since
/// the last check changed, and `before` what that check found: the note lists
/// findings that are new or about touched nodes, and counts the rest. `None`
/// when it couldn't measure the artboard.
async fn measure(
    handle: &DesignHandle,
    board: &str,
    surface: super::Surface,
    touched: &HashSet<String>,
    before: Option<HashSet<u64>>,
) -> Option<Measured> {
    // `seq` says which document the browser measures. A later read that sees
    // another one drops the note: a person's edit doesn't bump the watch's
    // generation, and the boxes would describe a design that's gone.
    let (plan, seq) = handle.read(|d| {
        (
            screenshot::plan_measurement(d.view(), board, screenshot::Options::default()),
            d.seq(),
        )
    });
    let boxes = tokio::time::timeout(MEASURE_LIMIT, screenshot::layout(plan.ok()?))
        .await
        .ok()?
        .ok()?;
    // Everything that reads the document is read here, in one go, so the
    // pairs of overlapping text are compared and keyed without holding it.
    let (report, texts, reaching) = handle.read(|d| {
        if d.seq() != seq {
            return None;
        }
        let doc = d.view();
        let touched = Touched::new(doc, board, touched);
        Some((
            Report::new(doc, board, &boxes, surface),
            // doc6 promises overlapping text too, as get_layout reports it.
            surface.doc6().then(|| Texts::new(doc, &boxes)),
            boxes
                .iter()
                .map(|b| b.id.as_str())
                .filter(|id| touched.reaches(id))
                .collect::<HashSet<&str>>(),
        ))
    })?;
    let report = match (texts, boxes.first()) {
        (Some(texts), Some(board)) => report.with_overlaps(board, &texts),
        _ => report,
    };
    let keys: Vec<u64> = report.found.iter().map(Found::key).collect();
    let kept: Vec<&Found> = report
        .found
        .iter()
        .zip(&keys)
        .filter(|(f, key)| {
            before.as_ref().is_none_or(|b| !b.contains(key)) || f.any_node(|n| reaching.contains(n))
        })
        .map(|(f, _)| f)
        .collect();
    let hidden = report.found.len() - kept.len();
    // Only the lines of the findings named are written under the lock, from
    // the document that was measured.
    let named = Named::new(&kept);
    let notes = if named.is_empty() {
        String::new()
    } else {
        handle.read(|d| (d.seq() == seq).then(|| report.text(d.view(), &named)))?
    };
    let found: HashSet<u64> = keys.into_iter().collect();
    let tool = layout_tool(surface);
    let note = match (notes.is_empty(), hidden) {
        (true, 0) => None,
        (true, n) => Some(format!(
            "Layout: {n} earlier note{} on artboard #{board} unchanged by this edit; {tool} shows {}.",
            if n == 1 { "" } else { "s" },
            if n == 1 { "it" } else { "them" },
        )),
        (false, 0) => Some(format!(
            "{notes}\n(From checking artboard #{board} after your last edit. {tool} shows more.)"
        )),
        (false, n) => Some(format!(
            "{notes}\n(From checking artboard #{board} after your last edit. {n} earlier note{} unchanged; {tool} shows {}.)",
            if n == 1 { "" } else { "s" },
            if n == 1 { "it" } else { "them" },
        )),
    };
    Some(Measured { note, found })
}

/// The tool that shows the whole layout, as this surface names it.
fn layout_tool(surface: super::Surface) -> &'static str {
    if surface.doc6() {
        "render with output: \"layout\""
    } else {
        "get_layout"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured(note: &str, found: &[u64]) -> Option<Measured> {
        Some(Measured {
            note: Some(note.into()),
            found: found.iter().copied().collect(),
        })
    }

    fn note(watch: &LayoutWatch, design: &str, board: &str, text: &str) {
        let g = watch.bump(design, board);
        watch.finish(design, board, g, measured(text, &[1]));
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
        watch.finish("d", "a", old, measured("stale", &[1]));
        assert!(watch.take("d").is_empty());
        watch.finish("d", "a", new, measured("fresh", &[1]));
        assert_eq!(Taken::text(&watch.take("d")), "fresh");
    }

    #[test]
    fn invalidating_clears_notes_and_cancels_measurements_under_way() {
        let watch = LayoutWatch::default();
        note(&watch, "d", "a", "clipped");
        let running = watch.bump("d", "b");
        watch.invalidate("d");
        assert!(!watch.is_current("d", "b", running));
        watch.finish("d", "b", running, measured("late", &[1]));
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
        assert_eq!(Taken::text(&watch.deliver("d", taken)), "still true");
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

    #[test]
    fn what_a_note_found_counts_as_heard_once_the_note_is_taken() {
        let watch = LayoutWatch::default();
        let seen = |watch: &LayoutWatch| watch.checked_so_far("d", "a").1;
        // Replaced before anyone took it, so the agent never heard it.
        let g = watch.bump("d", "a");
        watch.touch("d", "a", &HashSet::from(["n".to_owned()]));
        watch.finish("d", "a", g, measured("lost", &[10]));
        watch.bump("d", "a");
        assert_eq!(seen(&watch), None);
        assert!(watch.checked_so_far("d", "a").0.contains("n"));
        // Taken, so it was.
        let g = watch.bump("d", "a");
        watch.finish("d", "a", g, measured("heard", &[10]));
        watch.deliver("d", watch.take("d"));
        assert_eq!(seen(&watch), Some(HashSet::from([10])));
        assert!(watch.checked_so_far("d", "a").0.is_empty());
    }

    #[test]
    fn a_note_the_response_drops_was_not_heard() {
        let watch = LayoutWatch::default();
        let g = watch.bump("d", "a");
        watch.touch("d", "a", &HashSet::from(["n".to_owned()]));
        watch.finish("d", "a", g, measured("dropped", &[10]));
        // The next edit takes it, then bumps the artboard, so its response
        // leaves the note out.
        let taken = watch.take("d");
        watch.bump("d", "a");
        assert!(watch.deliver("d", taken).is_empty());
        let (touched, seen) = watch.checked_so_far("d", "a");
        assert_eq!(seen, None);
        assert!(touched.contains("n"));
        // A note a response does carry is heard, and only then.
        let g = watch.bump("d", "a");
        watch.finish("d", "a", g, measured("delivered", &[11]));
        let taken = watch.take("d");
        assert_eq!(Taken::text(&watch.deliver("d", taken)), "delivered");
        let (touched, seen) = watch.checked_so_far("d", "a");
        assert_eq!(seen, Some(HashSet::from([11])));
        assert!(touched.is_empty());
    }
}
