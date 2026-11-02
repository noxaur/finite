//! HTML files: Finite's own language, so everything Finite can edit
//! converts exactly. The parsing and writing live in `finite_design::html`;
//! this module adds what a file needs on top: a page around the artboard on
//! the way out, and on the way in, a record of everything left out.

use std::collections::BTreeSet;

use base64::{Engine, engine::general_purpose::STANDARD};
use finite_design::{
    html::{self, Dropped, ExportOptions, Fragment, Policy},
    import::Dependency,
};

use crate::{
    Anchor, Board, Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input,
    Revision, Scope, Score, Support, assets, file_stem,
};

/// The size of the artboard an HTML file goes into: a desktop screen.
const WIDTH: f64 = 1440.0;
const HEIGHT: f64 = 900.0;

pub struct Html;

impl Codec for Html {
    fn name(&self) -> &'static str {
        "html"
    }

    fn support(&self, feature: Feature, direction: Direction) -> Support {
        use {Direction::*, Support::*};
        match (feature, direction) {
            (
                Feature::Frame
                | Feature::Text
                | Feature::SolidFill
                | Feature::Image
                | Feature::FlexLayout,
                Import | Export,
            ) => Exact,
            // Imported scripts are quarantined; scripts written in Finite export as they are.
            (Feature::Script, Import) => Opaque,
            (Feature::Script, Export) => Exact,
            // Finite never holds embeds, so there are none to export.
            (Feature::Embed, Import) => Opaque,
            (Feature::Embed, Export) => Unsupported,
            // A page is the design, not how it got there.
            (Feature::ImportHistory, Import | Export) => Unsupported,
        }
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        let source = std::str::from_utf8(input.bytes)
            .map_err(|_| Error("the file isn't UTF-8 text, so it can't be HTML".into()))?;
        let file_stem = input
            .file_name
            .map(|name| name.rsplit_once('.').map_or(name, |(stem, _)| stem))
            .filter(|name| !name.is_empty());
        let mut board = Board {
            name: file_stem.unwrap_or("Imported HTML").to_owned(),
            width: WIDTH,
            height: HEIGHT,
            ..Board::default()
        };
        let mut diagnostics = Vec::new();
        let parsed = if is_page(source) {
            // The <html> and <body> become the artboard: their styles, like
            // a background, and attributes, like `class` and `lang`.
            let page =
                html::parse_page(source, Policy::Import).map_err(|e| Error(e.to_string()))?;
            if file_stem.is_none() {
                board.name = page.title.unwrap_or(board.name);
            }
            board.styles = page.styles;
            board.attrs = page.attrs;
            board.source = Some("/1".into());
            diagnostics.extend(page_selectors(&page.content.fragments));
            page.content
        } else {
            html::parse_with(source, Policy::Import).map_err(|e| Error(e.to_string()))?
        };
        board.content = parsed.fragments;
        board.paths = parsed.paths;
        let dependencies = dependencies(&board);
        diagnostics.extend(parsed.dropped.into_iter().map(quarantine));
        Ok(Imported {
            format: self.name(),
            input_kind: "html".into(),
            boards: vec![board],
            css: None,
            blobs: Vec::new(),
            dependencies,
            diagnostics,
        })
    }

    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
        let Scope::Artboard(_) = scope else {
            return Err(Error("an HTML file holds one artboard; pick one".into()));
        };
        let board = revision.artboards(scope)?[0];
        let doc = revision.doc;
        let options = ExportOptions {
            names: true,
            ..ExportOptions::default()
        };
        let body = html::export_with(doc, &board.id, &options)
            .map(|e| e.html)
            .ok_or_else(|| Error(format!("{:?} isn't an artboard", board.id)))?;
        let shared = doc.css().map_or(String::new(), |css| {
            format!("\n<style>{}</style>", html::shared_style(css, false))
        });
        let title = board.display_name();
        let page = format!(
            "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\">\n<title>{title}</title>\n<style>@layer {layer} {{ {base} html, body {{ margin: 0; }} }}</style>{shared}\n</head>\n<body>\n{body}\n</body>\n</html>\n",
            csp = html::CSP,
            title = html::escape(&title, false),
            layer = html::BASE_LAYER,
            base = html::BASE_CSS,
        );
        // Files the design stores, like imported images, go inline: their
        // URLs only work on this server.
        let mut diagnostics = Vec::new();
        let mut failed = None;
        let page = assets::rewrite_urls(&page, |hash| match revision.blobs.get(hash) {
            Ok(Some(bytes)) => Some(format!(
                "data:{};base64,{}",
                assets::media_type(&bytes),
                STANDARD.encode(&bytes)
            )),
            Ok(None) => {
                diagnostics.push(Diagnostic {
                    node: None,
                    path: assets::url("…", hash),
                    what: "an image".into(),
                    feature: Feature::Image,
                    reason: "the design points at a file its store doesn't have".into(),
                    preserved: Score::No,
                    visual: Score::No,
                    editable: Score::No,
                    quarantined: false,
                });
                None
            }
            Err(error) => {
                failed.get_or_insert(error);
                None
            }
        });
        if let Some(error) = failed {
            return Err(error);
        }
        Ok(Exported {
            file_name: format!("{}.html", file_stem(&title)),
            media_type: "text/html; charset=utf-8",
            bytes: page.into_bytes(),
            diagnostics,
        })
    }
}

