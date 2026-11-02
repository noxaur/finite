//! HTML files: Finite's own language, so everything Finite can edit
//! converts exactly. The parsing and writing live in `finite_design::html`;
//! this module adds what a file needs on top: a page around the artboard on
//! the way out, and on the way in, a record of everything left out.

use finite_design::html::{self, Dropped, ExportOptions, Policy};

use crate::{
    Anchor, Board, Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input,
    Revision, Score, Support, file_stem,
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
        }
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        let source = std::str::from_utf8(input.bytes)
            .map_err(|_| Error("the file isn't UTF-8 text, so it can't be HTML".into()))?;
        let parsed = html::parse_with(source, Policy::Import).map_err(|e| Error(e.to_string()))?;
        let name = input
            .file_name
            .map(|name| name.rsplit_once('.').map_or(name, |(stem, _)| stem))
            .filter(|name| !name.is_empty())
            .unwrap_or("Imported HTML");
        Ok(Imported {
            format: self.name(),
            input_kind: "html".into(),
            boards: vec![Board {
                name: name.to_owned(),
                width: WIDTH,
                height: HEIGHT,
                content: parsed.fragments,
            }],
            dependencies: Vec::new(),
            diagnostics: parsed.dropped.into_iter().map(quarantine).collect(),
        })
    }

    fn write(&self, revision: &Revision<'_>, artboard: &str) -> Result<Exported, Error> {
        let doc = revision.doc;
        let board = doc
            .get(artboard)
            .filter(|n| n.is_artboard())
            .ok_or_else(|| Error(format!("{artboard:?} isn't an artboard")))?;
        let options = ExportOptions {
            names: true,
            ..ExportOptions::default()
        };
        let body = html::export_with(doc, artboard, &options)
            .map(|e| e.html)
            .ok_or_else(|| Error(format!("{artboard:?} isn't an artboard")))?;
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
        Ok(Exported {
            file_name: format!("{}.html", file_stem(&title)),
            media_type: "text/html; charset=utf-8",
            bytes: page.into_bytes(),
            diagnostics: Vec::new(),
        })
    }
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

#[cfg(test)]
mod tests {
    use finite_design::{
        Design, DesignMeta, Op,
        import::{BlobHash, ImportRecord},
    };

    use super::*;
    use crate::{Format, Placed, Receipt};

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
            doc: design.doc(),
            imports: design.imports(),
        };
        let exported = Html.write(&revision, &placed.artboards[0]).unwrap();
        assert_eq!(exported.file_name, "page.html");
        let page = String::from_utf8(exported.bytes).unwrap();
        assert!(page.starts_with("<!doctype html>"), "{page}");
        assert!(page.contains("<title>page</title>"), "{page}");

        // Importing the page gives back the artboard, as a <div> in a new one,
        // after the page's base <style>. The page's <meta> and <title> act on
        // the page, so they're quarantined.
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
        assert_eq!(quarantined, ["<meta>", "<meta>", "<title>"]);
    }
}
