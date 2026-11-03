//! Flexbox into auto layout. Auto layout is a subset of flexbox: one
//! direction, a gap, padding and alignment, but no margins, `order`,
//! `flex-basis` or reversed directions. So a flex container converts only
//! when auto layout, given the measured sizes, would put every child where
//! the browser did. Otherwise its children keep their measured positions.

use std::collections::BTreeMap;

use finite_design::Node;

use super::{Kid, Placed, Walk, css};
use crate::{
    Feature, Score,
    figma::payload::{AutoLayout, LayoutChild},
    scene::Resolved,
};

/// How far, in pixels, auto layout may place a child from where it rendered.
const TOLERANCE: f64 = 1.0;

/// What auto layout changes about one child: how it sits in the layout, and
/// for a text node, the anonymous box it fills.
struct Fit {
    child: Option<LayoutChild>,
    text_box: Option<[f64; 4]>,
}

impl Walk<'_, '_> {
    /// `node`'s auto layout, if it has one, with each of `kids` set to sit in it.
    pub(super) fn layout(
        &mut self,
        node: &Node,
        res: &Resolved,
        placed: &Placed,
        kids: &mut [Kid<'_>],
    ) -> Option<AutoLayout> {
        let display = res.style("display");
        if display.ends_with("grid") {
            self.lost(
                node,
                "display",
                display,
                Feature::FlexLayout,
                "Figma has no grid, so its children keep the positions they rendered at",
                [Score::No, Score::Unknown, Score::Yes],
            );
            return None;
        }
        if display != "flex" && display != "inline-flex" {
            return None;
        }
        match flex(res, placed, kids) {
            Ok((layout, fits)) => {
                for (kid, fit) in kids.iter_mut().zip(fits) {
                    kid.node.child = fit.child;
                    if let Some([x, y, width, height]) = fit.text_box {
                        (kid.node.x, kid.node.y) = (x, y);
                        (kid.node.width, kid.node.height) = (width, height);
                    }
                }
                Some(layout)
            }
            Err(why) => {
                self.lost(
                    node,
                    "display",
                    display,
                    Feature::FlexLayout,
                    format!("{why}, so its children keep the positions they rendered at"),
                    [Score::No, Score::Unknown, Score::Yes],
                );
                None
            }
        }
    }
}

/// `res`'s flexbox as auto layout, and how each kid fits in it, or why it
/// can't be one.
fn flex(
    res: &Resolved,
    placed: &Placed,
    kids: &[Kid<'_>],
) -> Result<(AutoLayout, Vec<Fit>), String> {
    let horizontal = match res.style("flex-direction") {
        "row" => true,
        "column" => false,
        other => return Err(format!("auto layout has no `flex-direction: {other}`")),
    };
    let wrap = match res.style("flex-wrap") {
        "nowrap" => false,
        "wrap" => true,
        other => return Err(format!("auto layout has no `flex-wrap: {other}`")),
    };
    let primary = match unprefixed(res.style("justify-content")) {
        "normal" | "flex-start" | "start" | "left" => "MIN",
        "center" => "CENTER",
        "flex-end" | "end" | "right" => "MAX",
        "space-between" => "SPACE_BETWEEN",
        other => return Err(format!("auto layout has no `justify-content: {other}`")),
    };
    let align_items = unprefixed(res.style("align-items"));
    let (counter, stretch) = match align(align_items, horizontal) {
        Some(Align::Stretch) => ("MIN", true),
        Some(Align::To(counter)) => (counter, false),
        None => return Err(format!("auto layout has no `align-items: {align_items}`")),
    };
    let px = |name: &str| css::px(res.style(name)).unwrap_or(0.0);
    // Figma's padding starts at the frame's edge; CSS's inside the border.
    let padding = ["top", "right", "bottom", "left"]
        .map(|side| px(&format!("padding-{side}")) + px(&format!("border-{side}-width")));
    let (gap, counter_gap) = if horizontal {
        (px("column-gap"), px("row-gap"))
    } else {
        (px("row-gap"), px("column-gap"))
    };
    // The content box along each axis: start and length.
    let [top, right, bottom, left] = padding;
    let across = (left, placed.width - left - right);
    let down = (top, placed.height - top - bottom);
    let (main, cross) = if horizontal {
        (across, down)
    } else {
        (down, across)
    };

    let mut fits = Vec::new();
    for kid in kids {
        let mut child = LayoutChild::default();
        let mut text_box = None;
        let [x, y, width, height] = [kid.node.x, kid.node.y, kid.node.width, kid.node.height];
        let cross_size = if horizontal { height } else { width };
        if kid.text {
            // A text node is an anonymous flex item, which stretches.
            if stretch {
                text_box = Some(if horizontal {
                    [x, cross.0, width, cross.1]
                } else {
                    [cross.0, y, cross.1, height]
                });
                child.align = Some("STRETCH".into());
            }
        } else if matches!(kid.res.style("position"), "absolute" | "fixed") {
            child.positioning = Some("ABSOLUTE".into());
        } else {
            if kid.transformed {
                return Err("a child is transformed, which auto layout doesn't follow".into());
            }
            child.grow = css::number(kid.res.style("flex-grow")).unwrap_or(0.0);
            let align_self = unprefixed(kid.res.style("align-self"));
            let stretches = match align_self {
                "auto" | "normal" => stretch,
                other => match align(other, horizontal) {
                    Some(Align::Stretch) => true,
                    Some(Align::To(own)) if own == counter => false,
                    _ => {
                        return Err(format!(
                            "a child aligns itself with `align-self: {other}`, which auto layout can't"
                        ));
                    }
                },
            };
            if stretches && (cross_size - cross.1).abs() <= TOLERANCE {
                child.align = Some("STRETCH".into());
            }
        }
        fits.push(Fit {
            child: (child != LayoutChild::default()).then_some(child),
            text_box,
        });
    }

    let boxes: Vec<[f64; 4]> = kids
        .iter()
        .zip(&fits)
        .filter(|(_, fit)| {
            fit.child.as_ref().and_then(|c| c.positioning.as_deref()) != Some("ABSOLUTE")
        })
        .map(|(kid, fit)| {
            fit.text_box
                .unwrap_or([kid.node.x, kid.node.y, kid.node.width, kid.node.height])
        })
        .collect();
    let laid: Vec<([f64; 2], [f64; 2])> = boxes
        .iter()
        .map(|[x, y, w, h]| {
            if horizontal {
                ([*x, *w], [*y, *h])
            } else {
                ([*y, *h], [*x, *w])
            }
        })
        .collect();
    if wrap {
        // Wrapped lines aren't laid out here, but auto layout fills them in
        // document order. A child out of reading order, as `order` makes
        // it, would come back rearranged.
        for pair in laid.windows(2) {
            let (([pos, size], [line, _]), ([next, _], [next_line, _])) = (pair[0], pair[1]);
            let same_line = (next_line - line).abs() <= TOLERANCE;
            let backwards = if same_line {
                next < pos + size - TOLERANCE
            } else {
                next_line < line
            };
            if backwards {
                return Err("the browser placed its children out of order, as `order` does, so auto layout would rearrange them".into());
            }
        }
    } else {
        let sizes: f64 = boxes
            .iter()
            .map(|b| if horizontal { b[2] } else { b[3] })
            .sum();
        let n = boxes.len() as f64;
        let free = main.1 - sizes - gap * (n - 1.0).max(0.0);
        let (mut at, step) = match primary {
            "CENTER" => (main.0 + free / 2.0, gap),
            "MAX" => (main.0 + free, gap),
            "SPACE_BETWEEN" if n > 1.0 => (main.0, gap + free / (n - 1.0)),
            _ => (main.0, gap),
        };
        for &([pos, size], [cpos, csize]) in &laid {
            let expected = match counter {
                "CENTER" => Some(cross.0 + (cross.1 - csize) / 2.0),
                "MAX" => Some(cross.0 + cross.1 - csize),
                "BASELINE" => None,
                _ => Some(cross.0),
            };
            let off_cross = expected.is_some_and(|e| (e - cpos).abs() > TOLERANCE);
            if (pos - at).abs() > TOLERANCE || off_cross {
                return Err("the browser placed its children where auto layout wouldn't, as margins, `order` or `flex-basis` do".into());
            }
            at += size + step;
        }
    }

    let layout = AutoLayout {
        mode: if horizontal { "HORIZONTAL" } else { "VERTICAL" }.into(),
        wrap,
        gap,
        counter_gap: if wrap { counter_gap } else { 0.0 },
        padding,
        primary_align: primary.into(),
        counter_align: counter.into(),
        primary_sizing: "FIXED".into(),
        counter_sizing: "FIXED".into(),
        extra: BTreeMap::new(),
    };
    Ok((layout, fits))
}

enum Align {
    Stretch,
    To(&'static str),
}

/// An `align-items` or `align-self` value as auto layout's counter axis
/// alignment. Figma aligns to a baseline only in a row.
fn align(value: &str, horizontal: bool) -> Option<Align> {
    Some(match value {
        "normal" | "stretch" => Align::Stretch,
        "flex-start" | "start" | "self-start" => Align::To("MIN"),
        "center" => Align::To("CENTER"),
        "flex-end" | "end" | "self-end" => Align::To("MAX"),
        "baseline" | "first baseline" if horizontal => Align::To("BASELINE"),
        _ => return None,
    })
}

/// An alignment without `safe` or `unsafe`, which only matter on overflow.
fn unprefixed(value: &str) -> &str {
    value
        .strip_prefix("unsafe ")
        .or_else(|| value.strip_prefix("safe "))
        .unwrap_or(value)
}
