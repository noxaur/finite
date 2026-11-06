//! Moves designs in and out of Finite.
//!
//! Each format is a [`Codec`] that converts between that format and Finite's
//! own [`Document`], so the document is the hub and no codec knows about
//! another. Importing happens in two steps:
//!
//! 1. [`Codec::read`] parses the bytes into an [`Imported`], with no design
//!    and no lock: just artboards to create and what couldn't be kept.
//! 2. [`Imported::place`] creates them inside [`Design::import`], which
//!    applies everything or nothing.
//!
//! Nothing is ever thrown away. The caller stores the bytes it received,
//! and the design's [`ImportRecord`] points at them, so the original can
//! always be downloaded again. Content that could run code is quarantined:
//! it never enters the document, only the record of where it was.
//!
//! To add a format, add a [`Format`] variant and a module with its codec.
//! To add something a design can contain, add a [`Feature`]. Either way the
//! compiler lists every place that needs an answer.
//!
//! This crate has no I/O, like `finite-design`.
//!
//! [`Design::import`]: finite_design::Design::import

pub mod app;
pub mod assets;
mod css_scope;
mod feature;
pub mod figma;
pub mod finite;
mod html;
mod json_file;
pub mod jsx;
mod repo;
mod report;
pub mod scene;
pub mod tar;

use std::collections::BTreeMap;

use finite_design::{
    Document, Node, NodeId, Op, Rejected, Transaction, components,
    edit::{self, EditError, NewArtboard, TokenChange, WriteMode},
    html::{DEFAULT_ARTBOARD_SIZE, Fragment},
    import::{BlobHash, Dependency, ImportRecord, Quarantined},
    tokens,
};

pub use feature::{Direction, Feature, Support};
pub use report::{Axis, Diagnostic, Refused, Score, violations};

/// A format Finite reads or writes. This enum is the registry: each
/// variant names its codec in [`Format::codec`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Html,
    /// A `.finite` bundle.
    Finite,
    /// A `.figma.json` file from or for the Finite Figma plugin.
    Figma,
    /// A React component. Export only.
    Jsx,
    /// A design as a folder of text files, packed as a tar archive.
    Repo,
    /// A prototype as a Vite + React project, packed as a tar archive.
    /// Export only.
    App,
}

impl Format {
    pub const ALL: [Format; 6] = [
        Format::Html,
        Format::Finite,
        Format::Figma,
        Format::Jsx,
        Format::Repo,
        Format::App,
    ];

    pub fn codec(self) -> &'static dyn Codec {
        match self {
            Format::Html => &html::Html,
            Format::Finite => &finite::Finite,
            Format::Figma => &figma::Figma,
            Format::Jsx => &jsx::Jsx,
            Format::Repo => &repo::Repo,
            Format::App => &app::App,
        }
    }

    /// The format named `name`, as in an `?format=` query.
    pub fn named(name: &str) -> Option<Format> {
        Self::ALL.into_iter().find(|f| f.codec().name() == name)
    }
}

/// Converts between one format and Finite's document.
pub trait Codec: Sync {
    /// Short and lowercase, like `html`. Stored in each [`ImportRecord`].
    fn name(&self) -> &'static str;

    /// What this codec does with `feature` going `direction`. Write it as a
    /// `match` with no wildcard arm, so a new feature needs an answer.
    fn support(&self, feature: Feature, direction: Direction) -> Support;

    /// Parses the bytes of an import.
    fn read(&self, input: &Input<'_>) -> Result<Imported, Error>;

    /// Writes `scope` of `revision` in this format.
    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error>;
}

/// What an export covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The whole design.
    Design,
    /// One artboard, by id.
    Artboard(NodeId),
}

/// The bytes of an import, as received.
pub struct Input<'a> {
    pub bytes: &'a [u8],
    pub file_name: Option<&'a str>,
}

