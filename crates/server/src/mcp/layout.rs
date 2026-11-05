//! The layout check: what a measured artboard says about content cut off at
//! its edge, text that runs past its box, and text that overlaps text.
//!
//! [`Report::new`] turns the boxes Chrome measured (`screenshot::ElementBox`)
//! into a list of [`Found`] items. [`Report::text`] writes them as a note, all
//! of them for `render` and a filtered few for an edit's result (see
//! `watch.rs`).

use std::fmt::Write;

use finite_design::Document;

use super::format::outline;
use crate::screenshot::ElementBox;

/// How many elements a layout note names before it says how many more.
const LAYOUT_NAMED: usize = 8;

/// How many text elements the overlap check compares, so a huge artboard
/// stays fast. It compares every pair, so this is at most about 2 million.
const OVERLAP_CHECKED: usize = 2_000;

/// One thing the layout check found.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Found {
    /// An element reaching past the artboard's edge that nothing clips,
    /// with where its far corner is, from the artboard's top-left.
    Cut { id: String, x: f64, y: f64 },
    /// An element whose text runs past its box, across and down.
    Spill { id: String, over: (f64, f64) },
    /// Two text elements overlapping by `w` × `h`.
    Overlap {
        a: String,
        b: String,
        w: f64,
        h: f64,
    },
}

impl Found {
    /// Names this finding across checks, so a later check can tell it's the
    /// same one: the same kind of problem on the same elements.
    pub(super) fn key(&self) -> String {
        match self {
            Found::Cut { id, .. } => format!("cut:{id}"),
            Found::Spill { id, .. } => format!("spill:{id}"),
            Found::Overlap { a, b, .. } => format!("overlap:{a}:{b}"),
        }
    }

    /// The elements it's about.
    pub(super) fn nodes(&self) -> Vec<&str> {
        match self {
            Found::Cut { id, .. } | Found::Spill { id, .. } => vec![id],
            Found::Overlap { a, b, .. } => vec![a, b],
        }
    }
}

/// What the layout check found in one artboard.
#[derive(Debug, Default)]
pub(super) struct Report {
    /// The note's opening about content cut off, up to the elements it names.
    cut_header: String,
    pub(super) found: Vec<Found>,
    /// What to say when `found` has no cut-off content and no spilling text.
    clear: String,
}

/// What shows of `b`, as (left, top, right, bottom): its box inside the
/// artboard and the scrollers around it.
fn shown(b: &ElementBox, board: &ElementBox) -> (f64, f64, f64, f64) {
    let (mut l, mut t) = (b.x.max(board.x), b.y.max(board.y));
    let (mut r, mut d) = (
        (b.x + b.width).min(board.x + board.width),
        (b.y + b.height).min(board.y + board.height),
    );
    if let Some(v) = &b.visible {
        (l, t) = (l.max(v.x), t.max(v.y));
        (r, d) = (r.min(v.x + v.width), d.min(v.y + v.height));
    }
    (l, t, r, d)
}

/// An outline line for `id`, without its children.
fn line(doc: &Document, id: &str) -> String {
    outline(doc, id, 0)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_owned()
}

