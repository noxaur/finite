//! Fills, strokes and effects as backgrounds, borders and shadows.

use super::{Styles, Walk, image_url, num, px};
use crate::{
    Feature, Score,
    figma::payload::{FigNode, Paint, Rgba},
};

/// One `background` layer.
enum Layer {
    Color(String),
    Image(String),
}

impl Walk<'_> {
    /// Fills as `background` layers. Figma lists the bottom fill first and
    /// CSS the top layer first.
    pub(super) fn fills(
        &mut self,
        me: Option<usize>,
        id: &str,
        fills: &[Paint],
        styles: &mut Styles,
    ) {
        let mut layers = Vec::new();
        for (i, paint) in fills.iter().enumerate().rev() {
            let path = format!("{id}/fills/{i}");
            self.unknown(me, &path, &paint.extra, feature(paint));
            if !paint.visible {
                continue;
            }
            match paint.kind.as_str() {
                "SOLID" => {
                    if let Some(c) = paint.color {
                        layers.push(Layer::Color(color(c, paint.opacity)));
                    }
                }
                "IMAGE" => {
                    let Some(url) = image_url(self.images, paint) else {
                        self.report(
                            me,
                            &path,
                            "an image fill",
                            Feature::Image,
                            "it has no image",
                            [Score::Yes, Score::No, Score::No],
                        );
                        continue;
                    };
                    let mode = paint.scale_mode.as_deref().unwrap_or("FILL");
                    let layer = match mode {
                        "FIT" => format!("{url} center / contain no-repeat"),
                        "TILE" => format!("{url} 0 0 / auto repeat"),
                        _ => format!("{url} center / cover no-repeat"),
                    };
                    layers.push(Layer::Image(layer));
                    if mode == "CROP" {
                        self.report(
                            me,
                            &path,
                            "a cropped image",
                            Feature::Image,
                            "the crop isn't mapped, so the image covers the layer",
                            [Score::Yes, Score::Unknown, Score::Yes],
                        );
                    }
                    if paint.opacity < 1.0 {
                        self.report(
                            me,
                            &format!("{path}/opacity"),
                            "an image fill's opacity",
                            Feature::Image,
                            "a CSS background image can't be translucent",
                            [Score::Yes, Score::No, Score::No],
                        );
                    }
                }
                "GRADIENT_LINEAR" => {
                    let stops: Vec<String> = paint
                        .gradient_stops
                        .iter()
                        .map(|s| {
                            format!(
                                "{} {}%",
                                color(s.color, paint.opacity),
                                num(s.position * 100.0)
                            )
                        })
                        .collect();
                    layers.push(Layer::Image(format!(
                        "linear-gradient(180deg, {})",
                        stops.join(", ")
                    )));
                    self.report(
                        me,
                        &path,
                        "a linear gradient",
                        Feature::SolidFill,
                        "its direction isn't mapped, so it runs top to bottom",
                        [Score::Yes, Score::Unknown, Score::Yes],
                    );
                }
                other => self.report(
                    me,
                    &path,
                    format!("a {other} fill"),
                    feature(paint),
                    "this kind of fill isn't mapped, so it isn't drawn",
                    [Score::Yes, Score::No, Score::No],
                ),
            }
        }
        match layers.as_slice() {
            [] => {}
            [Layer::Color(c)] => {
                styles.insert("background-color".into(), c.clone());
            }
            _ => {
                let last = layers.len() - 1;
                let layers: Vec<String> = layers
                    .into_iter()
                    .enumerate()
                    .map(|(i, layer)| match layer {
                        // Only the bottom layer may be a plain color.
                        Layer::Color(c) if i < last => format!("linear-gradient({c}, {c})"),
                        Layer::Color(c) | Layer::Image(c) => c,
                    })
                    .collect();
                styles.insert("background".into(), layers.join(", "));
            }
        }
    }

    /// The top visible stroke as a border, or an outline when it's outside.
    pub(super) fn strokes(&mut self, me: Option<usize>, node: &FigNode, styles: &mut Styles) {
        let id = &node.id;
        for (i, paint) in node.strokes.iter().enumerate() {
            self.unknown(
                me,
                &format!("{id}/strokes/{i}"),
                &paint.extra,
                feature(paint),
            );
        }
        let visible: Vec<(usize, &Paint)> = node
            .strokes
            .iter()
            .enumerate()
            .filter(|(_, p)| p.visible)
            .collect();
        let Some(&(i, top)) = visible.last() else {
            return;
        };
        if node.stroke_weight <= 0.0 {
            return;
        }
        if visible.len() > 1 {
            self.report(
                me,
                &format!("{id}/strokes"),
                format!("{} strokes", visible.len()),
                Feature::Frame,
                "CSS draws one border, so only the top stroke is drawn",
                [Score::Yes, Score::No, Score::Yes],
            );
        }
        match (top.kind.as_str(), top.color) {
            ("SOLID", Some(c)) => {
                let property = match node.stroke_align.as_deref() {
                    Some("OUTSIDE") => "outline",
                    _ => "border",
                };
                let value = format!("{} solid {}", px(node.stroke_weight), color(c, top.opacity));
                styles.insert(property.into(), value);
            }
            (kind, _) => self.report(
                me,
                &format!("{id}/strokes/{i}"),
                format!("a {kind} stroke"),
                feature(top),
                "a border can only be a solid color, so it isn't drawn",
                [Score::Yes, Score::No, Score::No],
            ),
        }
    }

    /// Shadows and blurs. On text, a drop shadow is a `text-shadow`.
    pub(super) fn effects(
        &mut self,
        me: Option<usize>,
        node: &FigNode,
        text: bool,
        styles: &mut Styles,
    ) {
        let id = &node.id;
        let mut shadows = Vec::new();
        // Figma lists the bottom effect first, and CSS the top shadow.
        for (i, effect) in node.effects.iter().enumerate().rev() {
            let path = format!("{id}/effects/{i}");
            self.unknown(me, &path, &effect.extra, Feature::Frame);
            if !effect.visible {
                continue;
            }
            let offset = effect.offset.unwrap_or_default();
            let shadow = |c: Rgba| {
                format!(
                    "{} {} {} {} {}",
                    px(offset.x),
                    px(offset.y),
                    px(effect.radius),
                    px(effect.spread),
                    color(c, 1.0)
                )
            };
            // Figma's blur radius is twice CSS's standard deviation.
            let blur = format!("blur({})", px(effect.radius / 2.0));
            match (effect.kind.as_str(), effect.color) {
                ("DROP_SHADOW", Some(c)) if text => {
                    let value = format!(
                        "{} {} {} {}",
                        px(offset.x),
                        px(offset.y),
                        px(effect.radius),
                        color(c, 1.0)
                    );
                    styles.insert("text-shadow".into(), value);
                }
                ("DROP_SHADOW", Some(c)) => shadows.push(shadow(c)),
                ("INNER_SHADOW", Some(c)) if !text => shadows.push(format!("inset {}", shadow(c))),
                ("LAYER_BLUR", _) => {
                    styles.insert("filter".into(), blur);
                }
                ("BACKGROUND_BLUR", _) => {
                    styles.insert("backdrop-filter".into(), blur);
                }
                (kind, _) => self.report(
                    me,
                    &path,
                    format!("a {kind} effect"),
                    Feature::Frame,
                    "it has no CSS equivalent here, so it isn't drawn",
                    [Score::Yes, Score::No, Score::No],
                ),
            }
        }
        if !shadows.is_empty() {
            styles.insert("box-shadow".into(), shadows.join(", "));
        }
    }

    /// A text layer's fills as its `color`: the top visible solid fill.
    pub(super) fn text_paints(&mut self, me: Option<usize>, node: &FigNode, styles: &mut Styles) {
        let id = &node.id;
        if let Some(c) = self.text_color(me, &format!("{id}/fills"), &node.fills) {
            styles.insert("color".into(), c);
        }
        for (i, paint) in node.strokes.iter().enumerate() {
            self.unknown(
                me,
                &format!("{id}/strokes/{i}"),
                &paint.extra,
                feature(paint),
            );
        }
        if node.stroke_weight > 0.0 && node.strokes.iter().any(|p| p.visible) {
            self.report(
                me,
                &format!("{id}/strokes"),
                "a text stroke",
                Feature::Text,
                "text strokes aren't mapped, so it isn't drawn",
                [Score::Yes, Score::No, Score::No],
            );
        }
    }

    /// The color of text filled with `fills`, reporting fills that aren't
    /// one solid color.
    pub(super) fn text_color(
        &mut self,
        me: Option<usize>,
        path: &str,
        fills: &[Paint],
    ) -> Option<String> {
        let mut found = None;
        for (i, paint) in fills.iter().enumerate().rev() {
            let path = format!("{path}/{i}");
            self.unknown(me, &path, &paint.extra, feature(paint));
            if !paint.visible {
                continue;
            }
            match (paint.kind.as_str(), paint.color) {
                ("SOLID", Some(c)) if found.is_none() => found = Some(color(c, paint.opacity)),
                ("SOLID", _) => {}
                (kind, _) => self.report(
                    me,
                    &path,
                    format!("a {kind} text fill"),
                    Feature::Text,
                    "text can only be one solid color, so this fill isn't drawn",
                    [Score::Yes, Score::No, Score::No],
                ),
            }
        }
        found
    }
}

/// The feature a paint is.
fn feature(paint: &Paint) -> Feature {
    match paint.kind.as_str() {
        "IMAGE" => Feature::Image,
        _ => Feature::SolidFill,
    }
}

/// A Figma color, with its paint's opacity, as `rgb()` or `rgba()`.
pub(super) fn color(c: Rgba, opacity: f64) -> String {
    let channel = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    let (r, g, b) = (channel(c.r), channel(c.g), channel(c.b));
    let alpha = (c.a * opacity).clamp(0.0, 1.0);
    if alpha < 1.0 {
        format!("rgba({r}, {g}, {b}, {})", num(alpha))
    } else {
        format!("rgb({r}, {g}, {b})")
    }
}