/// A design at one moment, for an export to read. The caller copies it
/// under the design's lock, so everything in it agrees, and the export runs
/// without the lock.
pub struct Revision<'a> {
    pub name: &'a str,
    pub doc: &'a Document,
    pub imports: &'a [ImportRecord],
    /// Where to read the files the design's nodes point to.
    pub blobs: &'a dyn Blobs,
    /// Measures how artboards render, for formats without CSS.
    pub measure: &'a dyn scene::Measure,
}

/// How many components deep [`collect_instances`] looks. A component that
/// (through others) shows itself would never end, and each level can hold
/// several instances, so the cap is far below the document's `MAX_DEPTH`.
const NESTED_COMPONENTS: usize = 8;

/// `instance` and the instances inside the component it shows, and so on.
fn collect_instances<'a>(
    doc: &'a Document,
    instance: &'a Node,
    out: &mut Vec<&'a Node>,
    depth: usize,
) {
    out.push(instance);
    let Some(component) = instance.instance_of.as_deref().and_then(|c| doc.get(c)) else {
        return;
    };
    if depth >= NESTED_COMPONENTS {
        return;
    }
    for inner in doc
        .subtree(&component.id)
        .into_iter()
        .filter(|n| n.is_instance())
    {
        collect_instances(doc, inner, out, depth + 1);
    }
}

/// Writes `scope` of `revision` as `format`, with the default router.
pub fn export(format: Format, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
    export_with(format, revision, scope, None)
}

/// Writes `scope` of `revision` as `format`, routing an app export with
/// `router`. A router belongs to the app format, so asking any other format
/// for one is refused. Instances of components are written expanded, as the
/// elements they show: the file has no component for `data-instance-of` or a
/// bundle to point at, so a codec reading the raw document would write an
/// instance with no content. The export says so in a [`Feature::Instance`]
/// diagnostic.
pub fn export_with(
    format: Format,
    revision: &Revision<'_>,
    scope: &Scope,
    router: Option<app::RouterKind>,
) -> Result<Exported, Error> {
    if router.is_some() && format != Format::App {
        return Err(Error(format!(
            "\"router\" only applies to the app format; {} has no router",
            format.codec().name()
        )));
    }
    let doc = revision.doc;
    if !doc.has_instances() {
        return write(format, revision, scope, router);
    }
    let mut instances = Vec::new();
    for board in revision.artboards(scope)? {
        for node in doc
            .subtree(&board.id)
            .into_iter()
            .filter(|n| n.is_instance())
        {
            collect_instances(doc, node, &mut instances, 0);
        }
    }
    let view = components::expand(doc);
    let expanded = Revision {
        name: revision.name,
        doc: &view,
        imports: revision.imports,
        blobs: revision.blobs,
        measure: revision.measure,
    };
    let mut exported = write(format, &expanded, scope, router)?;
    if !instances.is_empty() {
        let mut names: Vec<String> = instances
            .iter()
            .filter_map(|i| i.instance_of.as_deref().and_then(|c| doc.get(c)))
            .map(|c| format!("{:?}", c.display_name()))
            .collect();
        names.sort();
        names.dedup();
        let first = &instances[0].id;
        exported.diagnostics.push(
            Diagnostic::new(
                Feature::Instance,
                format!(
                    "{} instance(s) of {}",
                    instances.len(),
                    if names.is_empty() {
                        "missing components".to_owned()
                    } else {
                        names.join(", ")
                    }
                ),
                "no format has components, so each instance is written as the elements it shows and no longer follows its component",
                [Score::No, Score::Yes, Score::Yes],
            )
            .at(format!("#{first}"))
            .on(first),
        );
    }
    Ok(exported)
}

/// Runs the codec for `format`, or the app with `router` when it has one.
fn write(
    format: Format,
    revision: &Revision<'_>,
    scope: &Scope,
    router: Option<app::RouterKind>,
) -> Result<Exported, Error> {
    match format {
        Format::App => app::write_with(revision, scope, router.unwrap_or_default().router()),
        _ => format.codec().write(revision, scope),
    }
}

/// Reads blobs for an export. The server's store implements it.
pub trait Blobs: Sync {
    fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error>;
}

/// No blobs at all, for designs that point at none.
pub struct NoBlobs;