impl Report {
    /// Content cut off at `artboard`'s edges, and text that runs past its
    /// own box. Agents only spotted these in the image before, and often
    /// didn't, so the note names the elements and says what to change.
    ///
    /// Content that an ancestor clips (a scroller, an `<svg>`, a `clip-path`)
    /// isn't cut off by the artboard, so it isn't counted. Growing the
    /// artboard is suggested only for what is a direct child of it, in the
    /// flow: that's the content a taller artboard makes room for.
    pub(super) fn new(
        doc: &Document,
        artboard: &str,
        boxes: &[ElementBox],
        surface: super::Surface,
    ) -> Self {
        use std::collections::{HashMap, HashSet};
        let by_id: HashMap<&str, &ElementBox> = boxes.iter().map(|b| (b.id.as_str(), b)).collect();
        let Some(board) = by_id.get(artboard) else {
            return Self::default();
        };
        let (bottom, right) = (board.y + board.height, board.x + board.width);
        let below = |b: &ElementBox| b.y + b.height > bottom + 1.0 && !b.clipped.1;
        let beyond = |b: &ElementBox| b.x + b.width > right + 1.0 && !b.clipped.0;
        // Elements reaching past the artboard's bottom or right edge. Only
        // the outermost is named: its children stick out because it does.
        let out: HashSet<&str> = boxes
            .iter()
            .filter(|b| b.id != artboard && (below(b) || beyond(b)))
            .map(|b| b.id.as_str())
            .collect();
        let mut report = Self::default();
        if !out.is_empty() {
            let content_bottom = boxes
                .iter()
                .filter(|b| !b.clipped.1)
                .map(|b| b.y + b.height)
                .fold(bottom, f64::max)
                - board.y;
            let content_right = boxes
                .iter()
                .filter(|b| !b.clipped.0)
                .map(|b| b.x + b.width)
                .fold(right, f64::max)
                - board.x;
            let outermost: Vec<&ElementBox> = boxes
                .iter()
                .filter(|b| out.contains(b.id.as_str()))
                .filter(|b| {
                    doc.get(&b.id)
                        .and_then(|n| n.parent.as_deref())
                        .is_none_or(|p| !out.contains(p))
                })
                .collect();
            let mut text = String::from("Layout: content is cut off by the artboard's edge.");
            if content_bottom > board.height + 1.0 {
                let _ = write!(
                    text,
                    " It is {content_bottom:.0} px tall, but the artboard is {:.0} px.",
                    board.height
                );
                // A taller artboard only makes room for what is laid out in it.
                let fits = outermost
                    .iter()
                    .filter(|b| {
                        below(b)
                            && !b.out_of_flow
                            && doc
                                .get(&b.id)
                                .is_some_and(|n| n.parent.as_deref() == Some(artboard))
                    })
                    .map(|b| b.y + b.height - board.y)
                    .fold(None, |most: Option<f64>, y| {
                        Some(most.map_or(y, |m| m.max(y)))
                    });
                if let Some(height) = fits {
                    let _ = write!(
                        text,
                        " If it should all show, make the artboard taller with {}.",
                        if surface.doc6() {
                            format!(
                                "{{\"op\": \"css\", \"css\": \"#{artboard} {{ height: {height:.0}px }}\"}}"
                            )
                        } else {
                            format!(
                                "update_styles {{\"updates\": [{{\"nodeIds\": [\"{artboard}\"], \"styles\": {{\"height\": \"{height:.0}px\"}}}}]}}"
                            )
                        }
                    );
                }
            }
            if content_right > board.width + 1.0 {
                let _ = write!(
                    text,
                    " It is {content_right:.0} px wide, but the artboard is {:.0} px.",
                    board.width
                );
            }
            report.cut_header = text;
            report.found.extend(outermost.iter().map(|b| Found::Cut {
                id: b.id.clone(),
                x: b.x + b.width - board.x,
                y: b.y + b.height - board.y,
            }));
        }
        report.found.extend(
            boxes
                .iter()
                // Down, a few pixels is a tall glyph, like an emoji, in a tight line height.
                .filter(|b| b.text_overflow.0 > 2.0 || b.text_overflow.1 > 8.0)
                .map(|b| Found::Spill {
                    id: b.id.clone(),
                    over: b.text_overflow,
                }),
        );
        let used = boxes
            .iter()
            .filter(|b| b.id != artboard)
            .map(|b| b.y + b.height)
            .fold(board.y, f64::max)
            - board.y;
        report.clear = format!(
            "Layout: nothing is cut off, and no text overflows. The lowest element ends at y {used:.0}; the artboard is {:.0} px tall.",
            board.height
        );
        report
    }

    /// Adds the text elements in `boxes` that overlap each other, other
    /// than an element and what's inside it. Only what shows counts: the part
    /// of each inside the `board` and the scrollers around it, so a long list
    /// in a scroller doesn't overlap what sits below it.
    pub(super) fn with_overlaps(
        mut self,
        doc: &Document,
        board: &ElementBox,
        boxes: &[ElementBox],
    ) -> Self {
        let text: Vec<&ElementBox> = boxes
            .iter()
            .filter(|b| b.has_text && b.width > 0.0 && b.height > 0.0)
            .take(OVERLAP_CHECKED)
            .collect();
        for (i, a) in text.iter().enumerate() {
            for b in &text[i + 1..] {
                let (a_box, b_box) = (shown(a, board), shown(b, board));
                let (w, h) = (
                    a_box.2.min(b_box.2) - a_box.0.max(b_box.0),
                    a_box.3.min(b_box.3) - a_box.1.max(b_box.1),
                );
                if w > 2.0
                    && h > 2.0
                    && !doc.is_ancestor(&a.id, &b.id)
                    && !doc.is_ancestor(&b.id, &a.id)
                {
                    self.found.push(Found::Overlap {
                        a: a.id.clone(),
                        b: b.id.clone(),
                        w,
                        h,
                    });
                }
            }
        }
        self
    }

