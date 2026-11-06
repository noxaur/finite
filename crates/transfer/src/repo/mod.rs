//! A design as a folder of text files, for keeping next to the code.
//!
//! The folder holds one HTML file per artboard, so a pull request shows
//! what changed in each screen, plus a manifest:
//!
//! ```text
//! finite.json          name, pages, tokens, and each artboard's file, page, mode and position
//! artboards/home.html  one artboard: its <div> and everything inside
//! assets/<sha256>.png  the files the design points to
//! ```
//!
//! Export writes the folder as one tar archive, since a codec produces one
//! file. Unpack it with `tar -xf`. To import a folder back, pack it with
//! `tar -cf design.tar finite.json artboards assets`; a single
//! top-level folder around those is fine too. Files are written the same
//! way every time, so an unchanged design leaves no diff.
//!
//! Layer names, styles, attributes and text come back as they were, along
//! with the tokens and each artboard's size, position, page and mode. A
//! folder from before tokens can hold a `shared.css`, which importing moves
//! into tokens. Node ids, history,
//! comments and import records do not, as with a `.finite` bundle.
//! Reading applies the same rules as an HTML import: scripts and other
//! code that could run are quarantined.

use std::collections::BTreeMap;

use finite_design::{
    NodeKind,
    html::{self, ExportOptions, Fragment, Policy},
    import::BlobHash,
    version::Schema,
};
use serde::{Deserialize, Serialize};

use crate::{
    Anchor, Board, Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input,
    Revision, Scope, Score, Support, Tokens, assets, feature, file_stem, html::quarantine,
    json_file::JsonFile, slug, tar,
};

/// The manifest's format and version. See `finite_design::version`.
pub const REPO: Schema = Schema {
    name: "Finite folder",
    version: 1,
    upgrades: &[],
};

const KIND: &str = "finite-repo";
const MANIFEST: &str = "finite.json";

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
    /// The path of the shared CSS, in a folder from before tokens.
    #[serde(default, skip_serializing)]
    css: Option<String>,
    /// The design's modes, by name, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    modes: Vec<String>,
    /// The design's tokens, each with its values by mode name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    tokens: BTreeMap<String, BTreeMap<String, String>>,
    /// Every artboard, in canvas order.
    artboards: Vec<Artboard>,
}

impl JsonFile for Manifest {
    const SCHEMA: &'static Schema = &REPO;
    const NAME: &'static str = "a Finite folder";
    const KIND: &'static str = KIND;
    const EXTRA_DEPTH: usize = 8;