impl Blobs for NoBlobs {
    fn get(&self, _hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
        Ok(None)
    }
}

impl Revision<'_> {
    /// The artboards `scope` covers, in canvas order.
    pub fn artboards(&self, scope: &Scope) -> Result<Vec<&finite_design::Node>, Error> {
        match scope {
            Scope::Design => Ok(self.doc.artboards()),
            Scope::Artboard(id) => self
                .doc
                .get(id)
                .filter(|n| n.is_artboard())
                .map(|board| vec![board])
                .ok_or_else(|| Error(format!("{id:?} isn't an artboard"))),
        }
    }
}

/// An export: one file, and what didn't carry over.
#[derive(Debug)]
pub struct Exported {
    pub file_name: String,
    pub media_type: &'static str,
    pub bytes: Vec<u8>,
    pub diagnostics: Vec<Diagnostic>,
}

/// A parsed import, not yet in any design.
#[derive(Debug)]
pub struct Imported {
    /// The codec that read it.
    pub format: &'static str,
    /// Precisely what the bytes were, like `html` or `figma-payload v1`.
    pub input_kind: String,
    pub boards: Vec<Board>,
    /// Pages the import brings, by name, in order. Each one the design
    /// doesn't have by that name is created, even if no board goes on it.
    pub pages: Vec<String>,
    /// The tokens the import brings, merged into the design's.
    pub tokens: Tokens,
    /// Shared CSS from a bundle made before tokens. Its custom properties
    /// become tokens, and the rest goes at the start of each new artboard,
    /// as [`finite_design::edit::migrate_css`] does for a design.
    pub css: Option<String>,
    /// Files the import carries, like a bundle's images. The caller stores
    /// them before placing, and the content refers to them as
    /// [`assets::SCHEME`] references.
    pub blobs: Vec<Vec<u8>>,
    pub dependencies: Vec<Dependency>,
    /// Each with where it belongs, which [`Imported::place`] turns into a node.
    pub diagnostics: Vec<(Anchor, Diagnostic)>,
}

/// A design's tokens as files carry them: its modes' names in order, and
/// each token's values by mode name. On import, a mode the design doesn't
/// have by that name is added, and a token the design has gets the
/// import's values.
#[derive(Debug, Default, PartialEq)]
pub struct Tokens {
    pub modes: Vec<String>,
    pub values: BTreeMap<String, BTreeMap<String, String>>,
}

impl Tokens {
    /// The design's tokens, each value passed through `portable`. A design
    /// with only its implicit mode and no tokens has none.
    pub fn of(doc: &Document, mut portable: impl FnMut(&str) -> String) -> Self {
        if doc.tokens().is_empty() && doc.mode_map().is_empty() {
            return Self::default();
        }
        let modes = doc.modes();
        let name_of = |id: &str| {
            modes
                .iter()
                .find(|(m, _)| *m == id)
                .map(|(_, m)| m.name.clone())
        };
        Self {
            modes: modes.iter().map(|(_, m)| m.name.clone()).collect(),
            values: doc
                .tokens()
                .iter()
                .map(|(name, values)| {
                    let values = values
                        .iter()
                        .filter_map(|(mode, value)| Some((name_of(mode)?, portable(value))))
                        .collect();
                    (name.clone(), values)
                })
                .collect(),
        }
    }

    /// The name of the mode `board` renders in, unless it's the first one.
    pub fn mode_of(doc: &Document, board: &Node) -> Option<String> {
        let mode = doc.mode_of(board);
        (mode != doc.first_mode())
            .then(|| doc.mode_map().get(mode).map(|m| m.name.clone()))
            .flatten()
    }

    /// Every value, for checking the files they refer to.
    pub fn texts(&self) -> impl Iterator<Item = &str> {
        self.values
            .values()
            .flat_map(|v| v.values())
            .map(String::as_str)
    }
}

/// The defaults every artboard starts with that set how it looks rather
/// than how it holds its content: a white flex column.
pub const LOOK: [&str; 3] = ["background-color", "display", "flex-direction"];

