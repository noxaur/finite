use finite_design::NodeId;
use serde::Serialize;

use crate::Feature;

/// One thing a conversion couldn't carry over exactly. A codec returns these
/// as values; it never logs a loss and moves on.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// The Finite node it's about. For an import, the nearest node that was
    /// kept; `None` until the import is placed in a design.
    pub node: Option<NodeId>,
    /// Where it is in the source, in the codec's notation.
    pub path: String,
    /// What it was, like `<iframe>` or `onclick`.
    pub what: String,
    pub feature: Feature,
    pub reason: String,
    pub preserved: Score,
    pub visual: Score,
    pub editable: Score,
    /// Kept out of the document because it could run code. It's still in
    /// the import's original bytes.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub quarantined: bool,
}

impl Diagnostic {
    pub fn score(&self, axis: Axis) -> Score {
        match axis {
            Axis::Preserved => self.preserved,
            Axis::Visual => self.visual,
            Axis::Editable => self.editable,
        }
    }
}

/// Whether one aspect of the source survived.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Score {
    Yes,
    No,
    /// Nobody checked, so it can't count as a yes.
    Unknown,
}

/// The aspects a [`Diagnostic`] scores separately. Content can be preserved
/// without being visible or editable, so one "lossy" flag can't say enough.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    /// The data is kept.
    Preserved,
    /// It looks the same.
    Visual,
    /// You can change it in Finite.
    Editable,
}

impl Axis {
    pub fn name(self) -> &'static str {
        match self {
            Axis::Preserved => "preserved",
            Axis::Visual => "visual",
            Axis::Editable => "editable",
        }
    }
}

/// Strict mode: the diagnostics that score anything but [`Score::Yes`] on
/// one of the `required` axes. A strict conversion fails when any do.
pub fn violations<'a>(diagnostics: &'a [Diagnostic], required: &[Axis]) -> Vec<&'a Diagnostic> {
    diagnostics
        .iter()
        .filter(|d| required.iter().any(|&axis| d.score(axis) != Score::Yes))
        .collect()
}
