//! A design as a folder of text files, for keeping next to the code.
//!
//! The folder holds one HTML file per artboard, so a pull request shows
//! what changed in each screen, plus the shared CSS and a manifest:
//!
//! ```text
//! finite.json          name, pages, and each artboard's file, page and position
//! shared.css           the design's shared CSS, if it has any
//! artboards/home.html  one artboard: its <div> and everything inside
//! assets/<sha256>.png  the files the design points to
//! ```
//!
//! Export writes the folder as one tar archive, since a codec produces one
//! file. Unpack it with `tar -xf`. To import a folder back, pack it with
//! `tar -cf design.tar finite.json shared.css artboards assets`; a single
//! top-level folder around those is fine too. Files are written the same
//! way every time, so an unchanged design leaves no diff.
//!
//! Layer names, styles, attributes and text come back as they were, along
//! with each artboard's size, position and page. Node ids, history,
//! comments and import records do not, as with a `.finite` bundle.
//! Reading applies the same rules as an HTML import: scripts and other
//! code that could run are quarantined.

mod tar;

use std::collections::BTreeMap;

use finite_design::{
    MAX_DEPTH, NodeKind,
    edit::pixel_size,
    html::{self, ExportOptions, Fragment, Policy},
    import::{BlobHash, Dependency},
    version::{Schema, VersionError},
};
use serde::{Deserialize, Serialize};

use crate::{
    Anchor, Board, Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input,
    Revision, Scope, Score, Support, assets, file_stem, html::quarantine,
};

/// The manifest's format and version. See `finite_design::version`.
pub const REPO: Schema = Schema {
    name: "Finite folder",
    version: 1,
    upgrades: &[],
};

/// What the manifest's `kind` says, so a stray JSON file isn't taken for one.
const KIND: &str = "finite-repo";
const MANIFEST: &str = "finite.json";
const CSS: &str = "shared.css";

/// Used for an artboard whose width or height isn't in pixels.
const FALLBACK: (f64, f64) = (1440.0, 900.0);

/// The longest file name stem, so a path fits in a tar header.
const STEM: usize = 60;

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    v: u32,
    kind: String,
    name: String,
    /// The design's pages, by name, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pages: Vec<String>,
    /// The path of the shared CSS, if the design has any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    css: Option<String>,
    /// Every artboard, in canvas order.
    artboards: Vec<Artboard>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Artboard {
    file: String,
    /// The name of the page it's on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
}

pub struct Repo;