/// One artboard to create, with its content.
#[derive(Debug, Default)]
pub struct Board {
    pub name: String,
    pub width: f64,
    pub height: f64,
    /// The artboard grows to fit its content, so `height` isn't used.
    pub auto_height: bool,
    /// Leave the [`LOOK`] defaults out of the artboard's inline styles,
    /// because the content's own CSS sets them, and inline styles would win.
    pub look_in_css: bool,
    /// Where on the canvas, or `None` to place it beside the others.
    pub position: Option<(f64, f64)>,
    /// The name of the page it goes on, or `None` for the import's page.
    pub page: Option<String>,
    /// The name of the mode it renders in, or `None` for the first mode.
    pub mode: Option<String>,
    /// The artboard's own styles, over the defaults every artboard starts with.
    pub styles: BTreeMap<String, String>,
    pub attrs: BTreeMap<String, String>,
    pub content: Vec<Fragment>,
    /// Where the board came from in the source, in the codec's notation,
    /// if it came from anything.
    pub source: Option<String>,
    /// Where each content node came from, numbered like [`Anchor::node`].
    pub paths: Vec<String>,
}

impl Board {
    /// The name of the artboard at `index` when its source doesn't name it.
    pub(crate) fn unnamed(index: usize) -> String {
        format!("Artboard {}", index + 1)
    }

    /// Sets the board's size from the width and height in `styles`, as the
    /// artboard element of a file states them. A width or height that isn't
    /// in pixels falls back to [`DEFAULT_ARTBOARD_SIZE`], and a missing or
    /// `auto` height makes the artboard grow to fit. Returns a diagnostic
    /// for the fallbacks, naming `path` in the source.
    pub(crate) fn size_from(
        &mut self,
        styles: &BTreeMap<String, String>,
        path: &str,
    ) -> Option<Diagnostic> {
        let probe = Node {
            styles: styles.clone(),
            ..Node::element("", "div")
        };
        let (width, height) = edit::pixel_size(&probe);
        let (width, height) = (width.filter(|w| *w > 0.0), height.filter(|h| *h > 0.0));
        self.auto_height = styles
            .get("height")
            .is_none_or(|h| h.trim().eq_ignore_ascii_case("auto"));
        let (default_width, default_height) = DEFAULT_ARTBOARD_SIZE;
        let mut fallen = Vec::new();
        if width.is_none() {
            fallen.push(format!("{default_width} wide"));
        }
        if height.is_none() && !self.auto_height {
            fallen.push(format!("{default_height} tall"));
        }
        self.width = width.unwrap_or(default_width);
        self.height = height.unwrap_or(default_height);
        (!fallen.is_empty()).then(|| {
            Diagnostic::new(
                Feature::Frame,
                "the artboard's size",
                format!(
                    "it isn't in pixels, so the artboard is {}",
                    fallen.join(" and ")
                ),
                [Score::No, Score::No, Score::Yes],
            )
            .at(path)
        })
    }
}

/// Where a diagnostic belongs before its nodes have ids: a board, and a node
/// inside it numbered in the order [`Fragment::create_ops`] creates them
/// (`None` for the board itself).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub board: usize,
    pub node: Option<usize>,
}

/// What the caller knows about an import that the codec doesn't.
pub struct Receipt {
    pub id: String,
    /// The design it goes into, for the URLs of its blobs.
    pub design: String,
    /// The page boards go on unless they name their own, or `None` for the first page.
    pub page: Option<String>,
    /// Where the caller stored the bytes. They must be durable before
    /// [`Imported::place`] runs, since the record will point at them.
    pub artifact: BlobHash,
    pub file_name: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub received_at: u64,
}