/// Whether `source` is a whole page rather than a fragment: it starts with
/// a doctype, or has `<html>`, `<head>` or `<body>` near the top.
fn is_page(source: &str) -> bool {
    let head: String = source
        .chars()
        .take(2048)
        .collect::<String>()
        .to_ascii_lowercase();
    ["<!doctype", "<html", "<head", "<body"]
        .iter()
        .any(|tag| head.contains(tag))
}

/// A diagnostic for content the parser left out. All of it stays in the
/// import's original bytes, so it's preserved but not editable.
fn quarantine(dropped: Dropped) -> (Anchor, Diagnostic) {
    let script = dropped.what == "<script>" || !dropped.what.starts_with('<');
    let (feature, visual) = if script {
        // A script might change how the page looks once it runs, or not.
        (Feature::Script, Score::Unknown)
    } else {
        // An embed shows something, and Finite won't.
        (Feature::Embed, Score::No)
    };
    let anchor = Anchor {
        board: 0,
        node: dropped.anchor,
    };
    let diagnostic = Diagnostic {
        node: None,
        path: dropped.path,
        what: dropped.what,
        feature,
        reason: dropped.reason.to_owned(),
        preserved: Score::Yes,
        visual,
        editable: Score::No,
        quarantined: true,
    };
    (anchor, diagnostic)
}

/// A page's `<style>` blocks may select `html` or `body`, which became the
/// artboard, so those rules may no longer match anything.
fn page_selectors(fragments: &[Fragment]) -> Vec<(Anchor, Diagnostic)> {
    let mut out = Vec::new();
    let mut ordinal = 0;
    for fragment in fragments {
        if fragment.tag() == Some("style") {
            let css = fragment.inner_text().to_ascii_lowercase();
            if css.contains("body") || css.contains("html") {
                let anchor = Anchor {
                    board: 0,
                    node: Some(ordinal),
                };
                out.push((
                    anchor,
                    Diagnostic {
                        node: None,
                        path: String::new(),
                        what: "<style>".into(),
                        feature: Feature::Frame,
                        reason: "it styles <html> or <body>, which became the artboard".into(),
                        preserved: Score::Yes,
                        visual: Score::Unknown,
                        editable: Score::Yes,
                        quarantined: false,
                    },
                ));
            }
        }
        ordinal += fragment.count();
    }
    out
}

