//! Reads computed CSS values. `getComputedStyle` writes each property one
//! way, like colors as `rgb()` and lengths in `px`, so these parse that
//! form and give up on anything else.

use crate::figma::payload::Rgba;

/// A length in pixels, like `12px` or `0`.
pub fn px(value: &str) -> Option<f64> {
    let value = value.trim();
    if value == "0" {
        return Some(0.0);
    }
    value.strip_suffix("px")?.trim().parse().ok()
}

pub fn number(value: &str) -> Option<f64> {
    value.trim().parse().ok()
}

/// `rgb()` or `rgba()`, with commas or spaces, as channels from 0 to 1.
/// `transparent` is clear black. Colors in other spaces, like `oklch()` or
/// `color(display-p3 …)`, which Chrome keeps as written, give `None`.
pub fn color(value: &str) -> Option<Rgba> {
    let value = value.trim();
    if value == "transparent" {
        return Some(Rgba {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        });
    }
    let inner = value
        .strip_prefix("rgba(")
        .or_else(|| value.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = inner
        .split([',', ' ', '/'])
        .filter(|p| !p.is_empty())
        .collect();
    let channel = |p: &str| -> Option<f64> {
        match p.strip_suffix('%') {
            Some(pct) => pct.parse::<f64>().ok().map(|v| v / 100.0),
            None => p.parse::<f64>().ok().map(|v| v / 255.0),
        }
    };
    let alpha = |p: &str| -> Option<f64> {
        match p.strip_suffix('%') {
            Some(pct) => pct.parse::<f64>().ok().map(|v| v / 100.0),
            None => p.parse().ok(),
        }
    };
    let (r, g, b, a) = match parts[..] {
        [r, g, b] => (channel(r)?, channel(g)?, channel(b)?, 1.0),
        [r, g, b, a] => (channel(r)?, channel(g)?, channel(b)?, alpha(a)?),
        _ => return None,
    };
    let clamp = |v: f64| v.clamp(0.0, 1.0);
    Some(Rgba {
        r: clamp(r),
        g: clamp(g),
        b: clamp(b),
        a: clamp(a),
    })
}

/// `value` split at each `sep` that isn't inside parentheses or quotes.
pub fn split_top(value: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut quote, mut start) = (0usize, None, 0);
    for (i, c) in value.char_indices() {
        match (c, quote) {
            ('"' | '\'', None) => quote = Some(c),
            (c, Some(q)) if c == q => quote = None,
            (_, Some(_)) => {}
            ('(', None) => depth += 1,
            (')', None) => depth = depth.saturating_sub(1),
            (c, None) if c == sep && depth == 0 => {
                out.push(value[start..i].trim());
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(value[start..].trim());
    out.retain(|part| !part.is_empty());
    out
}

/// One layer of a `background-image`.
#[derive(Debug, PartialEq)]
pub enum Background<'a> {
    Url(String),
    /// A gradient, or anything else that isn't a file.
    Other(&'a str),
}

/// A `background-image`'s layers, top first, as CSS lists them.
pub fn backgrounds(value: &str) -> Vec<Background<'_>> {
    if value.trim() == "none" {
        return Vec::new();
    }
    split_top(value, ',')
        .into_iter()
        .filter(|layer| *layer != "none")
        .map(|layer| match url(layer) {
            Some(url) => Background::Url(url),
            None => Background::Other(layer),
        })
        .collect()
}

/// What's inside `url(…)`, unquoted.
fn url(value: &str) -> Option<String> {
    let inner = value.strip_prefix("url(")?.strip_suffix(')')?.trim();
    Some(unquote(inner).replace("\\\"", "\""))
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    value
}

/// The first family in a `font-family` list, unquoted.
pub fn first_family(value: &str) -> String {
    split_top(value, ',')
        .first()
        .map(|f| unquote(f).to_owned())
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub color: Rgba,
    pub x: f64,
    pub y: f64,
    pub blur: f64,
    pub spread: f64,
    pub inset: bool,
}

/// A `box-shadow`, as Chrome computes it: each shadow is a color, two to
/// four lengths, and maybe `inset`. `None` if any shadow isn't that.
pub fn shadows(value: &str) -> Option<Vec<Shadow>> {
    if value.trim() == "none" {
        return Some(Vec::new());
    }
    split_top(value, ',')
        .into_iter()
        .map(|shadow| {
            let mut color = None;
            let mut inset = false;
            let mut lengths = Vec::new();
            for part in split_top(shadow, ' ') {
                if part == "inset" {
                    inset = true;
                } else if let Some(len) = px(part) {
                    lengths.push(len);
                } else {
                    color = Some(self::color(part)?);
                }
            }
            let [x, y, blur, spread] = match lengths[..] {
                [x, y] => [x, y, 0.0, 0.0],
                [x, y, blur] => [x, y, blur, 0.0],
                [x, y, blur, spread] => [x, y, blur, spread],
                _ => return None,
            };
            Some(Shadow {
                color: color?,
                x,
                y,
                blur,
                spread,
                inset,
            })
        })
        .collect()
}

/// A corner's `border-*-radius` on a `width` × `height` box. An elliptical
/// corner gives its smaller radius.
pub fn radius(value: &str, width: f64, height: f64) -> Option<f64> {
    let parts = split_top(value, ' ');
    let mut radii =
        parts
            .iter()
            .zip([width, height])
            .map(|(part, side)| match part.strip_suffix('%') {
                Some(pct) => pct.parse::<f64>().ok().map(|p| p / 100.0 * side),
                None => px(part),
            });
    let first = radii.next()??;
    match radii.next() {
        Some(second) => Some(first.min(second?)),
        // One value is a circle: a percentage of each side.
        None if parts.first()?.ends_with('%') => {
            let pct = first / width.max(f64::MIN_POSITIVE);
            Some((pct * width).min(pct * height))
        }
        None => Some(first),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Transform {
    None,
    /// A rotation about the box's center, clockwise, in radians.
    Rotate(f64),
    /// A translation, scale, skew or 3D transform.
    Other,
}

/// A computed `transform`, which Chrome writes as `none` or a `matrix()`.
/// Only a rotation with no translation, scale or skew is a [`Transform::Rotate`].
pub fn transform(value: &str) -> Transform {
    let value = value.trim();
    if value.is_empty() || value == "none" {
        return Transform::None;
    }
    let Some(inner) = value
        .strip_prefix("matrix(")
        .and_then(|v| v.strip_suffix(')'))
    else {
        return Transform::Other;
    };
    let m: Option<Vec<f64>> = inner.split(',').map(number).collect();
    let Some([a, b, c, d, e, f]) = m.as_deref().and_then(|m| <[f64; 6]>::try_from(m).ok()) else {
        return Transform::Other;
    };
    let near = |x: f64, y: f64| (x - y).abs() < 1e-4;
    if near(a, d) && near(b, -c) && near(a * a + b * b, 1.0) && near(e, 0.0) && near(f, 0.0) {
        if near(b, 0.0) && a > 0.0 {
            Transform::None
        } else {
            Transform::Rotate(b.atan2(a))
        }
    } else {
        Transform::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(r: f64, g: f64, b: f64, a: f64) -> Rgba {
        Rgba { r, g, b, a }
    }

    #[test]
    fn colors_parse_as_chrome_writes_them() {
        assert_eq!(color("rgb(255, 0, 51)"), Some(rgba(1.0, 0.0, 0.2, 1.0)));
        assert_eq!(color("rgba(0, 0, 0, 0.5)"), Some(rgba(0.0, 0.0, 0.0, 0.5)));
        assert_eq!(color("rgb(0 255 0 / 25%)"), Some(rgba(0.0, 1.0, 0.0, 0.25)));
        assert_eq!(color("oklch(0.5 0.1 200)"), None);
    }

    #[test]
    fn shadows_split_at_top_level_commas() {
        let parsed =
            shadows("rgba(0, 0, 0, 0.2) 0px 4px 12px 0px, rgb(255, 0, 0) 1px 2px inset").unwrap();
        assert_eq!(
            parsed,
            [
                Shadow {
                    color: rgba(0.0, 0.0, 0.0, 0.2),
                    x: 0.0,
                    y: 4.0,
                    blur: 12.0,
                    spread: 0.0,
                    inset: false
                },
                Shadow {
                    color: rgba(1.0, 0.0, 0.0, 1.0),
                    x: 1.0,
                    y: 2.0,
                    blur: 0.0,
                    spread: 0.0,
                    inset: true
                }
            ]
        );
        assert_eq!(shadows("none"), Some(Vec::new()));
        assert_eq!(shadows("rgb(0, 0, 0) 1em 2px"), None);
    }

    #[test]
    fn backgrounds_and_fonts_unquote() {
        assert_eq!(
            backgrounds(r#"linear-gradient(red, blue), url("file:///a/b.png")"#),
            [
                Background::Other("linear-gradient(red, blue)"),
                Background::Url("file:///a/b.png".into())
            ]
        );
        assert_eq!(
            first_family(r#""Inter Display", system-ui, sans-serif"#),
            "Inter Display"
        );
    }

    #[test]
    fn radii_and_rotations() {
        assert_eq!(radius("8px", 100.0, 50.0), Some(8.0));
        assert_eq!(radius("50%", 100.0, 50.0), Some(25.0));
        assert_eq!(radius("10px 4px", 100.0, 50.0), Some(4.0));
        assert_eq!(transform("none"), Transform::None);
        let Transform::Rotate(a) = transform("matrix(0, 1, -1, 0, 0, 0)") else {
            panic!()
        };
        assert!((a - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
        assert_eq!(transform("matrix(1, 0, 0, 1, 10, 0)"), Transform::Other);
        assert_eq!(transform("matrix(2, 0, 0, 2, 0, 0)"), Transform::Other);
    }
}