/// An import once it's in a design.
#[derive(Debug)]
pub struct Placed {
    pub artboards: Vec<NodeId>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Imported {
    /// Creates the import's artboards in `tx`, one after another so each is
    /// placed clear of the last, and returns its record. Meant to run inside
    /// [`finite_design::Design::import`], which undoes everything if this fails.
    pub fn place(
        self,
        tx: &mut Transaction<'_>,
        receipt: Receipt,
        new_id: &mut impl FnMut() -> NodeId,
    ) -> Result<(ImportRecord, Placed), Error> {
        if let Some(page) = &receipt.page
            && tx.doc().page(page).is_none()
        {
            return Err(Error(format!("the design has no page {page:?}")));
        }
        for name in &self.pages {
            page_named(tx, name, new_id)?;
        }
        // Files leave out the mode of an artboard in the first mode, which
        // may not be the design's first mode.
        let first_mode = self.tokens.modes.first().cloned();
        let rest = add_tokens(tx, self.tokens, self.css, &receipt.design, new_id)?;
        let mut boards: Vec<(NodeId, Vec<NodeId>)> = Vec::new();
        let mut nodes = BTreeMap::new();
        let resolve = |value: &mut String| {
            if value.contains(assets::SCHEME) {
                *value = assets::resolve(value, &receipt.design);
            }
        };
        for mut board in self.boards {
            let mut resolve = resolve;
            board.styles.values_mut().for_each(&mut resolve);
            board.attrs.values_mut().for_each(&mut resolve);
            assets::for_each_value(&mut board.content, &mut resolve);
            let page = match board.page.take() {
                Some(name) => Some(page_named(tx, &name, new_id)?),
                None => receipt.page.clone(),
            };
            let id = new_id();
            let unset: Vec<&str> = LOOK
                .into_iter()
                .filter(|name| board.look_in_css && !board.styles.contains_key(*name))
                .collect();
            let mut content = Vec::new();
            let mut numbered = || {
                let id = new_id();
                content.push(id.clone());
                id
            };
            let spec = NewArtboard {
                name: board.name,
                width: board.width,
                height: (!board.auto_height).then_some(board.height),
                position: board.position,
                page,
                styles: board.styles,
                ..Default::default()
            };
            let (mut ops, _) = edit::create_artboard_with(
                tx.doc(),
                id.clone(),
                spec,
                board.content,
                &mut numbered,
            )?;
            if let Some(Op::Create { node }) = ops.first_mut() {
                node.attrs.extend(board.attrs);
                node.mode = board.mode.or_else(|| first_mode.clone()).and_then(|name| {
                    // By name only: an id in the source means nothing here.
                    let modes = tx.doc().mode_map();
                    let (id, _) = modes
                        .iter()
                        .find(|(_, m)| m.name.eq_ignore_ascii_case(&name))?;
                    Some(id.clone())
                });
                for name in unset {
                    node.styles.remove(name);
                }
            }
            tx.apply(&ops)?;
            if let Some(rest) = &rest {
                let style = format!(
                    "<style>{}</style>",
                    finite_design::html::layered_style(rest)
                );
                let (ops, _) =
                    edit::write_html(tx.doc(), &id, &style, WriteMode::Append, Some(0), new_id)?;
                tx.apply(&ops)?;
            }
            if let Some(source) = board.source {
                nodes.insert(id.clone(), source);
            }
            nodes.extend(content.iter().cloned().zip(board.paths));
            boards.push((id, content));
        }
        let mut quarantined = Vec::new();
        let diagnostics: Vec<Diagnostic> = self
            .diagnostics
            .into_iter()
            .map(|(anchor, mut diagnostic)| {
                diagnostic.node = boards.get(anchor.board).map(|(board, content)| {
                    anchor
                        .node
                        .and_then(|n| content.get(n))
                        .unwrap_or(board)
                        .clone()
                });
                if diagnostic.quarantined {
                    quarantined.push(Quarantined {
                        node: diagnostic.node.clone(),
                        path: diagnostic.path.clone(),
                        what: diagnostic.what.clone(),
                        reason: diagnostic.reason.clone(),
                    });
                }
                diagnostic
            })
            .collect();
        let record = ImportRecord {
            id: receipt.id,
            artifact: receipt.artifact,
            format: self.format.to_owned(),
            input_kind: self.input_kind,
            file_name: receipt.file_name,
            received_at: receipt.received_at,
            nodes,
            dependencies: self.dependencies,
            quarantined,
        };
        let artboards = boards.into_iter().map(|(id, _)| id).collect();
        Ok((
            record,
            Placed {
                artboards,
                diagnostics,
            },
        ))
    }
}

/// Adds an import's modes and tokens to the design, and the custom
/// properties of its old shared CSS, if it has some. Returns the rest of
/// that CSS, for each new artboard. A design that has no tokens and only
/// its implicit mode takes the import's modes as they are.
fn add_tokens(
    tx: &mut Transaction<'_>,
    imported: Tokens,
    css: Option<String>,
    design: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Option<String>, Error> {
    let fresh = tx.doc().mode_map().is_empty() && tx.doc().tokens().is_empty();
    let mut names: Vec<String> = if fresh {
        Vec::new()
    } else {
        edit::mode_list(tx.doc())
            .into_iter()
            .map(|(_, name)| name)
            .collect()
    };
    for mode in imported.modes {
        if !names.iter().any(|name| name.eq_ignore_ascii_case(&mode)) {
            names.push(mode);
        }
    }
    if !names.is_empty() {
        let mut mode_id = || format!("mode-{}", new_id());
        let (ops, _) = edit::set_modes(tx.doc(), &names, &mut mode_id)?;
        tx.apply(&ops)?;
    }
    let resolve = |value: String| {
        if value.contains(assets::SCHEME) {
            assets::resolve(&value, design)
        } else {
            value
        }
    };
    let migrated = css
        .filter(|css| !css.trim().is_empty())
        .map(|css| {
            let room = tokens::MAX_TOKENS.saturating_sub(tx.doc().tokens().len());
            tokens::migrate(&resolve(css), room)
        })
        .unwrap_or_default();
    let first = tx.doc().modes()[0].1.name.clone();
    let mut changes: Vec<(String, TokenChange)> = migrated
        .tokens
        .into_iter()
        .map(|(name, value)| {
            (
                name,
                TokenChange::Modes(BTreeMap::from([(first.clone(), Some(value))])),
            )
        })
        .collect();
    changes.extend(imported.values.into_iter().map(|(name, values)| {
        let values = values
            .into_iter()
            .map(|(mode, value)| (mode, Some(resolve(value))))
            .collect();
        (name, TokenChange::Modes(values))
    }));
    if !changes.is_empty() {
        let ops = edit::set_tokens(tx.doc(), &edit::mode_list(tx.doc()), &changes)?;
        tx.apply(&ops)?;
    }
    Ok(migrated.rest)
}

/// The id of the page named `name`, created after the others if the design
/// has none by that name.
fn page_named(
    tx: &mut Transaction<'_>,
    name: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<String, Error> {
    if let Some((id, _)) = tx.doc().pages().into_iter().find(|(_, p)| p.name == name) {
        return Ok(id.to_owned());
    }
    let id = format!("page-{}", new_id());
    let ops = edit::create_page(tx.doc(), id.clone(), name)?;
    tx.apply(&ops)?;
    Ok(id)
}

/// Why an import or export failed. Nothing was changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<EditError> for Error {
    fn from(e: EditError) -> Self {
        Self(e.0)
    }
}

impl From<Rejected> for Error {
    fn from(e: Rejected) -> Self {
        Self(e.to_string())
    }
}

/// The file name for an export of `name`: letters, digits and dashes, so
/// it's safe in a `Content-Disposition` header and on any disk.
pub fn file_stem(name: &str) -> String {
    let stem = slug(name);
    if stem.is_empty() {
        "design".into()
    } else {
        stem
    }
}

/// The runs of ASCII letters and digits in a name. Every file name and
/// identifier made from a layer name is built from these.
pub(crate) fn words(name: &str) -> impl Iterator<Item = &str> {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
}

/// `name` as lowercase [`words`] joined by dashes, or empty if it has none.
/// `Home — Desktop 2` is `home-desktop-2`.
pub(crate) fn slug(name: &str) -> String {
    words(name)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    /// `SUPPORT.md` is the support table, generated from every codec's
    /// `support`, with columns padded the way `vp check` formats Markdown.
    /// Regenerate it with `FINITE_UPDATE_FIXTURES=1`.
    #[test]
    fn support_table_is_current() {
        let mut rows = vec![vec!["Feature".to_owned()]];
        for format in Format::ALL {
            let name = format.codec().name();
            rows[0].push(format!("{name} import"));
            rows[0].push(format!("{name} export"));
        }
        for feature in Feature::ALL {
            let mut row = vec![feature.name().to_owned()];
            for format in Format::ALL {
                for direction in [Direction::Import, Direction::Export] {
                    let support = format.codec().support(feature, direction);
                    row.push(format!("{support:?}").to_lowercase());
                }
            }
            rows.push(row);
        }
        let widths: Vec<usize> = (0..rows[0].len())
            .map(|i| rows.iter().map(|r| r[i].len()).max().unwrap_or(0))
            .collect();
        let line = |cells: Vec<String>| {
            let cells: Vec<String> = cells
                .iter()
                .zip(&widths)
                .map(|(c, w)| format!("{c:w$}"))
                .collect();
            format!("| {} |\n", cells.join(" | "))
        };
        let mut table = String::from(
            "# What each format supports\n\nGenerated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.\n\n",
        );
        let mut rows = rows.into_iter();
        table.push_str(&line(rows.next().unwrap()));
        table.push_str(&line(widths.iter().map(|w| "-".repeat(*w)).collect()));
        for row in rows {
            table.push_str(&line(row));
        }
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("SUPPORT.md");
        if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
            fs::write(&path, &table).unwrap();
            return;
        }
        let saved = fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            saved, table,
            "SUPPORT.md is stale: run with FINITE_UPDATE_FIXTURES=1"
        );
    }

