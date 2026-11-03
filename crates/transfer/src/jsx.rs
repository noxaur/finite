//! JSX for React code: a node's subtree as JSX elements, with inline style
//! objects or Tailwind classes. Export only, since a design is HTML and CSS
//! and nobody authors Finite designs in JSX.
//!
//! [`convert`] does the work for any node, and the `get_jsx` tool calls it.
//! The codec's [`write`](Codec::write) wraps an artboard's JSX in a
//! component file.

use finite_design::{
    Document, Node, NodeKind,
    html::{self, NAME_ATTR},
};

use crate::{
    Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input, Revision, Scope,
    Score, Support, assets, file_stem,
};

pub struct Jsx;

impl Codec for Jsx {
    fn name(&self) -> &'static str {
        "jsx"
    }

    fn support(&self, feature: Feature, direction: Direction) -> Support {
        use {Direction::*, Support::*};
        match (feature, direction) {
            (_, Import) => Unsupported,
            // Declarations become style objects or Tailwind classes, and
            // Tailwind's arbitrary values cover any of them.
            (
                Feature::Frame
                | Feature::Text
                | Feature::SolidFill
                | Feature::Image
                | Feature::FlexLayout,
                Export,
            ) => Exact,
            // A component has no place for a script, so it's left out.
            (Feature::Script | Feature::Embed | Feature::ImportHistory, Export) => Unsupported,
        }
    }

    fn read(&self, _input: &Input<'_>) -> Result<Imported, Error> {
        Err(Error(
            "JSX can only be exported; import HTML instead".into(),
        ))
    }

    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
        let Scope::Artboard(_) = scope else {
            return Err(Error("a JSX file holds one artboard; pick one".into()));
        };
        let board = revision.artboards(scope)?[0];
        let title = board.display_name();
        let converted = convert(revision.doc, &board.id, &Options::default(), 2)
            .ok_or_else(|| Error(format!("{:?} isn't an artboard", board.id)))?;
        let file = format!(
            "export default function {}() {{\n  return (\n{}\n  );\n}}\n",
            component_name(&title),
            converted.jsx
        );
        let (file, mut diagnostics) = assets::inline(&file, revision.blobs)?;
        diagnostics.extend(converted.diagnostics);
        Ok(Exported {
            file_name: format!("{}.jsx", file_stem(&title)),
            media_type: "text/jsx; charset=utf-8",
            bytes: file.into_bytes(),
            diagnostics,
        })
    }
}

/// What [`convert`] writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// Styles as Tailwind classes instead of `style` objects.
    pub tailwind: bool,
}

/// JSX from [`convert`], and what it left out.
#[derive(Debug)]
pub struct Converted {
    pub jsx: String,
    pub diagnostics: Vec<Diagnostic>,
}

/// The subtree at `id` as JSX, indented `level` steps of two spaces.
pub fn convert(doc: &Document, id: &str, options: &Options, level: usize) -> Option<Converted> {
    let node = doc.get(id)?;
    let mut writer = Writer {
        doc,
        options,
        out: String::new(),
        diagnostics: Vec::new(),
    };
    writer.node(node, level);
    // Each element ends its line; the caller adds its own.
    writer.out.truncate(writer.out.trim_end().len());
    Some(Converted {
        jsx: writer.out,
        diagnostics: writer.diagnostics,
    })
}

/// A component name from an artboard's name: `Home — Desktop` is
/// `HomeDesktop`.
fn component_name(name: &str) -> String {
    let mut out = String::new();
    for word in name.split(|c: char| !c.is_ascii_alphanumeric()) {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert_str(0, "Artboard");
    }
    out
}

struct Writer<'a> {
    doc: &'a Document,
    options: &'a Options,
    out: String,
    diagnostics: Vec<Diagnostic>,
}