/// Every resource the board points to outside itself, like a remote image
/// or a stylesheet's `@import`. v1 doesn't fetch them; the record lists them
/// so it's clear the import isn't self-contained.
fn dependencies(board: &Board) -> Vec<Dependency> {
    let mut urls = BTreeSet::new();
    let mut values: Vec<&str> = Vec::new();
    values.extend(board.styles.values().map(String::as_str));
    fn walk<'a>(fragments: &'a [Fragment], values: &mut Vec<&'a str>, urls: &mut BTreeSet<String>) {
        for fragment in fragments {
            for (name, value) in &fragment.attrs {
                match name.as_str() {
                    "src" | "poster" => {
                        urls.insert(value.trim().to_owned());
                    }
                    "srcset" => urls.extend(
                        value
                            .split(',')
                            .filter_map(|c| c.split_whitespace().next())
                            .map(str::to_owned),
                    ),
                    "href" | "xlink:href"
                        if matches!(fragment.tag(), Some("image" | "use" | "feImage")) =>
                    {
                        urls.insert(value.trim().to_owned());
                    }
                    _ => {}
                }
            }
            values.extend(fragment.styles.values().map(String::as_str));
            if fragment.tag() == Some("style")
                && let Some(text) = fragment.children.first().and_then(|c| c.text.as_deref())
            {
                values.push(text);
            }
            walk(&fragment.children, values, urls);
        }
    }
    walk(&board.content, &mut values, &mut urls);
    for value in values {
        urls.extend(css_urls(value));
    }
    urls.into_iter()
        .filter(|url| is_external(url))
        .map(|url| Dependency { url, blob: None })
        .collect()
}

/// The URLs in CSS: each `url(…)`, and each `@import "…"`.
fn css_urls(css: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let lower = css.to_ascii_lowercase();
    for (marker, close) in [("url(", ")"), ("@import \"", "\""), ("@import '", "'")] {
        let mut from = 0;
        while let Some(at) = lower[from..].find(marker) {
            let start = from + at + marker.len();
            let Some(len) = css[start..].find(close) else {
                break;
            };
            let url = css[start..start + len].trim().trim_matches(['"', '\'']);
            urls.push(url.to_owned());
            from = start + len;
        }
    }
    urls
}

/// Whether `url` names something outside the file: not inline data, not a
/// fragment of the page, not one of the design's own blobs.
fn is_external(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    !url.is_empty()
        && !url.starts_with('#')
        && !["data:", "blob:", "about:", assets::SCHEME]
            .iter()
            .any(|scheme| lower.starts_with(scheme))
}

#[cfg(test)]
mod tests {
    use finite_design::{
        Design, DesignMeta, Op,
        import::{BlobHash, ImportRecord},
    };

    use super::*;
    use crate::{Blobs, Format, NoBlobs, Placed, Receipt};

