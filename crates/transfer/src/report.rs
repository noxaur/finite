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

/// What an import refused to write into the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// An attribute, or the `src` of a script: code.
    Attribute,
    /// A `<script>` element.
    Script,
    /// Any other element, such as an `<iframe>`.
    Embed,
}

impl Refused {
    /// What a parser's [`finite_design::html::Dropped`] was.
    pub fn of(dropped: &finite_design::html::Dropped) -> Self {
        if dropped.element {
            Self::element(&dropped.what)
        } else {
            Self::Attribute
        }
    }
}

impl Refused {
    /// What a refused element is, from the `<tag>` the parsers report.
    pub fn element(what: &str) -> Self {
        if what == "<script>" {
            Self::Script
        } else {
            Self::Embed
        }
    }
}

impl Diagnostic {
    /// A loss in `feature`, scored `[preserved, visual, editable]`. It has no
    /// node or path yet: add them with [`Diagnostic::on`] and [`Diagnostic::at`].
    pub fn new(
        feature: Feature,
        what: impl Into<String>,
        reason: impl Into<String>,
        [preserved, visual, editable]: [Score; 3],
    ) -> Self {
        Self {
            node: None,
            path: String::new(),
            what: what.into(),
            feature,
            reason: reason.into(),
            preserved,
            visual,
            editable,
            quarantined: false,
        }
    }

    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = path.into();
        self
    }

    pub fn on(mut self, node: &str) -> Self {
        self.node = Some(node.to_owned());
        self
    }

    /// Content an import left out of the document because it could run code
    /// or load another document. All of it stays in the import's original
    /// bytes, so it's preserved but not editable. `refused` says which kind
    /// it was, whatever `what` looks like. A script might change how the page
    /// looks once it runs, or not; an embed shows something Finite won't.
    pub fn quarantined(
        path: impl Into<String>,
        what: impl Into<String>,
        refused: Refused,
        reason: &str,
    ) -> Self {
        let what = what.into();
        let (feature, visual) = if refused == Refused::Embed {
            (Feature::Embed, Score::No)
        } else {
            (Feature::Script, Score::Unknown)
        };
        Self {
            quarantined: true,
            ..Self::new(feature, what, reason, [Score::Yes, visual, Score::No]).at(path)
        }
    }

    /// The design points at a file its store doesn't have.
    pub fn missing_file(path: impl Into<String>, what: impl Into<String>) -> Self {
        Self::new(
            Feature::Image,
            what,
            "the design points at a file its store doesn't have",
            [Score::No; 3],
        )
        .at(path)
    }

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