impl Writer<'_> {
    fn pad(&mut self, level: usize) {
        self.out.push_str(&"  ".repeat(level));
    }

    fn node(&mut self, node: &Node, level: usize) {
        let tag = match &node.kind {
            NodeKind::Text => {
                self.pad(level);
                self.out.push_str(&text(node.text.as_deref().unwrap_or("")));
                self.out.push('\n');
                return;
            }
            NodeKind::Element { tag } => tag,
        };
        if tag.eq_ignore_ascii_case("script") {
            self.diagnostics.push(Diagnostic {
                node: Some(node.id.clone()),
                path: format!("#{}", node.id),
                what: "<script>".into(),
                feature: Feature::Script,
                reason: "a component can't hold a script, so it was left out".into(),
                preserved: Score::No,
                visual: Score::Unknown,
                editable: Score::No,
                quarantined: false,
            });
            return;
        }
        self.pad(level);
        self.out.push('<');
        self.out.push_str(tag);
        if let Some(name) = &node.name {
            self.attr(NAME_ATTR, name);
        }
        let mut leftover = node.styles.clone();
        let mut classes = Vec::new();
        if self.options.tailwind {
            leftover.retain(|property, value| match utility(property, value) {
                Some(class) => {
                    classes.push(class);
                    false
                }
                None => true,
            });
        }
        for (name, value) in &node.attrs {
            let lower = name.to_ascii_lowercase();
            if lower == "class" && self.options.tailwind {
                classes.insert(0, value.clone());
            } else if lower == "style" {
                // The model keeps styles in `styles`; a stray attribute
                // would be a string, which React rejects.
            } else {
                self.react_attr(tag, &lower, value);
            }
        }
        if !classes.is_empty() {
            let classes = classes.join(" ");
            if classes.contains(['"', '\\']) {
                self.out.push_str(&format!(
                    " className={{{}}}",
                    serde_json::to_string(&classes).expect("strings serialize")
                ));
            } else {
                self.out.push_str(&format!(" className=\"{classes}\""));
            }
        }
        if !leftover.is_empty() {
            let object: Vec<String> = leftover
                .iter()
                .map(|(property, value)| {
                    format!(
                        "{}: {}",
                        style_key(property),
                        serde_json::to_string(value.trim()).expect("strings serialize")
                    )
                })
                .collect();
            self.out
                .push_str(&format!(" style={{{{ {} }}}}", object.join(", ")));
        }
        if html::VOID_TAGS.contains(&tag.to_ascii_lowercase().as_str()) {
            self.out.push_str(" />\n");
            return;
        }
        let children = self.doc.children(Some(&node.id));
        if tag.eq_ignore_ascii_case("style") {
            let css: String = children.iter().filter_map(|c| c.text.as_deref()).collect();
            let css = css
                .replace('\\', "\\\\")
                .replace('`', "\\`")
                .replace("${", "\\${");
            self.out.push_str(&format!(">{{`{css}`}}</{tag}>\n"));
            return;
        }
        match children.as_slice() {
            [] => self.out.push_str(&format!("></{tag}>\n")),
            [only] if only.kind == NodeKind::Text && is_plain(only.text.as_deref()) => {
                self.out.push_str(&format!(
                    ">{}</{tag}>\n",
                    only.text.as_deref().unwrap_or_default()
                ));
            }
            children => {
                self.out.push_str(">\n");
                for child in children {
                    self.node(child, level + 1);
                }
                self.pad(level);
                self.out.push_str(&format!("</{tag}>\n"));
            }
        }
    }

    fn attr(&mut self, name: &str, value: &str) {
        self.out
            .push_str(&format!(" {name}=\"{}\"", html::escape(value, true)));
    }

    /// An HTML attribute under the name and form React wants.
    fn react_attr(&mut self, tag: &str, name: &str, value: &str) {
        if BOOLEAN_ATTRS.contains(&name) {
            // React reads `disabled=""` as false.
            let name = if name == "checked" {
                "defaultChecked"
            } else {
                name
            };
            let name = BOOLEAN_NAMES
                .iter()
                .find_map(|(html, react)| (*html == name).then_some(*react))
                .unwrap_or(name);
            self.out.push(' ');
            self.out.push_str(name);
            return;
        }
        let name = match name {
            "value" if matches!(tag, "input" | "textarea") => "defaultValue".to_owned(),
            name => react_name(name),
        };
        self.attr(&name, value);
    }
}

/// Attributes that are on when present, whatever their value.
const BOOLEAN_ATTRS: &[&str] = &[
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "hidden",
    "ismap",
    "loop",
    "multiple",
    "muted",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "selected",
];

/// The boolean attributes React spells differently.
const BOOLEAN_NAMES: &[(&str, &str)] = &[
    ("allowfullscreen", "allowFullScreen"),
    ("autofocus", "autoFocus"),
    ("autoplay", "autoPlay"),
    ("ismap", "isMap"),
    ("novalidate", "noValidate"),
    ("playsinline", "playsInline"),
    ("readonly", "readOnly"),
];