    /// The notes for the findings `keep` accepts, and how many it left out.
    /// Empty when there is nothing to say.
    pub(super) fn text(&self, doc: &Document, keep: impl Fn(&Found) -> bool) -> (String, usize) {
        let kept: Vec<&Found> = self.found.iter().filter(|f| keep(f)).collect();
        let hidden = self.found.len() - kept.len();
        let more = |text: &mut String, shown: usize| {
            if shown > LAYOUT_NAMED {
                let _ = write!(text, "\n  … and {} more", shown - LAYOUT_NAMED);
            }
        };
        let mut notes = Vec::new();

        let cut: Vec<&&Found> = kept
            .iter()
            .filter(|f| matches!(f, Found::Cut { .. }))
            .collect();
        if !cut.is_empty() {
            let mut text = format!("{} Sticking out:", self.cut_header);
            for f in cut.iter().take(LAYOUT_NAMED) {
                if let Found::Cut { id, x, y } = f {
                    let _ = write!(text, "\n  {} (ends at x {x:.0}, y {y:.0})", line(doc, id));
                }
            }
            more(&mut text, cut.len());
            notes.push(text);
        }

        let spilling: Vec<&&Found> = kept
            .iter()
            .filter(|f| matches!(f, Found::Spill { .. }))
            .collect();
        if !spilling.is_empty() {
            let mut text =
                String::from("Layout: text runs past its box, so it may overlap or be clipped:");
            for f in spilling.iter().take(LAYOUT_NAMED) {
                let Found::Spill { id, over } = f else {
                    continue;
                };
                let _ = write!(text, "\n  {} ", line(doc, id));
                match *over {
                    (x, y) if x > 2.0 && y > 8.0 => {
                        let _ = write!(text, "({x:.0} px too wide, {y:.0} px too tall)");
                    }
                    (x, _) if x > 2.0 => {
                        let _ = write!(text, "({x:.0} px too wide)");
                    }
                    (_, y) => {
                        let _ = write!(text, "({y:.0} px too tall)");
                    }
                }
            }
            more(&mut text, spilling.len());
            notes.push(text);
        }

        let pairs: Vec<&&Found> = kept
            .iter()
            .filter(|f| matches!(f, Found::Overlap { .. }))
            .collect();
        if !pairs.is_empty() {
            let mut text = format!(
                "Layout: {} pair{} of text elements overlap. Check that's intended, like a badge over a card:",
                pairs.len(),
                if pairs.len() == 1 { "" } else { "s" }
            );
            for f in pairs.iter().take(LAYOUT_NAMED) {
                if let Found::Overlap { a, b, w, h } = f {
                    let _ = write!(
                        text,
                        "\n  {} and {} ({w:.0} × {h:.0} px)",
                        line(doc, a),
                        line(doc, b)
                    );
                }
            }
            more(&mut text, pairs.len());
            notes.push(text);
        }
        (notes.join("\n"), hidden)
    }
}

/// The layout check on `boxes`: content cut off at the artboard's edges and
/// text that runs past its box, or a line saying there's none.
pub(super) fn layout_notes(
    doc: &Document,
    artboard: &str,
    boxes: &[ElementBox],
    surface: super::Surface,
) -> String {
    let report = Report::new(doc, artboard, boxes, surface);
    let (notes, _) = report.text(doc, |_| true);
    if notes.is_empty() {
        report.clear
    } else {
        notes
    }
}

/// The layout check's note on text elements in `boxes` that overlap
/// each other, other than an element and what's inside it.
pub(super) fn overlap_note(
    doc: &Document,
    board: &ElementBox,
    boxes: &[ElementBox],
) -> Option<String> {
    let report = Report::default().with_overlaps(doc, board, boxes);
    let (notes, _) = report.text(doc, |_| true);
    (!notes.is_empty()).then_some(notes)
}