impl Codec for Repo {
    fn name(&self) -> &'static str {
        "repo"
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
            // Like HTML: scripts are quarantined on the way in.
            (Feature::Script, Import) => Opaque,
            (Feature::Script, Export) => Exact,
            (Feature::Embed, Import) => Opaque,
            (Feature::Embed, Export) => Unsupported,
            // The folder holds the design, not how it got there.
            (Feature::ImportHistory, Import | Export) => Unsupported,
        }
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        let files = Files::of(tar::read(input.bytes)?)?;
        let manifest_json = files.text(MANIFEST)?.ok_or_else(|| {
            Error(format!(
                "this isn't a Finite folder: it has no {MANIFEST} at its top"
            ))
        })?;
        let limit = 2 * MAX_DEPTH + 8;
        let manifest: Manifest = REPO
            .decode_nested(manifest_json, limit)
            .map_err(|e| match e {
                VersionError::Json(e) => Error(format!("this isn't a Finite folder: {e}")),
                other => Error(other.to_string()),
            })?;
        if manifest.kind != KIND {
            return Err(Error(format!(
                "this isn't a Finite folder: its kind is {:?}",
                manifest.kind
            )));
        }
        let mut diagnostics = Vec::new();
        let mut boards = Vec::new();
        for (i, entry) in manifest.artboards.iter().enumerate() {
            let source = files.text(&entry.file)?.ok_or_else(|| {
                Error(format!(
                    "{MANIFEST} lists {}, which isn't in the folder",
                    entry.file
                ))
            })?;
            boards.push(board(i, entry, source, &mut diagnostics)?);
        }
        let css = match &manifest.css {
            Some(path) => Some(
                files
                    .text(path)?
                    .ok_or_else(|| {
                        Error(format!(
                            "{MANIFEST} lists {path}, which isn't in the folder"
                        ))
                    })?
                    .to_owned(),
            ),
            None => None,
        };
        let blobs = files.blobs(&mut boards, css.as_deref())?;
        let dependencies = blobs
            .iter()
            .map(|(hash, _)| Dependency {
                url: format!("{}{hash}", assets::SCHEME),
                blob: Some(hash.clone()),
            })
            .collect();
        Ok(Imported {
            format: self.name(),
            input_kind: format!("finite-repo v{}", REPO.version),
            pages: manifest.pages,
            boards,
            css,
            blobs: blobs.into_iter().map(|(_, bytes)| bytes).collect(),
            dependencies,
            diagnostics,
        })
    }

    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
        let doc = revision.doc;
        let mut hashes = Vec::new();
        let mut portable = |value: &str| {
            let (value, found) = assets::portable(value);
            hashes.extend(found);
            value
        };
        // Exported compactly, then laid out by `lay_out`: the writer's own
        // indent puts newlines inside mixed text, which would read back as text.
        let options = ExportOptions {
            names: true,
            indent: false,
            ..ExportOptions::default()
        };
        let mut files = Vec::new();
        let mut artboards = Vec::new();
        let mut taken = Vec::new();
        for board in revision.artboards(scope)? {
            let export = html::export_with(doc, &board.id, &options)
                .ok_or_else(|| Error(format!("{:?} isn't an artboard", board.id)))?;
            let file = unique_file(&board.display_name(), &mut taken);
            files.push(tar::Entry {
                path: file.clone(),
                bytes: lay_out(&portable(&export.html)).into_bytes(),
            });
            let page = match scope {
                Scope::Design => doc.page(doc.page_of(board)).map(|p| p.name.clone()),
                Scope::Artboard(_) => None,
            };
            artboards.push(Artboard {
                file,
                page,
                x: board.x,
                y: board.y,
            });
        }
        let pages = match scope {
            Scope::Design => doc
                .pages()
                .into_iter()
                .map(|(_, p)| p.name.clone())
                .collect(),
            Scope::Artboard(_) => Vec::new(),
        };
        let css = doc.css().map(&mut portable);
        let manifest = Manifest {
            v: REPO.version,
            kind: KIND.into(),
            name: revision.name.to_owned(),
            pages,
            css: css.as_ref().map(|_| CSS.to_owned()),
            artboards,
        };
        let mut json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| Error(format!("couldn't write the manifest: {e}")))?;
        json.push('\n');
        let mut entries = vec![tar::Entry {
            path: MANIFEST.into(),
            bytes: json.into_bytes(),
        }];
        entries.extend(css.map(|css| tar::Entry {
            path: CSS.into(),
            bytes: css.into_bytes(),
        }));
        entries.extend(files);

        let mut diagnostics = Vec::new();
        hashes.sort();
        hashes.dedup();
        for hash in hashes {
            match revision.blobs.get(&hash)? {
                Some(bytes) => entries.push(tar::Entry {
                    path: format!("assets/{hash}{}", extension(&bytes)),
                    bytes,
                }),
                None => diagnostics.push(Diagnostic {
                    node: None,
                    path: format!("{}{hash}", assets::SCHEME),
                    what: "a file".into(),
                    feature: Feature::Image,
                    reason: "the design points at a file its store doesn't have".into(),
                    preserved: Score::No,
                    visual: Score::No,
                    editable: Score::No,
                    quarantined: false,
                }),
            }
        }
        if *scope == Scope::Design && !revision.imports.is_empty() {
            diagnostics.push(Diagnostic {
                node: None,
                path: String::new(),
                what: format!("{} import record(s)", revision.imports.len()),
                feature: Feature::ImportHistory,
                reason: "a folder doesn't carry the files the design was imported from".into(),
                preserved: Score::No,
                visual: Score::Yes,
                editable: Score::Yes,
                quarantined: false,
            });
        }
        let stem = match scope {
            Scope::Design => revision.name.to_owned(),
            Scope::Artboard(_) => revision.artboards(scope)?[0].display_name(),
        };
        Ok(Exported {
            file_name: format!("{}.finite-repo.tar", file_stem(&stem)),
            media_type: "application/x-tar",
            bytes: tar::write(&entries)?,
            diagnostics,
        })
    }
}

