//! Auto layout as flexbox, and where each layer sits in its parent.

use super::{Place, Styles, Walk, num, px};
use crate::{
    Feature, Score,
    figma::payload::{AutoLayout, FigNode},
};

impl Walk<'_> {
    /// Whether `layout` lays children out in a row (`true`) or a column,
    /// or `None` when it doesn't lay them out at all.
    pub(super) fn flow(
        &mut self,
        me: Option<usize>,
        id: &str,
        layout: &AutoLayout,
    ) -> Option<bool> {
        self.unknown(
            me,
            &format!("{id}/layout"),
            &layout.extra,
            Feature::FlexLayout,
        );
        match layout.mode.as_str() {
            "HORIZONTAL" => Some(true),
            "VERTICAL" => Some(false),
            "NONE" => None,
            other => {
                self.report(
                    me,
                    &format!("{id}/layout/mode"),
                    format!("{other} auto layout"),
                    Feature::FlexLayout,
                    "only rows and columns map to flexbox, so the children keep their positions",
                    [Score::Yes, Score::Unknown, Score::No],
                );
                None
            }
        }
    }

    /// Where `node` sits: at its position, or in its parent's flow, sized
    /// on each axis unless it hugs its content or fills its parent.
    pub(super) fn place(
        &mut self,
        node: &FigNode,
        place: Place,
        flow: Option<bool>,
        styles: &mut Styles,
    ) {
        let (hug_width, hug_height) = match (flow, &node.layout) {
            (Some(horizontal), Some(layout)) => {
                let primary = layout.primary_sizing == "AUTO";
                let counter = layout.counter_sizing == "AUTO";
                if horizontal {
                    (primary, counter)
                } else {
                    (counter, primary)
                }
            }
            _ => (false, false),
        };
        let mut set = |name: &str, value: String| {
            styles.insert(name.into(), value);
        };
        match place {
            Place::Board => {}
            Place::Absolute => {
                set("position", "absolute".into());
                set("left", px(node.x));
                set("top", px(node.y));
                if !hug_width {
                    set("width", px(node.width));
                }
                if !hug_height {
                    set("height", px(node.height));
                }
            }
            Place::Flow { horizontal } => {
                let child = node.child.clone().unwrap_or_default();
                let (main, cross, hug_main, hug_cross) = if horizontal {
                    (
                        ("width", node.width),
                        ("height", node.height),
                        hug_width,
                        hug_height,
                    )
                } else {
                    (
                        ("height", node.height),
                        ("width", node.width),
                        hug_height,
                        hug_width,
                    )
                };
                if child.grow > 0.0 {
                    set("flex-grow", num(child.grow));
                    set("flex-basis", "0px".into());
                } else {
                    // Auto layout never shrinks a child below its size.
                    set("flex-shrink", "0".into());
                    if !hug_main {
                        set(main.0, px(main.1));
                    }
                }
                if child.align.as_deref() == Some("STRETCH") {
                    set("align-self", "stretch".into());
                } else if !hug_cross {
                    set(cross.0, px(cross.1));
                }
            }
        }
    }

    /// A frame with auto layout, as a flex container.
    pub(super) fn container(
        &mut self,
        me: Option<usize>,
        id: &str,
        layout: &AutoLayout,
        horizontal: bool,
        styles: &mut Styles,
    ) {
        let mut set = |name: &str, value: String| {
            styles.insert(name.into(), value);
        };
        set("display", "flex".into());
        set(
            "flex-direction",
            if horizontal { "row" } else { "column" }.into(),
        );
        if layout.wrap {
            set("flex-wrap", "wrap".into());
        }
        if layout.wrap && layout.counter_gap != layout.gap {
            // The counter gap is between wrapped rows, or columns.
            let (row, column) = if horizontal {
                (layout.counter_gap, layout.gap)
            } else {
                (layout.gap, layout.counter_gap)
            };
            set("row-gap", px(row));
            set("column-gap", px(column));
        } else if layout.gap != 0.0 {
            set("gap", px(layout.gap));
        }
        if layout.padding.iter().any(|&p| p != 0.0) {
            set("padding", layout.padding.map(px).join(" "));
        }
        let justify = match layout.primary_align.as_str() {
            "MIN" => Some("flex-start"),
            "CENTER" => Some("center"),
            "MAX" => Some("flex-end"),
            "SPACE_BETWEEN" => Some("space-between"),
            _ => None,
        };
        let align = match layout.counter_align.as_str() {
            "MIN" => Some("flex-start"),
            "CENTER" => Some("center"),
            "MAX" => Some("flex-end"),
            "BASELINE" => Some("baseline"),
            _ => None,
        };
        let mut unknown = Vec::new();
        match justify {
            Some(value) => set("justify-content", value.into()),
            None => unknown.push(("primaryAlign", &layout.primary_align)),
        }
        match align {
            Some(value) => set("align-items", value.into()),
            None => unknown.push(("counterAlign", &layout.counter_align)),
        }
        for (field, value) in unknown {
            self.report(
                me,
                &format!("{id}/layout/{field}"),
                format!("{value} alignment"),
                Feature::FlexLayout,
                "it has no flexbox equivalent, so the children start at the beginning",
                [Score::Yes, Score::No, Score::Yes],
            );
        }
    }
}