    fn kind(&self) -> &str {
        &self.kind
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Artboard {
    file: String,
    /// The name of the page it's on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<String>,
    /// The name of the mode it renders in, unless it's the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
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
        feature::finite_markup(feature, direction)
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        let files = Files::of(tar::read(input.bytes)?)?;
        let manifest_json = files.text(MANIFEST)?.ok_or_else(|| {
            Error(format!(
                "this isn't a Finite folder: it has no {MANIFEST} at its top"
            ))
        })?;
        let manifest = Manifest::parse(manifest_json)?;
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
        let tokens = Tokens {
            modes: manifest.modes,
            values: manifest.tokens,
        };
        let texts: Vec<&str> = css.as_deref().into_iter().chain(tokens.texts()).collect();
        let blobs = files.blobs(&mut boards, &texts)?;
        let (blobs, dependencies) = assets::carried(blobs);
        Ok(Imported {
            format: self.name(),
            input_kind: format!("{KIND} v{}", REPO.version),
            pages: manifest.pages,
            boards,
            tokens,
            css,
            blobs,
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
        // Pages can share a name in a design, but the manifest refers to
        // them by name, so a repeat is written under a new one.
        let mut diagnostics = Vec::new();
        let mut labels: BTreeMap<&str, String> = BTreeMap::new();
        let mut used: Vec<String> = Vec::new();
        for (id, page) in doc.pages() {
            let mut label = page.name.clone();
            let mut n = 1;
            while used.contains(&label) {
                n += 1;
                label = format!("{} ({n})", page.name);
            }
            if label != page.name {
                diagnostics.push(
                    Diagnostic::new(
                        Feature::Frame,
                        format!("the page {:?}", page.name),
                        format!(
                            "another page has the same name, so this one is written as {label:?}"
                        ),
                        [Score::No, Score::Yes, Score::Yes],
                    )
                    .at(MANIFEST),
                );
            }
            used.push(label.clone());
            labels.insert(id, label);
        }
        let boards = revision.artboards(scope)?;
        let names = file_names(&boards);
        let mut files = Vec::new();
        let mut artboards = Vec::new();
        for (board, file) in boards.into_iter().zip(names) {
            let export = html::export_with(doc, &board.id, &options)
                .ok_or_else(|| Error(format!("{:?} isn't an artboard", board.id)))?;
            files.push(tar::Entry {
                path: file.clone(),
                bytes: lay_out(&portable(&export.html)).into_bytes(),
            });
            let page = match scope {
                Scope::Design => labels.get(doc.page_of(board)).cloned(),
                Scope::Artboard(_) => None,
            };
            artboards.push(Artboard {
                file,
                page,
                mode: Tokens::mode_of(doc, board),
                x: board.x,
                y: board.y,
            });
        }
        let pages = match scope {
            Scope::Design => doc
                .pages()
                .into_iter()
                .map(|(id, _)| labels[id].clone())
                .collect(),
            Scope::Artboard(_) => Vec::new(),
        };
        let tokens = Tokens::of(doc, &mut portable);
        let manifest = Manifest {
            v: REPO.version,
            kind: KIND.into(),
            name: revision.name.to_owned(),
            pages,
            css: None,
            modes: tokens.modes,
            tokens: tokens.values,
            artboards,
        };
        let mut json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| Error(format!("couldn't write the manifest: {e}")))?;
        json.push('\n');
        let mut entries = vec![tar::Entry {
            path: MANIFEST.into(),
            bytes: json.into_bytes(),
        }];
        entries.extend(files);

        hashes.sort();
        hashes.dedup();
        for hash in hashes {
            match revision.blobs.get(&hash)? {
                Some(bytes) => entries.push(tar::Entry {
                    path: format!("assets/{hash}{}", assets::extension(&bytes)),
                    bytes,
                }),
                None => diagnostics.push(Diagnostic::missing_file(
                    format!("{}{hash}", assets::SCHEME),
                    "a file",
                )),
            }
        }
        if *scope == Scope::Design && !revision.imports.is_empty() {
            diagnostics.push(Diagnostic::new(
                Feature::ImportHistory,
                format!("{} import record(s)", revision.imports.len()),
                "a folder doesn't carry the files the design was imported from",
                [Score::No, Score::Yes, Score::Yes],
            ));
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

/// The first six characters of the sha256 of `text`: short, and the same
/// every time for the same text.
fn short(text: &str) -> String {
    BlobHash::of(text.as_bytes()).to_string()[..6].to_owned()
}

/// Names Windows won't let a file have, whatever its extension.
fn is_reserved(stem: &str) -> bool {
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|p| {
            stem.strip_prefix(p)
                .is_some_and(|n| matches!(n.as_bytes(), [b'1'..=b'9']))
        })
}

/// A file name stem for an artboard called `name`: ASCII letters, digits
/// and dashes. A name with other characters, or none, gets a hash of the
/// name added, so two names that reduce to the same letters stay apart and
/// the stem changes only when the name does.
fn stem(name: &str) -> String {
    // Cutting to length can leave a dash at the end, so trim after.
    let mut slug: String = slug(name).chars().take(STEM).collect();
    slug.truncate(slug.trim_end_matches('-').len());
    let hashed = slug.is_empty() || !name.is_ascii();
    if slug.is_empty() {
        slug = "artboard".into();
    } else if is_reserved(&slug) {
        slug.push_str("-artboard");
    }
    if hashed {
        slug = format!("{slug}-{}", short(name));
    }
    slug
}

/// `artboards/<name>.html` for each of `boards`. A name used by several
/// artboards gets each one's id hashed on, so deleting one leaves the
/// others' files where they were; a unique name stays plain.
fn file_names(boards: &[&finite_design::Node]) -> Vec<String> {
    let stems: Vec<String> = boards.iter().map(|b| stem(&b.display_name())).collect();
    let mut taken: Vec<String> = Vec::new();
    boards
        .iter()
        .zip(&stems)
        .map(|(board, stem)| {
            let shared = stems.iter().filter(|other| *other == stem).count() > 1;
            let base = if shared {
                format!("{stem}-{}", short(&board.id))
            } else {
                stem.clone()
            };
            let mut file = format!("artboards/{base}.html");
            let mut n = 1;
            while taken.contains(&file) {
                n += 1;
                file = format!("artboards/{base}-{n}.html");
            }
            taken.push(file.clone());
            file
        })
        .collect()
}

/// Tags whose content is written as it is, never laid out: the raw text
/// elements, and the ones whose whitespace shows.
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
    // Whether each open element has had text directly in it.
    let mut texted: Vec<bool> = Vec::new();
    while i < compact.len() {
        let Some(open) = compact[i..].find('<').map(|n| n + i) else {
            out.push_str(&compact[i..]);
            break;
        };
        if open > i {
            out.push_str(&compact[i..open]);
            (after_tag, after_open) = (false, false);
            if let Some(last) = texted.last_mut() {
                *last = true;
            }
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
        let void = tag.ends_with("/>") || html::is_void(&name);
        let mut had_text = false;
        if closing {
            depth = depth.saturating_sub(1);
            had_text = texted.pop().unwrap_or(false);
        }
        // A closing tag stays on the line of an element that holds text.
        if after_tag && !(closing && (after_open || had_text)) {
            out.push('\n');
            out.push_str(&"  ".repeat(depth));
        }
        out.push_str(tag);
        i = end;
        after_tag = true;
        after_open = !closing && !void;
        if after_open {
            depth += 1;
            texted.push(false);
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
        texts: &[&str],
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
        referenced.extend(texts.iter().flat_map(|text| assets::referenced(text)));
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
    let root = std::mem::replace(root, Fragment::empty(NodeKind::Text));
    let mut board = Board::default();
    let size = board.size_from(&root.styles, file);
    diagnostics.extend(size.map(|diagnostic| {
        let anchor = Anchor {
            board: i,
            node: None,
        };
        (anchor, diagnostic)
    }));
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
        mode: entry.mode.clone(),
        name: root.name.unwrap_or_else(|| Board::unnamed(i)),
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
        ..board
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
    /// a stylesheet and a token that points at the image.
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
        let hero = format!("url({})", assets::url("old", &BlobHash::of(PNG)));
        let changes = [("--hero".to_owned(), edit::TokenChange::All(hero))];
        let ops = edit::set_tokens(source.doc(), &edit::mode_list(source.doc()), &changes).unwrap();
        source.commit("agent", "Tokens", &ops, 2);
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
        // Two artboards are named Home, so each file name carries a hash of its id.
        let names: Vec<&str> = files.keys().map(String::as_str).collect();
        let homes: Vec<&&str> = names
            .iter()
            .filter(|n| n.starts_with("artboards/home-"))
            .collect();
        assert_eq!(homes.len(), 2, "{names:?}");
        for expected in ["artboards/settings.html", "finite.json", png.as_str()] {
            assert!(names.contains(&expected), "{expected} in {names:?}");
        }
        assert_eq!(names.len(), 5, "{names:?}");
        // Files are text a person can read, with no server URLs in them.
        let home = files
            .iter()
            .find(|(path, bytes)| {
                path.starts_with("artboards/home-")
                    && String::from_utf8_lossy(bytes).contains("Logo")
            })
            .map(|(_, bytes)| String::from_utf8(bytes.clone()).unwrap())
            .unwrap();
        assert!(home.contains("\n  <p>Hi <b>there</b></p>\n"), "{home}");
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
            manifest.contains("\"--hero\": {\n      \"Default\": \"url(finite-asset:"),
            "{manifest}"
        );
        assert!(!manifest.contains("/api/designs"), "{manifest}");
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
            crate::Tokens::of(target.doc(), str::to_owned),
            crate::Tokens::of(source.doc(), |v| v
                .replace("/designs/old/", "/designs/new/"))
        );

        // And exporting that gives the folder it came from. Artboards that
        // share a name are told apart by node id, and the copy has new ids, so
        // compare the files by content.
        let again = write(&target, &Scope::Design, &[PNG]);
        let contents = |tar: &[u8]| -> Vec<String> {
            let mut files: Vec<String> = tar::read(tar)
                .unwrap()
                .into_iter()
                .filter(|e| e.path != MANIFEST)
                .map(|e| String::from_utf8_lossy(&e.bytes).into_owned())
                .collect();
            files.sort();
            files
        };
        assert_eq!(contents(&again.bytes), contents(&exported.bytes));
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

    /// Adds an empty artboard called `name` to `design`, on `page`.
    fn add_board(
        design: &mut Design,
        id: &str,
        name: &str,
        width: f64,
        height: Option<f64>,
        page: Option<&str>,
    ) {
        let ops = edit::create_artboard(
            design.doc(),
            id.into(),
            edit::NewArtboard {
                name: name.into(),
                width,
                height,
                position: None,
                page: page.map(str::to_owned),
                styles: BTreeMap::new(),
                ..Default::default()
            },
        )
        .unwrap();
        design.commit("agent", "Board", &ops, 1);
    }

    fn files_of(exported: &Exported) -> BTreeMap<String, Vec<u8>> {
        Files::of(tar::read(&exported.bytes).unwrap()).unwrap().0
    }

    #[test]
    fn an_auto_height_artboard_keeps_its_width_and_its_auto_height() {
        let mut source = design("old");
        add_board(&mut source, "phone", "Phone", 390.0, None, None);
        add_board(&mut source, "fixed", "Fixed", 800.0, Some(300.0), None);
        let exported = write(&source, &Scope::Design, &[]);
        let imported = read(&exported.bytes).unwrap();
        let mut target = design("new");
        let (_, placed) = place(&mut target, imported, None);
        assert!(placed.diagnostics.is_empty(), "{:?}", placed.diagnostics);
        let styles = |name: &str| {
            let doc = target.doc();
            let board = doc
                .artboards()
                .into_iter()
                .find(|b| b.name.as_deref() == Some(name));
            let styles = &board.unwrap().styles;
            (styles["width"].clone(), styles["height"].clone())
        };
        assert_eq!(styles("Phone"), ("390px".into(), "auto".into()));
        assert_eq!(styles("Fixed"), ("800px".into(), "300px".into()));
    }

    #[test]
    fn scripts_are_written_but_not_read_back() {
        let mut source = design("old");
        add_board(&mut source, "b", "Live", 400.0, Some(300.0), None);
        let fragments = html::parse("<p>Hi</p><script>run()</script>").unwrap();
        let mut n = 0;
        let (ops, _) = edit::create_artboard_with(
            source.doc(),
            "c".into(),
            edit::NewArtboard {
                name: "Scripted".into(),
                width: 400.0,
                height: Some(300.0),
                position: None,
                page: None,
                styles: BTreeMap::new(),
                ..Default::default()
            },
            fragments,
            &mut || {
                n += 1;
                format!("s{n}")
            },
        )
        .unwrap();
        source.commit("agent", "Script", &ops, 2);
        let exported = write(&source, &Scope::Design, &[]);
        let files = files_of(&exported);
        let file = String::from_utf8(files["artboards/scripted.html"].clone()).unwrap();
        assert!(file.contains("<script>run()</script>"), "{file}");

        let mut target = design("new");
        let (record, placed) = place(&mut target, read(&exported.bytes).unwrap(), None);
        assert!(target.doc().nodes().all(|n| n.tag() != Some("script")));
        let quarantined: Vec<_> = record.quarantined.iter().map(|q| q.what.as_str()).collect();
        assert_eq!(quarantined, ["<script>"]);
        assert!(
            placed
                .diagnostics
                .iter()
                .any(|d| d.feature == Feature::Script)
        );
    }

    #[test]
    fn file_names_are_portable_and_stable() {
        let mut source = design("old");
        let names = [
            ("a", "Café"),
            ("b", "日本語"),
            ("c", "日本語 2"),
            ("d", "!!!"),
            ("e", "con"),
            ("f", "NUL"),
            ("g", "Com1"),
            ("h", "Settings"),
            ("i", "Home"),
            ("j", "Home"),
            ("k", &"Long name ".repeat(30)),
            ("l", &format!("{} tail", "a".repeat(STEM - 1))),
        ];
        for (id, name) in names {
            add_board(&mut source, id, name, 100.0, Some(100.0), None);
        }
        let files = |d: &Design| -> Vec<String> {
            files_of(&write(d, &Scope::Design, &[]))
                .into_keys()
                .filter(|p| p.starts_with("artboards/"))
                .collect()
        };
        let before = files(&source);
        assert_eq!(before.len(), names.len());
        assert!(before.iter().all(|p| !p.ends_with("-.html")), "{before:?}");
        for path in &before {
            assert!(path.is_ascii() && path.len() <= 80, "{path}");
            let stem = path
                .trim_start_matches("artboards/")
                .trim_end_matches(".html");
            assert!(!is_reserved(stem), "{path}");
        }
        assert!(
            before.contains(&"artboards/con-artboard.html".to_owned()),
            "{before:?}"
        );
        assert!(
            before.contains(&"artboards/nul-artboard.html".to_owned()),
            "{before:?}"
        );
        assert!(
            before.contains(&"artboards/com1-artboard.html".to_owned()),
            "{before:?}"
        );
        assert!(
            before.contains(&"artboards/settings.html".to_owned()),
            "{before:?}"
        );
        assert!(
            before.iter().any(|p| p.starts_with("artboards/caf-")),
            "{before:?}"
        );
        assert!(
            before.iter().any(|p| p.starts_with("artboards/artboard-")),
            "{before:?}"
        );

        // Deleting one of the two Homes leaves every other file where it was.
        // The other Home was told apart from it by id, and now has the name to itself.
        let ops = edit::delete(source.doc(), &["i".to_owned()]).unwrap();
        source.commit("agent", "Delete", &ops, 3);
        let after = files(&source);
        assert_eq!(after.len(), before.len() - 1);
        for path in &after {
            let survivor = path == "artboards/home.html";
            assert!(
                survivor || before.contains(path),
                "{path} is new after a delete"
            );
        }
        assert!(
            after.contains(&"artboards/home.html".to_owned()),
            "{after:?}"
        );
    }

    #[test]
    fn pages_that_share_a_name_stay_apart() {
        let mut source = design("old");
        for id in ["p1", "p2"] {
            let ops = edit::create_page(source.doc(), id.into(), "Drafts").unwrap();
            source.commit("agent", "Page", &ops, 1);
        }
        add_board(&mut source, "a", "One", 100.0, Some(100.0), Some("p1"));
        add_board(&mut source, "b", "Two", 100.0, Some(100.0), Some("p2"));
        let exported = write(&source, &Scope::Design, &[]);
        let note = &exported.diagnostics[0];
        assert!(
            note.what.contains("Drafts") && note.reason.contains("Drafts (2)"),
            "{note:?}"
        );
        let imported = read(&exported.bytes).unwrap();
        assert_eq!(imported.pages, ["Page 1", "Drafts", "Drafts (2)"]);

        let mut target = design("new");
        place(&mut target, imported, None);
        let doc = target.doc();
        let on = |name: &str| {
            let id = doc
                .pages()
                .into_iter()
                .find(|(_, p)| p.name == name)
                .unwrap()
                .0;
            doc.artboards_on(id)
                .iter()
                .filter_map(|b| b.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(on("Drafts"), ["One"]);
        assert_eq!(on("Drafts (2)"), ["Two"]);
    }

    fn tar_available() -> bool {
        std::process::Command::new("tar")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "finite-repo-{tag}-{}-{}",
            std::process::id(),
            short(&format!("{:?}", std::time::Instant::now()))
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The system's `tar` unpacks what we write, and what it packs from that
    /// folder, with directory entries and its own header style, reads back.
    #[test]
    fn the_system_tar_reads_and_writes_the_same_archives() {
        if !tar_available() {
            return;
        }
        let source = source();
        let exported = write(&source, &Scope::Design, &[PNG]);
        let dir = scratch("tar");
        let archive = dir.join("in.tar");
        std::fs::write(&archive, &exported.bytes).unwrap();
        let folder = dir.join("design");
        std::fs::create_dir_all(&folder).unwrap();
        let run = |args: &[&std::ffi::OsStr]| {
            let out = std::process::Command::new("tar")
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&[
            "-xf".as_ref(),
            archive.as_os_str(),
            "-C".as_ref(),
            folder.as_os_str(),
        ]);
        assert!(folder.join("finite.json").is_file());
        let listed = std::fs::read_dir(folder.join("artboards")).unwrap().count();
        assert_eq!(listed, 3);

        // Packed as a person would: the folder itself, and its contents with "./".
        for (name, root) in [
            ("whole.tar", dir.join("design")),
            ("dot.tar", dir.join("design")),
        ] {
            let packed = dir.join(name);
            let mut args: Vec<&std::ffi::OsStr> = vec!["-cf".as_ref(), packed.as_os_str()];
            let dot = name == "dot.tar";
            args.extend([
                "-C".as_ref(),
                if dot {
                    root.as_os_str()
                } else {
                    dir.as_os_str()
                },
            ]);
            args.push(if dot { ".".as_ref() } else { "design".as_ref() });
            run(&args);
            let imported = read(&std::fs::read(&packed).unwrap()).unwrap();
            assert_eq!(imported.boards.len(), 3, "{name}");
            assert_eq!(imported.blobs, [PNG.to_vec()], "{name}");
            assert_eq!(imported.pages, ["Page 1", "Drafts"], "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn long_names_from_a_pax_archive_are_refused_clearly() {
        if !tar_available() {
            return;
        }
        let dir = scratch("pax");
        let long = dir.join("src").join("a".repeat(120));
        std::fs::create_dir_all(long.parent().unwrap()).unwrap();
        std::fs::write(&long, "x").unwrap();
        std::fs::write(dir.join("src").join("finite.json"), "{}").unwrap();
        let packed = dir.join("long.tar");
        let status = std::process::Command::new("tar")
            .args(["--format=pax", "-cf"])
            .arg(&packed)
            .arg("-C")
            .arg(dir.join("src"))
            .arg("finite.json")
            .arg("a".repeat(120))
            .status()
            .unwrap();
        if status.success() {
            let error = read(&std::fs::read(&packed).unwrap()).unwrap_err();
            assert!(error.0.contains("long file names"), "{error}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