/// How React spells an attribute that HTML spells in lowercase.
const RENAMED_ATTRS: &[(&str, &str)] = &[
    ("accept-charset", "acceptCharset"),
    ("autocomplete", "autoComplete"),
    ("cellpadding", "cellPadding"),
    ("cellspacing", "cellSpacing"),
    ("class", "className"),
    ("colspan", "colSpan"),
    ("contenteditable", "contentEditable"),
    ("crossorigin", "crossOrigin"),
    ("datetime", "dateTime"),
    ("enctype", "encType"),
    ("for", "htmlFor"),
    ("formaction", "formAction"),
    ("frameborder", "frameBorder"),
    ("hreflang", "hrefLang"),
    ("http-equiv", "httpEquiv"),
    ("inputmode", "inputMode"),
    ("maxlength", "maxLength"),
    ("minlength", "minLength"),
    ("preserveaspectratio", "preserveAspectRatio"),
    ("rowspan", "rowSpan"),
    ("spellcheck", "spellCheck"),
    ("srcset", "srcSet"),
    ("tabindex", "tabIndex"),
    ("usemap", "useMap"),
    ("viewbox", "viewBox"),
];

fn react_name(name: &str) -> String {
    if let Some((_, react)) = RENAMED_ATTRS.iter().find(|(html, _)| *html == name) {
        return (*react).to_owned();
    }
    if name.starts_with("data-") || name.starts_with("aria-") || !name.contains(['-', ':']) {
        return name.to_owned();
    }
    // SVG: `stroke-width` is `strokeWidth`, `xlink:href` is `xlinkHref`.
    camel(name, ['-', ':'])
}

/// `name` with each word after a separator capitalized and the separators removed.
fn camel(name: &str, separators: [char; 2]) -> String {
    let mut out = String::new();
    for (i, word) in name.split(separators).enumerate() {
        let mut chars = word.chars();
        match chars.next() {
            Some(first) if i > 0 => {
                out.push(first.to_ascii_uppercase());
                out.push_str(chars.as_str());
            }
            _ => out.push_str(word),
        }
    }
    out
}