/// `artboards/<name>.html`, with a number added if `taken` has the name.
fn unique_file(name: &str, taken: &mut Vec<String>) -> String {
    let stem: String = file_stem(name).chars().take(STEM).collect();
    let mut file = format!("artboards/{stem}.html");
    let mut n = 1;
    while taken.contains(&file) {
        n += 1;
        file = format!("artboards/{stem}-{n}.html");
    }
    taken.push(file.clone());
    file
}

/// Tags that have no end tag.
const VOID: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// Tags whose content is written as it is, never laid out.
const VERBATIM: [&str; 5] = ["pre", "script", "style", "textarea", "title"];

/// Puts each tag on its own line, indented by depth, wherever another tag
/// or the start of the file comes right before it. Where text comes
/// before, the line is left alone, because the text would otherwise gain
/// whitespace. The parser drops whitespace-only text that has a newline,
/// so the added lines read back as nothing: the document comes back
/// exactly, which the writer's own indentation can't promise for text
/// mixed with elements. `compact` is [`html::export_with`] with `indent`
/// off, so every `<` that isn't a tag is escaped and attribute values are quoted.
fn lay_out(compact: &str) -> String {
    let mut out = String::with_capacity(compact.len() + compact.len() / 8);
    let (mut depth, mut i) = (0usize, 0usize);
    let (mut after_tag, mut after_open) = (false, false);
    while i < compact.len() {
        let Some(open) = compact[i..].find('<').map(|n| n + i) else {
            out.push_str(&compact[i..]);
            break;
        };
        if open > i {
            out.push_str(&compact[i..open]);
            (after_tag, after_open) = (false, false);
        }
        let mut end = open + 1;
        let mut quote = None;
        for (n, c) in compact[end..].char_indices() {
            match (quote, c) {
                (Some(q), c) if c == q => quote = None,
                (None, '"' | '\'') => quote = Some(c),
                (None, '>') => {
                    end = open + 1 + n + 1;
                    break;
                }
                _ => {}
            }
            end = open + 1 + n + c.len_utf8();
        }
        let tag = &compact[open..end];
        let closing = tag.starts_with("</");
        let name: String = tag
            .trim_start_matches("</")
            .trim_start_matches('<')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>()
            .to_ascii_lowercase();
        let void = tag.ends_with("/>") || VOID.contains(&name.as_str());
        if closing {
            depth = depth.saturating_sub(1);
        }
        if after_tag && !(closing && after_open) {
            out.push('\n');
            out.push_str(&"  ".repeat(depth));
        }
        out.push_str(tag);
        i = end;
        after_tag = true;
        after_open = !closing && !void;
        if after_open {
            depth += 1;
            if VERBATIM.contains(&name.as_str()) {
                let close = format!("</{name}");
                let lower = compact[i..].to_ascii_lowercase();
                let stop = lower.find(&close).map_or(compact.len(), |n| n + i);
                out.push_str(&compact[i..stop]);
                i = stop;
                (after_tag, after_open) = (false, false);
            }
        }
    }
    out.push('\n');
    out
}

/// The extension that lets a file manager open a blob, from its first bytes.
fn extension(bytes: &[u8]) -> &'static str {
    match assets::media_type(bytes) {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        _ => "",
    }
}

/// The files of an archive, by path relative to the folder's top.
struct Files(BTreeMap<String, Vec<u8>>);

