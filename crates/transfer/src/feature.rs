use serde::Serialize;

/// Something a design can contain that a format may or may not express.
///
/// Every codec says what it does with every feature in an exhaustive
/// `match` (see [`crate::Codec::support`]). So adding a variant here stops
/// the build until each codec has an answer, and `SUPPORT.md` shows the
/// answers side by side.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Feature {
    /// A box that holds other layers: a `<div>`, a Figma frame.
    Frame,
    Text,
    /// A background or text color with no gradient.
    SolidFill,
    Image,
    /// Children laid out in a row or column, with gaps and alignment.
    FlexLayout,
    /// Code that runs: `<script>`, event handler attributes.
    Script,
    /// Content from somewhere else: `<iframe>`, `<object>`, `<link>`.
    Embed,
    /// The design's import records, and the original files behind them.
    ImportHistory,
    /// An instance of a component. No format has components, so an export
    /// writes what the instance shows as plain elements.
    Instance,
}

impl Feature {
    /// Every feature, in the order [`Feature::position`] gives.
    pub const ALL: [Feature; 9] = [
        Feature::Frame,
        Feature::Text,
        Feature::SolidFill,
        Feature::Image,
        Feature::FlexLayout,
        Feature::Script,
        Feature::Embed,
        Feature::ImportHistory,
        Feature::Instance,
    ];

    /// Where the feature is in [`Feature::ALL`]. An exhaustive match, so a
    /// new variant can't be left out of `ALL` without a test failing.
    #[cfg(test)]
    const fn position(self) -> usize {
        match self {
            Feature::Frame => 0,
            Feature::Text => 1,
            Feature::SolidFill => 2,
            Feature::Image => 3,
            Feature::FlexLayout => 4,
            Feature::Script => 5,
            Feature::Embed => 6,
            Feature::ImportHistory => 7,
            Feature::Instance => 8,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Feature::Frame => "frame",
            Feature::Text => "text",
            Feature::SolidFill => "solid fill",
            Feature::Image => "image",
            Feature::FlexLayout => "flex layout",
            Feature::Script => "script",
            Feature::Embed => "embed",
            Feature::ImportHistory => "import history",
            Feature::Instance => "component instance",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// From the format into Finite.
    Import,
    /// From Finite into the format.
    Export,
}

/// What a codec can do with a feature in one direction. This is capability,
/// not evidence: what one conversion actually did is in its diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    /// Converted, looks the same, and stays editable.
    Exact,
    /// Converted and editable, but may look different.
    Approximate,
    /// Kept in the original bytes, but not as anything you can see or edit.
    Opaque,
    /// Not handled.
    Unsupported,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_lists_every_feature_once() {
        for (i, feature) in Feature::ALL.iter().enumerate() {
            assert_eq!(feature.position(), i, "{feature:?}");
        }
    }
}
