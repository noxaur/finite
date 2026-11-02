//! Text layers: their style on the layer's `<div>`, and a `<span>` for each
//! run styled unlike the rest.

use std::collections::BTreeMap;

use finite_design::{NodeKind, html::Fragment};

use super::{Styles, Walk, num, px};
use crate::{
    Feature, Score,
    figma::payload::{Measure, Text, TextRun},
};

impl Walk<'_> {
    /// Puts `text`'s style in `styles` and returns its characters as
    /// fragments.
    pub(super) fn text(
        &mut self,
        me: Option<usize>,
        id: &str,
        text: Text,
        styles: &mut Styles,
    ) -> Vec<Fragment> {
        self.unknown(me, &format!("{id}/text"), &text.extra, Feature::Text);
        let mut set = |name: &str, value: String| {
            styles.insert(name.into(), value);
        };
        set("font-family", family(&text.font_family));
        set("font-size", px(text.font_size));
        set("font-weight", num(text.font_weight));
        if text.italic {
            set("font-style", "italic".into());
        }
        if let Some(value) = text.line_height.as_ref().and_then(line_height) {
            set("line-height", value);
        }
        if let Some(value) = text.letter_spacing.as_ref().and_then(letter_spacing) {
            set("letter-spacing", value);
        }
        let align = match text.align.as_str() {
            "CENTER" => "center",
            "RIGHT" => "right",
            "JUSTIFIED" => "justify",
            _ => "left",
        };
        set("text-align", align.into());
        if let Some(value) = text.decoration.as_deref().and_then(decoration) {
            set("text-decoration", value.into());
        }
        let case = match text.case.as_deref() {
            Some("UPPER") => Some("uppercase"),
            Some("LOWER") => Some("lowercase"),
            Some("TITLE") => Some("capitalize"),
            _ => None,
        };
        if let Some(value) = case {
            set("text-transform", value.into());
        }
        // Figma keeps the spaces and line breaks it's given.
        set("white-space", "pre-wrap".into());

        let characters = text.characters;
        if text.runs.is_empty() {
            return self.characters(&characters, format!("{id}/characters"));
        }
        let mut runs: Vec<(usize, TextRun)> = text.runs.into_iter().enumerate().collect();
        runs.sort_by_key(|(_, run)| run.start);
        let mut out = Vec::new();
        // Where the text before the next run starts, in bytes and in Figma's
        // UTF-16 units.
        let (mut done, mut done_units) = (0, 0);
        for (i, run) in runs {
            let path = format!("{id}/runs/{i}");
            self.unknown(me, &path, &run.extra, Feature::Text);
            let span = (run.start >= done_units && run.end > run.start)
                .then(|| byte_at(&characters, run.start).zip(byte_at(&characters, run.end)))
                .flatten();
            let Some((start, end)) = span else {
                self.report(
                    me,
                    &path,
                    "a text run",
                    Feature::Text,
                    "its range is outside the text or overlaps another run, so it isn't styled",
                    [Score::Yes, Score::No, Score::Yes],
                );
                continue;
            };
            if start > done {
                let gap = format!("{id}/characters/{done_units}..{}", run.start);
                out.extend(self.characters(&characters[done..start], gap));
            }
            let mut styles = Styles::new();
            self.run(me, &path, &run, &mut styles);
            self.paths.push(path.clone());
            out.push(Fragment {
                kind: NodeKind::Element { tag: "span".into() },
                name: None,
                text: None,
                styles,
                attrs: BTreeMap::new(),
                children: self.characters(&characters[start..end], format!("{path}/characters")),
            });
            (done, done_units) = (end, run.end);
        }
        if done < characters.len() {
            let units = characters.encode_utf16().count();
            let rest = format!("{id}/characters/{done_units}..{units}");
            out.extend(self.characters(&characters[done..], rest));
        }
        out
    }

    /// What a run changes from its layer's style.
    fn run(&mut self, me: Option<usize>, path: &str, run: &TextRun, styles: &mut Styles) {
        if let Some(f) = &run.font_family {
            styles.insert("font-family".into(), family(f));
        }
        if let Some(size) = run.font_size {
            styles.insert("font-size".into(), px(size));
        }
        if let Some(weight) = run.font_weight {
            styles.insert("font-weight".into(), num(weight));
        }
        if let Some(italic) = run.italic {
            let style = if italic { "italic" } else { "normal" };
            styles.insert("font-style".into(), style.into());
        }
        if let Some(c) = self.text_color(me, &format!("{path}/fills"), &run.fills) {
            styles.insert("color".into(), c);
        }
        if let Some(value) = run.decoration.as_deref().and_then(decoration) {
            styles.insert("text-decoration".into(), value.into());
        }
    }

    /// A text fragment for `characters`, if there are any.
    fn characters(&mut self, characters: &str, path: String) -> Vec<Fragment> {
        if characters.is_empty() {
            return Vec::new();
        }
        self.paths.push(path);
        vec![Fragment {
            kind: NodeKind::Text,
            name: None,
            text: Some(characters.to_owned()),
            styles: BTreeMap::new(),
            attrs: BTreeMap::new(),
            children: Vec::new(),
        }]
    }
}

/// The byte offset in `s` of UTF-16 offset `units`, which is how the Plugin
/// API counts characters, if it's at the boundary of a character.
fn byte_at(s: &str, units: usize) -> Option<usize> {
    let mut count = 0;
    for (at, c) in s.char_indices() {
        if count == units {
            return Some(at);
        }
        count += c.len_utf16();
    }
    (count == units).then_some(s.len())
}

/// A font family name, quoted for CSS.
fn family(name: &str) -> String {
    format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
}

fn line_height(m: &Measure) -> Option<String> {
    match m.unit.as_str() {
        "PIXELS" => Some(px(m.value)),
        "PERCENT" => Some(format!("{}%", num(m.value))),
        "AUTO" => Some("normal".into()),
        _ => None,
    }
}

/// Figma counts percent letter spacing against the font size, which is an `em`.
fn letter_spacing(m: &Measure) -> Option<String> {
    match m.unit.as_str() {
        _ if m.value == 0.0 => None,
        "PIXELS" => Some(px(m.value)),
        "PERCENT" => Some(format!("{}em", num(m.value / 100.0))),
        _ => None,
    }
}

fn decoration(value: &str) -> Option<&'static str> {
    match value {
        "UNDERLINE" => Some("underline"),
        "STRIKETHROUGH" => Some("line-through"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_count_utf16_units() {
        let s = "a😀b";
        assert_eq!(byte_at(s, 0), Some(0));
        assert_eq!(byte_at(s, 1), Some(1));
        // Inside the emoji's surrogate pair.
        assert_eq!(byte_at(s, 2), None);
        assert_eq!(byte_at(s, 3), Some(5));
        assert_eq!(byte_at(s, 4), Some(6));
        assert_eq!(byte_at(s, 5), None);
    }

    #[test]
    fn units_become_css() {
        let m = |unit: &str, value| Measure {
            unit: unit.into(),
            value,
        };
        assert_eq!(line_height(&m("PIXELS", 20.0)).as_deref(), Some("20px"));
        assert_eq!(line_height(&m("AUTO", 0.0)).as_deref(), Some("normal"));
        assert_eq!(
            letter_spacing(&m("PERCENT", 5.0)).as_deref(),
            Some("0.05em")
        );
        assert_eq!(letter_spacing(&m("PERCENT", 0.0)), None);
        assert_eq!(family("A \"B\""), "\"A \\\"B\\\"\"");
    }
}