    /// Artboard `a` holds a "Bar" component; artboard `b` an instance of it
    /// that overrides the title.
    fn with_instance() -> Document {
        let mut doc = Document::default();
        let mut ops = Vec::new();
        for (board, index) in [("a", "V"), ("b", "W")] {
            ops.push(Op::Create {
                node: finite_design::Node {
                    index: index.into(),
                    x: Some(0.0),
                    y: Some(0.0),
                    ..finite_design::Node::element(board, "div")
                },
            });
        }
        let bar = finite_design::html::parse(
            r#"<header data-name="Bar"><h1 data-name="Title">Home</h1></header>"#,
        )
        .unwrap()
        .remove(0);
        let mut n = 0;
        let mut next = || {
            n += 1;
            format!("n{n}")
        };
        let bar = bar.create_ops(Some("a"), "V".into(), None, &mut next, &mut ops);
        ops.push(Op::Set {
            id: bar.clone(),
            key: finite_design::PropKey::Component,
            value: Some(true.into()),
        });
        ops.push(Op::Create {
            node: finite_design::Node {
                parent: Some("b".into()),
                index: "V".into(),
                instance_of: Some(bar),
                ..finite_design::Node::element("i", "header")
            },
        });
        ops.push(Op::Set {
            id: "i".into(),
            key: finite_design::PropKey::Override("n3/text".into()),
            value: Some("Settings".into()),
        });
        doc.apply_all(&ops);
        doc
    }