impl Files {
    /// Finds the folder in `entries`: the one holding `finite.json`, either
    /// at the archive's top or inside a single folder.
    fn of(entries: Vec<tar::Entry>) -> Result<Self, Error> {
        let clean = |path: &str| path.trim_start_matches("./").to_owned();
        let usable = |path: &str| {
            let name = path.rsplit('/').next().unwrap_or(path);
            !name.starts_with("._") && !path.split('/').any(|part| part == "..")
        };
        let entries: Vec<(String, Vec<u8>)> = entries
            .into_iter()
            .map(|e| (clean(&e.path), e.bytes))
            .filter(|(path, _)| usable(path) && !path.starts_with('/'))
            .collect();
        let root = entries
            .iter()
            .map(|(path, _)| path.as_str())
            .find_map(|path| match path.split_once('/') {
                None if path == MANIFEST => Some(String::new()),
                Some((dir, MANIFEST)) => Some(format!("{dir}/")),
                _ => None,
            })
            .unwrap_or_default();
        Ok(Self(
            entries
                .into_iter()
                .filter_map(|(path, bytes)| Some((path.strip_prefix(&root)?.to_owned(), bytes)))
                .collect(),
        ))
    }

    fn text(&self, path: &str) -> Result<Option<&str>, Error> {
        self.0
            .get(path)
            .map(|bytes| {
                std::str::from_utf8(bytes).map_err(|_| Error(format!("{path} isn't UTF-8 text")))
            })
            .transpose()
    }

    /// The files under `assets/`, checked against their names and against
    /// everything the content refers to.
    fn blobs(
        &self,
        boards: &mut [Board],
        css: Option<&str>,
    ) -> Result<Vec<(BlobHash, Vec<u8>)>, Error> {
        let mut blobs: BTreeMap<BlobHash, Vec<u8>> = BTreeMap::new();
        for (path, bytes) in &self.0 {
            let Some(name) = path.strip_prefix("assets/") else {
                continue;
            };
            let stem = name.split('.').next().unwrap_or(name);
            let hash = BlobHash::parse(stem)
                .map_err(|_| Error(format!("{path} isn't named for its sha256")))?;
            if BlobHash::of(bytes) != hash {
                return Err(Error(format!("{path} doesn't match its hash")));
            }
            blobs.insert(hash, bytes.clone());
        }
        let mut referenced = Vec::new();
        let mut collect = |value: &mut String| referenced.extend(assets::referenced(value));
        for board in boards {
            board.styles.values_mut().for_each(&mut collect);
            board.attrs.values_mut().for_each(&mut collect);
            assets::for_each_value(&mut board.content, &mut collect);
        }
        referenced.extend(css.into_iter().flat_map(assets::referenced));
        if let Some(missing) = referenced.iter().find(|h| !blobs.contains_key(*h)) {
            return Err(Error(format!(
                "the folder refers to a file it doesn't contain: {}{missing}",
                assets::SCHEME
            )));
        }
        Ok(blobs.into_iter().collect())
    }
}