    fn design() -> Design {
        Design::new(DesignMeta {
            id: "d".into(),
            name: "Test".into(),
            created_at: 0,
            updated_at: 0,
        })
    }

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("n{n}")
        }
    }

    fn receipt() -> Receipt {
        Receipt {
            id: "i1".into(),
            design: "d".into(),
            artifact: BlobHash::of(b"<p>hi</p>"),
            file_name: Some("page.html".into()),
            received_at: 7,
        }
    }

    fn import(design: &mut Design, source: &str) -> Result<(ImportRecord, Placed), Error> {
        let input = Input {
            bytes: source.as_bytes(),
            file_name: Some("page.html"),
        };
        let imported = Format::Html.codec().read(&input)?;
        let mut new_id = ids();
        let (_, placed) = design.import("agent", "Import page.html", 1, |tx| {
            let (record, placed) = imported.place(tx, receipt(), &mut new_id)?;
            Ok::<_, Error>((record.clone(), (record, placed)))
        })?;
        Ok(placed)
    }

    #[test]
    fn imports_into_a_new_artboard_named_after_the_file() {
        let mut design = design();
        let (record, placed) = import(&mut design, "<h1 style=\"color: red\">Hi</h1>").unwrap();
        let board = design.doc().get(&placed.artboards[0]).unwrap();
        assert_eq!(board.name.as_deref(), Some("page"));
        let h1 = design.doc().children(Some(&board.id))[0];
        assert_eq!(h1.styles["color"], "red");
        assert_eq!(record.format, "html");
        assert!(record.quarantined.is_empty());
        assert_eq!(design.imports(), [record]);
    }

    #[test]
    fn code_is_quarantined_on_the_nearest_kept_node() {
        let mut design = design();
        let source = "<div><button onclick=\"steal()\">Go</button><script>steal()</script></div><iframe src=\"https://x\"></iframe>";
        let (record, placed) = import(&mut design, source).unwrap();
        let board = &placed.artboards[0];
        let div = design.doc().children(Some(board))[0].id.clone();
        let button = design.doc().children(Some(&div))[0].clone();
        // Nothing that runs made it into the document.
        assert!(button.attrs.is_empty());
        assert_eq!(design.doc().children(Some(&div)).len(), 1);
        assert_eq!(design.doc().children(Some(board)).len(), 1);
        let found: Vec<_> = record
            .quarantined
            .iter()
            .map(|q| (q.what.as_str(), q.node.as_deref()))
            .collect();
        assert_eq!(
            found,
            [
                ("onclick", Some(button.id.as_str())),
                ("<script>", Some(div.as_str())),
                ("<iframe>", Some(board.as_str())),
            ]
        );
        assert!(placed.diagnostics.iter().all(|d| d.preserved == Score::Yes));
        assert_eq!(placed.diagnostics[2].feature, Feature::Embed);
    }

    #[test]
    fn a_file_with_nothing_to_show_still_keeps_its_record() {
        let mut design = design();
        let (record, placed) = import(&mut design, "<script>x()</script>").unwrap();
        assert_eq!(placed.artboards.len(), 1);
        assert_eq!(record.quarantined.len(), 1);
        // Undoing the import removes the artboard but keeps the record.
        design.undo("agent", 2).unwrap();
        assert!(design.doc().is_empty());
        assert_eq!(design.imports().len(), 1);
    }

    #[test]
    fn a_failed_import_changes_nothing() {
        let mut design = design();
        let input = Input {
            bytes: b"<p>hi</p>",
            file_name: None,
        };
        let imported = Html.read(&input).unwrap();
        let mut new_id = ids();
        let result = design.import("agent", "Import", 1, |tx| {
            let (record, _) = imported.place(tx, receipt(), &mut new_id)?;
            // A later step that doesn't apply undoes the artboard already made.
            tx.apply(&[Op::Delete { id: "gone".into() }])?;
            Ok::<_, Error>((record, ()))
        });
        assert_eq!(result.unwrap_err().0, "node \"gone\" doesn't exist");
        assert!(design.doc().is_empty());
        assert!(design.imports().is_empty());
        assert_eq!(design.seq(), 0);
    }

    #[test]
    fn exports_a_page_that_imports_back_the_same() {
        let mut design = design();
        let source = "<div data-name=\"Card\" style=\"display: flex; gap: 8px\"><p>One</p><img src=\"https://x/a.png\"></div>";
        let (_, placed) = import(&mut design, source).unwrap();
        let revision = Revision {
            name: "Test",
            doc: design.doc(),
            imports: design.imports(),
            blobs: &NoBlobs,
            measure: &crate::scene::NoMeasure,
        };
        let board = Scope::Artboard(placed.artboards[0].clone());
        let exported = Html.write(&revision, &board).unwrap();
        assert_eq!(exported.file_name, "page.html");
        let page = String::from_utf8(exported.bytes).unwrap();
        assert!(page.starts_with("<!doctype html>"), "{page}");
        assert!(page.contains("<title>page</title>"), "{page}");

        // Importing the page gives back the artboard, as a <div> in a new one,
        // after the page's base <style>. The page's <meta>s act on the page,
        // so they're quarantined.
        let mut again = Design::new(design.meta.clone());
        let (record, placed_again) = import(&mut again, &page).unwrap();
        let copy = again
            .doc()
            .children(Some(&placed_again.artboards[0]))
            .into_iter()
            .find(|n| n.tag() == Some("div"))
            .unwrap()
            .id
            .clone();
        assert_eq!(
            html::export(again.doc(), &copy, false),
            html::export(design.doc(), &placed.artboards[0], false)
        );
        let quarantined: Vec<_> = record.quarantined.iter().map(|q| q.what.as_str()).collect();
        assert_eq!(quarantined, ["<meta>", "<meta>"]);
    }

    #[test]
    fn a_whole_page_keeps_what_its_body_carried() {
        let mut design = design();
        let source = "<!doctype html><html lang=\"sv\"><head><title>Home</title><style>body { margin: 0 }</style></head><body class=\"page\" style=\"background: red\" onload=\"x()\"><p>Hej</p></body></html>";
        let input = Input {
            bytes: source.as_bytes(),
            file_name: None,
        };
        let imported = Html.read(&input).unwrap();
        let mut new_id = ids();
        let (_, (record, placed)) = design
            .import("agent", "Import", 1, |tx| {
                let (record, placed) = imported.place(tx, receipt(), &mut new_id)?;
                Ok::<_, Error>((record.clone(), (record, placed)))
            })
            .unwrap();
        let board = design.doc().get(&placed.artboards[0]).unwrap();
        assert_eq!(board.name.as_deref(), Some("Home"));
        assert_eq!(board.styles["background"], "red");
        assert_eq!(board.attrs["class"], "page");
        assert_eq!(board.attrs["lang"], "sv");
        assert!(!board.attrs.contains_key("onload"));
        let what: Vec<_> = placed.diagnostics.iter().map(|d| d.what.as_str()).collect();
        assert_eq!(what, ["<style>", "onload"]);
        // Every node remembers where it came from.
        let paths: Vec<_> = record.nodes.values().map(String::as_str).collect();
        assert_eq!(paths, ["/1", "/0/1", "/0/1/0", "/1/0", "/1/0/0"]);
    }

    #[test]
    fn resources_outside_the_file_are_listed() {
        let mut design = design();
        let source = "<style>@import \"https://fonts.example/a.css\"; .x { background: url('/bg.png') }</style><img src=\"https://img.example/a.png\" srcset=\"a.png 1x, b.png 2x\"><img src=\"data:image/png;base64,AA\"><a href=\"https://not.a.resource\">x</a>";
        let (record, _) = import(&mut design, source).unwrap();
        let urls: Vec<_> = record.dependencies.iter().map(|d| d.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "/bg.png",
                "a.png",
                "b.png",
                "https://fonts.example/a.css",
                "https://img.example/a.png"
            ]
        );
        assert!(record.dependencies.iter().all(|d| d.blob.is_none()));
    }

    struct OneBlob(Vec<u8>);

    impl Blobs for OneBlob {
        fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
            Ok((*hash == BlobHash::of(&self.0)).then(|| self.0.clone()))
        }
    }

    #[test]
    fn stored_images_export_inline() {
        let mut design = design();
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let stored = assets::url("d", &BlobHash::of(&png));
        let missing = assets::url("d", &BlobHash::of(b"gone"));
        let source = format!("<img src=\"{stored}\"><img src=\"{missing}\">");
        let (_, placed) = import(&mut design, &source).unwrap();
        let revision = Revision {
            name: "Test",
            doc: design.doc(),
            imports: design.imports(),
            blobs: &OneBlob(png),
            measure: &crate::scene::NoMeasure,
        };
        let exported = Html
            .write(&revision, &Scope::Artboard(placed.artboards[0].clone()))
            .unwrap();
        let page = String::from_utf8(exported.bytes).unwrap();
        assert!(page.contains("src=\"data:image/png;base64,"), "{page}");
        assert!(page.contains(&missing), "{page}");
        assert_eq!(exported.diagnostics.len(), 1);
        assert_eq!(exported.diagnostics[0].preserved, Score::No);
        // A whole design doesn't fit in one HTML file.
        assert!(Html.write(&revision, &Scope::Design).is_err());
    }
}