    #[test]
    fn an_export_writes_instances_as_the_elements_they_show() {
        let doc = with_instance();
        assert!(doc.get("i").unwrap().is_instance());
        for format in Format::ALL {
            let revision = Revision {
                name: "App",
                doc: &doc,
                imports: &[],
                blobs: &NoBlobs,
                measure: &scene::NoMeasure,
            };
            // An app only holds the whole design.
            let scope = match format {
                Format::App => Scope::Design,
                _ => Scope::Artboard("b".into()),
            };
            // The raw document has nothing to write for the instance.
            let raw = format.codec().write(&revision, &scope);
            let exported = export(format, &revision, &scope);
            let name = format.codec().name();
            let Ok(exported) = exported else {
                // Figma measures layout, which this test can't.
                assert_eq!(format, Format::Figma, "{name}: {:?}", raw.err());
                continue;
            };
            let text = String::from_utf8(exported.bytes).unwrap();
            assert!(
                text.contains("Settings"),
                "{name} wrote the override: {text}"
            );
            assert!(
                !text.contains("data-instance-of") && !text.contains("instanceOf"),
                "{name} points at a component: {text}"
            );
            let raw = raw.map(|r| String::from_utf8(r.bytes).unwrap()).unwrap();
            assert!(!raw.contains("Settings"), "{name}: {raw}");
            let [note] = exported.diagnostics.as_slice() else {
                panic!("{name}: {:?}", exported.diagnostics);
            };
            assert_eq!(note.feature, Feature::Instance);
            assert_eq!(note.node.as_deref(), Some("i"));
            assert!(
                note.what.contains("1 instance(s) of \"Bar\""),
                "{}",
                note.what
            );
            assert_eq!((note.preserved, note.visual), (Score::No, Score::Yes));
        }
        // An artboard with no instance gets no note.
        let revision = Revision {
            name: "App",
            doc: &doc,
            imports: &[],
            blobs: &NoBlobs,
            measure: &scene::NoMeasure,
        };
        let exported = export(Format::Html, &revision, &Scope::Artboard("a".into())).unwrap();
        assert!(exported.diagnostics.is_empty());
    }