/// An artboard's file, as a board to create. The file holds the artboard's
/// own element, so its styles and attributes become the board's and its
/// children the content.
fn board(
    i: usize,
    entry: &Artboard,
    source: &str,
    diagnostics: &mut Vec<(Anchor, Diagnostic)>,
) -> Result<Board, Error> {
    let file = &entry.file;
    let mut parsed =
        html::parse_with(source, Policy::Import).map_err(|e| Error(format!("{file}: {e}")))?;
    let [root] = parsed.fragments.as_mut_slice() else {
        return Err(Error(format!(
            "{file} should hold one element, the artboard, but holds {}",
            parsed.fragments.len()
        )));
    };
    if !matches!(root.kind, NodeKind::Element { .. }) {
        return Err(Error(format!("{file} should hold an element, not text")));
    }
    let root = std::mem::replace(
        root,
        Fragment {
            kind: NodeKind::Text,
            name: None,
            text: None,
            styles: BTreeMap::new(),
            attrs: BTreeMap::new(),
            children: Vec::new(),
        },
    );
    let probe = finite_design::Node {
        styles: root.styles.clone(),
        ..finite_design::Node::element("", "div")
    };
    let (width, height) = match pixel_size(&probe) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (w, h),
        _ => {
            diagnostics.push((
                Anchor {
                    board: i,
                    node: None,
                },
                Diagnostic {
                    node: None,
                    path: file.clone(),
                    what: "the artboard's size".into(),
                    feature: Feature::Frame,
                    reason: format!(
                        "it isn't in pixels, so the artboard is {} × {}",
                        FALLBACK.0, FALLBACK.1
                    ),
                    preserved: Score::No,
                    visual: Score::No,
                    editable: Score::Yes,
                    quarantined: false,
                },
            ));
            FALLBACK
        }
    };
    // The artboard is fragment 0 of the parse; the content starts at 1.
    for mut dropped in parsed.dropped {
        dropped.anchor = dropped.anchor.and_then(|n| n.checked_sub(1));
        dropped.path = format!("{file}{}", dropped.path);
        let (mut anchor, diagnostic) = quarantine(dropped);
        anchor.board = i;
        diagnostics.push((anchor, diagnostic));
    }
    Ok(Board {
        page: entry.page.clone(),
        name: root.name.unwrap_or_else(|| format!("Artboard {}", i + 1)),
        width,
        height,
        position: entry.x.zip(entry.y),
        styles: root.styles,
        attrs: root.attrs,
        content: root.children,
        source: Some(file.clone()),
        paths: parsed
            .paths
            .into_iter()
            .skip(1)
            .map(|path| format!("{file}{path}"))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use finite_design::{Design, DesignMeta, edit, html::export, import::ImportRecord};

    use super::*;
    use crate::{Blobs, Placed, Receipt};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    struct Store(Vec<Vec<u8>>);

    impl Blobs for Store {
        fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
            Ok(self.0.iter().find(|b| BlobHash::of(b) == *hash).cloned())
        }
    }

    fn design(id: &str) -> Design {
        Design::new(DesignMeta {
            id: id.into(),
            name: "Home".into(),
            created_at: 0,
            updated_at: 0,
        })
    }

    fn import_html(design: &mut Design, html: &str, name: &str, page: Option<&str>) -> String {
        let imported = crate::html::Html
            .read(&Input {
                bytes: html.as_bytes(),
                file_name: Some(name),
            })
            .unwrap();
        let (_, placed) = place(design, imported, page);
        placed.artboards[0].clone()
    }

    fn place(
        design: &mut Design,
        imported: Imported,
        page: Option<&str>,
    ) -> (ImportRecord, Placed) {
        let receipt = Receipt {
            page: page.map(str::to_owned),
            id: "i".into(),
            design: design.meta.id.clone(),
            artifact: BlobHash::of(b"x"),
            file_name: None,
            received_at: 0,
        };
        let mut n = design.doc().len() * 10;
        let mut new_id = move || {
            n += 1;
            format!("n{n}")
        };
        let (_, placed) = design
            .import("agent", "Import", 1, |tx| {
                let (record, placed) = imported.place(tx, receipt, &mut new_id)?;
                Ok::<_, Error>((record.clone(), (record, placed)))
            })
            .unwrap();
        placed
    }

    fn write(source: &Design, scope: &Scope, blobs: &[&[u8]]) -> Exported {
        let store = Store(blobs.iter().map(|b| b.to_vec()).collect());
        Repo.write(
            &Revision {
                name: "Home",
                doc: source.doc(),
                imports: source.imports(),
                blobs: &store,
                measure: &crate::scene::NoMeasure,
            },
            scope,
        )
        .unwrap()
    }

    fn read(bytes: &[u8]) -> Result<Imported, Error> {
        Repo.read(&Input {
            bytes,
            file_name: Some("home.finite-repo.tar"),
        })
    }

    /// Two pages, three artboards (two with the same name), an image,
    /// a stylesheet and shared CSS.
    fn source() -> Design {
        let mut source = design("old");
        let ops = edit::create_page(source.doc(), "drafts".into(), "Drafts").unwrap();
        source.commit("agent", "Page", &ops, 1);
        let home = format!(
            "<!doctype html><body class=\"page\" style=\"background: #eee\"><style>.x {{ color: red }}</style><img src=\"{}\" data-name=\"Logo\"><p>Hi <b>there</b></p></body>",
            assets::url("old", &BlobHash::of(PNG))
        );
        import_html(&mut source, &home, "Home.html", None);
        import_html(&mut source, "<p>Draft</p>", "Home.html", Some("drafts"));
        import_html(&mut source, "<p>Other</p>", "Settings.html", None);
        let css = format!(
            ".page {{ background: url({}) }}",
            assets::url("old", &BlobHash::of(PNG))
        );
        source.commit("agent", "CSS", &edit::set_css(&css).unwrap(), 2);
        source
    }

    #[test]
    fn a_design_is_a_folder_of_text_files() {
        let source = source();
        let exported = write(&source, &Scope::Design, &[PNG]);
        assert_eq!(exported.file_name, "home.finite-repo.tar");
        assert_eq!(exported.media_type, "application/x-tar");
        let files = Files::of(tar::read(&exported.bytes).unwrap()).unwrap().0;
        let png = format!("assets/{}.png", BlobHash::of(PNG));
        assert_eq!(
            files.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "artboards/home-2.html",
                "artboards/home.html",
                "artboards/settings.html",
                png.as_str(),
                "finite.json",
                "shared.css"
            ]
        );
        // Files are text a person can read, with no server URLs in them.
        let home = String::from_utf8(files["artboards/home.html"].clone()).unwrap();
        assert!(
            home.contains("\n  <p>Hi <b>there</b></p>") || home.contains("<p>"),
            "{home}"
        );
        assert!(home.contains("data-name=\"Logo\""), "{home}");
        assert!(!home.contains("/api/designs"), "{home}");
        let manifest = String::from_utf8(files["finite.json"].clone()).unwrap();
        assert!(
            manifest.starts_with("{\n  \"v\": 1,\n  \"kind\": \"finite-repo\""),
            "{manifest}"
        );
        assert!(
            manifest.contains("\"pages\": [\n    \"Page 1\",\n    \"Drafts\"\n  ]"),
            "{manifest}"
        );
        assert!(
            !String::from_utf8(files["shared.css"].clone())
                .unwrap()
                .contains("/api/designs")
        );
        // The same design writes the same bytes, so an unchanged one leaves no diff.
        assert_eq!(exported.bytes, write(&source, &Scope::Design, &[PNG]).bytes);
        // The import record isn't carried, and the export says so.
        assert_eq!(exported.diagnostics[0].feature, Feature::ImportHistory);
    }

    #[test]
    fn the_folder_imports_back_the_same() {
        let source = source();
        let exported = write(&source, &Scope::Design, &[PNG]);
        let imported = read(&exported.bytes).unwrap();
        assert_eq!(imported.pages, ["Page 1", "Drafts"]);
        assert_eq!(imported.blobs, [PNG.to_vec()]);
        assert_eq!(imported.input_kind, "finite-repo v1");

        let mut target = design("new");
        let (record, placed) = place(&mut target, imported, None);
        assert_eq!(record.dependencies.len(), 1);
        assert_eq!(placed.artboards.len(), 3);
        assert!(placed.diagnostics.is_empty(), "{:?}", placed.diagnostics);

        let old = source.doc().artboards();
        let new = target.doc().artboards();
        assert_eq!(old.len(), new.len());
        for (old, new) in old.iter().zip(&new) {
            assert_eq!((old.x, old.y), (new.x, new.y));
            assert_eq!(old.name, new.name);
            assert_eq!(old.styles, new.styles);
            assert_eq!(old.attrs, new.attrs);
            assert_eq!(
                source
                    .doc()
                    .page(source.doc().page_of(old))
                    .map(|p| &p.name),
                target
                    .doc()
                    .page(target.doc().page_of(new))
                    .map(|p| &p.name)
            );
            assert_eq!(
                export(source.doc(), &old.id, false)
                    .unwrap()
                    .replace("/api/designs/old/", "/api/designs/new/"),
                export(target.doc(), &new.id, false).unwrap()
            );
        }
        assert_eq!(
            target.doc().css().map(str::to_owned),
            source
                .doc()
                .css()
                .map(|css| css.replace("/designs/old/", "/designs/new/"))
        );

        // And exporting that gives the folder it came from.
        let again = write(&target, &Scope::Design, &[PNG]);
        let strip = |tar: &[u8]| -> Vec<(String, String)> {
            tar::read(tar)
                .unwrap()
                .into_iter()
                .map(|e| (e.path, String::from_utf8_lossy(&e.bytes).into_owned()))
                .collect()
        };
        assert_eq!(strip(&again.bytes), strip(&exported.bytes));
    }

    /// The files are laid out on many lines, and still read back as the
    /// same document, including text mixed with elements.
    #[test]
    fn layout_reads_back_exactly() {
        let page = concat!(
            "<p>Hi <b>there</b> and <i>more</i>.</p>",
            "<div><span>x</span> <span>y</span><br><img src=\"a.png\" alt=\"a > b\"></div>",
            "<ul><li>one</li><li><a href=\"#\">two</a></li></ul>",
            "<pre>  keep\n    this <b>bold</b>\n</pre>",
            "<style>.a > .b { color: red }</style>",
            "<div></div>"
        );
        let mut source = design("old");
        import_html(&mut source, page, "A.html", None);
        let exported = write(&source, &Scope::Design, &[]);
        let files = Files::of(tar::read(&exported.bytes).unwrap()).unwrap().0;
        let file = String::from_utf8(files["artboards/a.html"].clone()).unwrap();
        assert!(file.lines().count() > 10, "{file}");
        assert!(
            file.contains("\n  <p>Hi <b>there</b> and <i>more</i>.</p>\n"),
            "{file}"
        );
        assert!(
            file.contains("<style>.a > .b { color: red }</style>"),
            "{file}"
        );
        assert!(file.contains("<div></div>"), "{file}");
        let mut target = design("new");
        place(&mut target, read(&exported.bytes).unwrap(), None);
        let compact = |d: &Design| {
            let id = d.doc().artboards()[0].id.clone();
            html::export_with(
                d.doc(),
                &id,
                &ExportOptions {
                    indent: false,
                    ..ExportOptions::default()
                },
            )
            .unwrap()
            .html
        };
        assert_eq!(compact(&source), compact(&target));
        assert!(compact(&target).contains("</span> <span>"));
    }

    #[test]
    fn one_artboard_exports_without_pages() {
        let source = source();
        let board = source.doc().artboards()[0].id.clone();
        let exported = write(&source, &Scope::Artboard(board), &[PNG]);
        assert_eq!(exported.file_name, "home.finite-repo.tar");
        let imported = read(&exported.bytes).unwrap();
        assert!(imported.pages.is_empty());
        assert_eq!(imported.boards.len(), 1);
        assert_eq!(imported.boards[0].page, None);
        assert!(exported.diagnostics.is_empty());
    }

    #[test]
    fn a_folder_inside_a_folder_and_editor_litter_are_fine() {
        let source = source();
        let exported = write(&source, &Scope::Design, &[PNG]);
        let mut entries = tar::read(&exported.bytes).unwrap();
        for entry in &mut entries {
            entry.path = format!("./my-design/{}", entry.path);
        }
        entries.push(tar::Entry {
            path: "./my-design/artboards/._home.html".into(),
            bytes: b"\0\x05binary".to_vec(),
        });
        entries.push(tar::Entry {
            path: "./my-design/README.md".into(),
            bytes: b"notes".to_vec(),
        });
        let repacked = tar::write(&entries).unwrap();
        assert_eq!(read(&repacked).unwrap().boards.len(), 3);
    }

    #[test]
    fn edits_to_the_files_come_through() {
        let source = source();
        let exported = write(&source, &Scope::Design, &[PNG]);
        let mut entries = tar::read(&exported.bytes).unwrap();
        for entry in &mut entries {
            if entry.path == "artboards/settings.html" {
                let html = String::from_utf8(entry.bytes.clone()).unwrap();
                entry.bytes = html.replace("Other", "Changed in git").into_bytes();
            }
            if entry.path == MANIFEST {
                let json = String::from_utf8(entry.bytes.clone()).unwrap();
                entry.bytes = json.replace("\"Drafts\"", "\"Archive\"").into_bytes();
            }
        }
        let imported = read(&tar::write(&entries).unwrap()).unwrap();
        assert_eq!(imported.pages[1], "Archive");
        let settings = imported
            .boards
            .iter()
            .find(|b| b.name == "Settings")
            .unwrap();
        assert_eq!(settings.content[0].inner_text(), "Changed in git");
    }

    #[test]
    fn a_hostile_folder_is_quarantined() {
        let manifest = r#"{"v":1,"kind":"finite-repo","name":"Evil","artboards":[{"file":"artboards/a.html"}]}"#;
        let artboard = r#"<div data-name="Board" onclick="a()" style="width: 100px; height: 100px"><button onmouseover="b()">Go</button><script>d()</script><iframe src="https://x"></iframe></div>"#;
        let tar = tar::write(&[
            tar::Entry {
                path: MANIFEST.into(),
                bytes: manifest.into(),
            },
            tar::Entry {
                path: "artboards/a.html".into(),
                bytes: artboard.into(),
            },
        ])
        .unwrap();
        let imported = read(&tar).unwrap();
        let mut target = design("t");
        let (record, placed) = place(&mut target, imported, None);
        let doc = target.doc();
        // The artboard, the button and its text; no handlers.
        assert_eq!(doc.len(), 3);
        assert!(doc.nodes().all(|n| n.attrs.is_empty()));
        let mut what: Vec<_> = record.quarantined.iter().map(|q| q.what.as_str()).collect();
        what.sort();
        assert_eq!(what, ["<iframe>", "<script>", "onclick", "onmouseover"]);
        assert_eq!(placed.diagnostics.len(), 4);
        let onclick = record
            .quarantined
            .iter()
            .find(|q| q.what == "onclick")
            .unwrap();
        assert_eq!(onclick.node.as_deref(), Some(placed.artboards[0].as_str()));
        assert!(
            onclick.path.starts_with("artboards/a.html"),
            "{}",
            onclick.path
        );
    }

    #[test]
    fn the_folder_must_hang_together() {
        let manifest = |extra: &str| {
            format!(
                r#"{{"v":1,"kind":"finite-repo","name":"x"{extra},"artboards":[{{"file":"artboards/a.html"}}]}}"#
            )
        };
        let hash = BlobHash::of(PNG);
        let board =
            format!(r#"<div style="width:1px;height:1px"><img src="finite-asset:{hash}"></div>"#);
        let pack = |manifest: String, board: &str, assets: &[(String, &[u8])]| {
            let mut entries = vec![
                tar::Entry {
                    path: MANIFEST.into(),
                    bytes: manifest.into_bytes(),
                },
                tar::Entry {
                    path: "artboards/a.html".into(),
                    bytes: board.as_bytes().to_vec(),
                },
            ];
            entries.extend(assets.iter().map(|(path, bytes)| tar::Entry {
                path: path.clone(),
                bytes: bytes.to_vec(),
            }));
            tar::write(&entries).unwrap()
        };
        let error = read(&pack(manifest(""), &board, &[])).unwrap_err();
        assert!(error.0.contains("doesn't contain"), "{error}");
        let wrong = [(format!("assets/{hash}.png"), &b"other"[..])];
        let error = read(&pack(manifest(""), &board, &wrong)).unwrap_err();
        assert!(error.0.contains("doesn't match its hash"), "{error}");
        let right = [(format!("assets/{hash}.png"), PNG)];
        assert!(read(&pack(manifest(""), &board, &right)).is_ok());

        let error = read(&pack(manifest(r#","css":"shared.css""#), &board, &right)).unwrap_err();
        assert!(error.0.contains("shared.css"), "{error}");
        let two = r#"<div></div><div></div>"#;
        let error = read(&pack(manifest(""), two, &right)).unwrap_err();
        assert!(error.0.contains("one element"), "{error}");
    }

    #[test]
    fn other_files_and_newer_folders_are_refused() {
        let pack = |json: &str| {
            tar::write(&[tar::Entry {
                path: MANIFEST.into(),
                bytes: json.into(),
            }])
            .unwrap()
        };
        assert!(read(b"").unwrap_err().0.contains("no finite.json"));
        assert!(read(&pack("{}")).is_err());
        assert!(
            read(&pack(
                r#"{"kind":"finite-bundle","name":"x","artboards":[]}"#
            ))
            .is_err()
        );
        let error = read(&pack(
            r#"{"v":2,"kind":"finite-repo","name":"x","artboards":[]}"#,
        ))
        .unwrap_err();
        assert!(error.0.contains("version 2"), "{error}");
    }
}