/// A style property as an object key: `font-size` is `fontSize`, and
/// `-webkit-line-clamp` is `WebkitLineClamp`.
fn style_key(property: &str) -> String {
    if property.starts_with("--") {
        return serde_json::to_string(property).expect("strings serialize");
    }
    let property = property.to_ascii_lowercase();
    match property.strip_prefix('-') {
        // React writes the ms prefix in lowercase.
        Some(vendor) if vendor.starts_with("ms-") => camel(vendor, ['-', '-']),
        Some(vendor) => {
            let key = camel(vendor, ['-', '-']);
            let mut chars = key.chars();
            chars
                .next()
                .map(|c| c.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        }
        None => camel(&property, ['-', '-']),
    }
}

/// Whether JSX text can hold `text` as it is. JSX trims the whitespace at
/// the ends of a line and can't hold `{`, `}`, `<`, `>` or a bare `&`.
fn is_plain(text: Option<&str>) -> bool {
    text.is_some_and(|t| {
        !t.is_empty() && t == t.trim() && !t.contains(['{', '}', '<', '>', '&', '\n', '\r'])
    })
}

/// A text node as JSX children.
fn text(text: &str) -> String {
    if is_plain(Some(text)) {
        text.to_owned()
    } else {
        format!(
            "{{{}}}",
            serde_json::to_string(text).expect("strings serialize")
        )
    }
}

/// The Tailwind class for one declaration, if it is safe in a class name.
/// Utilities where Tailwind's meaning is plain, and an arbitrary property
/// (`[color:red]`) for the rest, which stands for any declaration.
fn utility(property: &str, value: &str) -> Option<String> {
    let property = property.to_ascii_lowercase();
    let value = value.trim();
    if value.is_empty()
        || value.contains(['[', ']', '{', '}', ';', '\n', '\r', '\\', '\t'])
        || value.to_ascii_lowercase().contains("url(")
    {
        return None;
    }
    let keyword = match (property.as_str(), value) {
        ("display", "block") => Some("block"),
        ("display", "inline") => Some("inline"),
        ("display", "inline-block") => Some("inline-block"),
        ("display", "flex") => Some("flex"),
        ("display", "inline-flex") => Some("inline-flex"),
        ("display", "grid") => Some("grid"),
        ("display", "none") => Some("hidden"),
        ("flex-direction", "row") => Some("flex-row"),
        ("flex-direction", "column") => Some("flex-col"),
        ("flex-direction", "row-reverse") => Some("flex-row-reverse"),
        ("flex-direction", "column-reverse") => Some("flex-col-reverse"),
        ("flex-wrap", "wrap") => Some("flex-wrap"),
        ("flex-wrap", "nowrap") => Some("flex-nowrap"),
        ("align-items", "center") => Some("items-center"),
        ("align-items", "flex-start") => Some("items-start"),
        ("align-items", "flex-end") => Some("items-end"),
        ("align-items", "stretch") => Some("items-stretch"),
        ("justify-content", "center") => Some("justify-center"),
        ("justify-content", "flex-start") => Some("justify-start"),
        ("justify-content", "flex-end") => Some("justify-end"),
        ("justify-content", "space-between") => Some("justify-between"),
        ("justify-content", "space-around") => Some("justify-around"),
        ("justify-content", "space-evenly") => Some("justify-evenly"),
        ("position", "relative") => Some("relative"),
        ("position", "absolute") => Some("absolute"),
        ("position", "fixed") => Some("fixed"),
        ("position", "sticky") => Some("sticky"),
        ("text-align", "left") => Some("text-left"),
        ("text-align", "center") => Some("text-center"),
        ("text-align", "right") => Some("text-right"),
        ("overflow", "hidden") => Some("overflow-hidden"),
        ("overflow", "auto") => Some("overflow-auto"),
        ("overflow", "visible") => Some("overflow-visible"),
        _ => None,
    };
    if let Some(class) = keyword {
        return Some(class.to_owned());
    }
    // Spaces are underscores in a class, so a real underscore is escaped.
    let arbitrary = value.replace('_', "\\_").replace(' ', "_");
    let prefix = match property.as_str() {
        "width" => Some("w"),
        "height" => Some("h"),
        "min-width" => Some("min-w"),
        "min-height" => Some("min-h"),
        "max-width" => Some("max-w"),
        "max-height" => Some("max-h"),
        "gap" => Some("gap"),
        "row-gap" => Some("gap-y"),
        "column-gap" => Some("gap-x"),
        "padding" => Some("p"),
        "margin" => Some("m"),
        "top" => Some("top"),
        "right" => Some("right"),
        "bottom" => Some("bottom"),
        "left" => Some("left"),
        "z-index" => Some("z"),
        "opacity" => Some("opacity"),
        "line-height" => Some("leading"),
        "border-radius" => Some("rounded"),
        _ => None,
    };
    Some(match prefix {
        Some(prefix) => format!("{prefix}-[{arbitrary}]"),
        None => format!("[{property}:{arbitrary}]"),
    })
}

#[cfg(test)]
mod tests {
    use finite_design::{
        Design, DesignMeta,
        edit::{self, NewArtboard},
        html::Policy,
        import::BlobHash,
    };

    use super::*;
    use crate::{Blobs, NoBlobs, assets::url};

    /// A design with one artboard, "Home — Desktop", holding `source`
    /// parsed the way an agent's `write_html` would, so scripts stay.
    fn board(source: &str) -> (Design, String) {
        let mut design = Design::new(DesignMeta {
            id: "d".into(),
            name: "Test".into(),
            created_at: 0,
            updated_at: 0,
        });
        let fragments = html::parse_with(source, Policy::Authoring)
            .unwrap()
            .fragments;
        let spec = NewArtboard {
            name: "Home — Desktop".into(),
            width: 1440.0,
            height: Some(900.0),
            position: None,
            page: None,
            styles: Default::default(),
        };
        let mut n = 0;
        let mut new_id = move || {
            n += 1;
            format!("n{n}")
        };
        let (ops, _) =
            edit::create_artboard_with(design.doc(), "board".into(), spec, fragments, &mut new_id)
                .unwrap();
        design.commit("agent", "test", &ops, 1);
        (design, "board".into())
    }

    fn jsx(source: &str, tailwind: bool) -> Converted {
        let (design, id) = board(source);
        let content = design.doc().children(Some(&id))[0].id.clone();
        convert(design.doc(), &content, &Options { tailwind }, 0).unwrap()
    }

    #[test]
    fn styles_become_objects_and_attributes_take_react_names() {
        let out = jsx(
            "<div class=\"card\" data-name=\"Card\" style=\"display: flex; --gap: 4px; -webkit-line-clamp: 2\"><label for=\"a\" tabindex=\"0\">Hi</label><input id=\"a\" value=\"x\" disabled><br></div>",
            false,
        );
        assert_eq!(
            out.jsx,
            "<div data-name=\"Card\" className=\"card\" style={{ \"--gap\": \"4px\", WebkitLineClamp: \"2\", display: \"flex\" }}>\n  <label htmlFor=\"a\" tabIndex=\"0\">Hi</label>\n  <input disabled id=\"a\" defaultValue=\"x\" />\n  <br />\n</div>"
        );
        assert!(out.diagnostics.is_empty());
    }

    #[test]
    fn text_jsx_cannot_hold_is_written_as_a_string() {
        let out = jsx("<p>a <b>b</b> {c}</p>", false);
        assert_eq!(out.jsx, "<p>\n  {\"a \"}\n  <b>b</b>\n  {\" {c}\"}\n</p>");
    }

    #[test]
    fn style_elements_become_template_literals() {
        let out = jsx(
            "<div><style>.a::after { content: \"`${x}\\\\\" }</style></div>",
            false,
        );
        assert!(
            out.jsx
                .contains("{`.a::after { content: \"\\`\\${x}\\\\\\\\\" }`}"),
            "{}",
            out.jsx
        );
    }

    #[test]
    fn scripts_are_left_out_and_reported() {
        let out = jsx("<div><p>hi</p><script>go()</script></div>", false);
        assert_eq!(out.jsx, "<div>\n  <p>hi</p>\n</div>");
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].feature, Feature::Script);
    }

    #[test]
    fn tailwind_uses_utilities_then_arbitrary_properties() {
        let out = jsx(
            "<div class=\"card\" style=\"display: flex; flex-direction: column; gap: 8px; padding: 4px 8px; background-color: #fff; font-family: &quot;Inter&quot;, sans-serif; margin: a_b; background-image: url(x.png)\"><p>Hi</p></div>",
            true,
        );
        let class = out.jsx.lines().next().unwrap();
        for expected in [
            "card",
            "flex",
            "flex-col",
            "gap-[8px]",
            "p-[4px_8px]",
            "[background-color:#fff]",
            "m-[a\\\\_b]",
        ] {
            assert!(class.contains(expected), "{expected} in {class}");
        }
        // A value a class can't hold stays in a style object, and the quotes
        // in the font stack move the classes into an expression.
        assert!(class.contains("className={\""), "{class}");
        assert!(class.contains("backgroundImage: \"url(x.png)\""), "{class}");
        assert!(!class.contains("style={{ display"), "{class}");
    }

    #[test]
    fn svg_attributes_are_camel_cased() {
        let out = jsx(
            "<svg viewbox=\"0 0 1 1\"><path stroke-width=\"2\" fill-rule=\"evenodd\" d=\"M0 0\"></path></svg>",
            false,
        );
        assert!(out.jsx.contains("viewBox=\"0 0 1 1\""), "{}", out.jsx);
        assert!(
            out.jsx.contains("fillRule=\"evenodd\" strokeWidth=\"2\""),
            "{}",
            out.jsx
        );
    }

    struct OneBlob(Vec<u8>);

    impl Blobs for OneBlob {
        fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
            Ok((*hash == BlobHash::of(&self.0)).then(|| self.0.clone()))
        }
    }

    #[test]
    fn an_artboard_exports_as_a_component_file() {
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let stored = url("d", &BlobHash::of(&png));
        let (design, id) = board(&format!("<div><img src=\"{stored}\" alt=\"a\"></div>"));
        let revision = |blobs| Revision {
            name: "Test",
            doc: design.doc(),
            imports: design.imports(),
            blobs,
            measure: &crate::scene::NoMeasure,
        };
        let scope = Scope::Artboard(id);
        let blobs = OneBlob(png);
        let exported = Jsx.write(&revision(&blobs), &scope).unwrap();
        assert_eq!(exported.file_name, "home-desktop.jsx");
        let file = String::from_utf8(exported.bytes).unwrap();
        assert!(
            file.starts_with("export default function HomeDesktop() {\n  return (\n"),
            "{file}"
        );
        assert!(file.contains("src=\"data:image/png;base64,"), "{file}");
        assert!(exported.diagnostics.is_empty());

        assert!(Jsx.write(&revision(&NoBlobs), &Scope::Design).is_err());
        assert!(
            Jsx.read(&Input {
                bytes: b"",
                file_name: None
            })
            .is_err()
        );
    }

    #[test]
    fn component_names_are_identifiers() {
        assert_eq!(component_name("Home — Desktop 2"), "HomeDesktop2");
        assert_eq!(component_name("2 up"), "Artboard2Up");
        assert_eq!(component_name("✨"), "Artboard");
    }
}