    #[test]
    fn an_app_export_routes_with_the_router_it_was_given() {
        let doc = with_instance();
        let revision = Revision {
            name: "App",
            doc: &doc,
            imports: &[],
            blobs: &NoBlobs,
            measure: &scene::NoMeasure,
        };
        let exported = export_with(
            Format::App,
            &revision,
            &Scope::Design,
            Some(app::RouterKind::TanStackRouter),
        )
        .unwrap();
        let text = String::from_utf8(exported.bytes).unwrap();
        assert!(text.contains("@tanstack/react-router"), "{text}");
        assert!(
            text.contains("Settings"),
            "instances are still expanded: {text}"
        );
        assert_eq!(exported.diagnostics.len(), 1);

        // Only an app has a router.
        let error = export_with(
            Format::Html,
            &revision,
            &Scope::Artboard("a".into()),
            Some(app::RouterKind::TanStackRouter),
        )
        .unwrap_err();
        assert!(
            error.0.contains("only applies to the app format"),
            "{error}"
        );
    }

    #[test]
    fn an_export_counts_instances_inside_components() {
        let mut doc = with_instance();
        let bar = doc.get("i").unwrap().instance_of.clone().unwrap();
        let mut ops = Vec::new();
        for (id, parent, index) in [("c2", "a", "X"), ("j", bar.as_str(), "Z")] {
            ops.push(Op::Create {
                node: finite_design::Node {
                    parent: Some(parent.into()),
                    index: index.into(),
                    ..finite_design::Node::element(id, "div")
                },
            });
        }
        ops.push(Op::Set {
            id: "c2".into(),
            key: finite_design::PropKey::Component,
            value: Some(true.into()),
        });
        ops.push(Op::Set {
            id: "j".into(),
            key: finite_design::PropKey::InstanceOf,
            value: Some("c2".into()),
        });
        for op in &ops {
            doc.apply(op).unwrap();
        }
        let revision = Revision {
            name: "App",
            doc: &doc,
            imports: &[],
            blobs: &NoBlobs,
            measure: &scene::NoMeasure,
        };
        let exported = export(Format::Html, &revision, &Scope::Artboard("b".into())).unwrap();
        let [note] = exported.diagnostics.as_slice() else {
            panic!("{:?}", exported.diagnostics);
        };
        assert!(note.what.starts_with("2 instance(s) of"), "{}", note.what);
    }

    #[test]
    fn formats_are_found_by_name() {
        for format in Format::ALL {
            assert_eq!(Format::named(format.codec().name()), Some(format));
        }
        assert_eq!(Format::named("nope"), None);
    }

    #[test]
    fn file_stems_are_safe() {
        assert_eq!(file_stem("Home — Desktop 2"), "home-desktop-2");
        assert_eq!(file_stem("../../etc"), "etc");
        assert_eq!(file_stem("✨"), "design");
    }
}
