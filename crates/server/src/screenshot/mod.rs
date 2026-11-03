//! Renders artboards to images with a headless Chrome, so agents can check
//! their work visually.
//!
//! A capture comes in two steps. [`plan`] reads the document (under the
//! design's lock) and decides what to render: one page per artboard, and
//! the shots to take of it. [`capture`] then renders those pages, without
//! the lock, in one browser:
//!
//! - A shot targets an artboard, or any element or text node in one, and is
//!   cropped to that node's box. [`Shot::region`] narrows it to part of the
//!   node, and [`Shot::padding`] widens it to show the node in context.
//! - [`Options`] apply to every shot: the device scale, the image format,
//!   nodes to hide or outline, a transparent background, and whether to show
//!   content that overflows the artboard instead of cutting it off.
//! - Each [`Image`] says where the shot was in the artboard, the node's own
//!   box, whether the shot was cut off at the artboard's edge, and how far
//!   the artboard's content overflows it.

use std::{collections::BTreeMap, fmt::Write, path::PathBuf, time::Duration};

use base64::Engine;
use finite_design::{
    Document, NodeId, NodeKind,
    edit::pixel_size,
    html::{self, BASE_CSS, BASE_LAYER, CSP, VIEWER_ID_ATTR},
};
use finite_transfer::scene::{COMPUTED, Measure, Resolved, Scene};
use serde::Serialize;
use serde_json::{Value, json};

use crate::hub::random_id;

mod cdp;

/// Artboards without a pixel width or height are captured at this size.
const FALLBACK_WIDTH: f64 = 1440.0;
const FALLBACK_HEIGHT: f64 = 900.0;
/// The largest artboard side rendered, in CSS pixels.
const MAX_SIDE: f64 = 8000.0;
/// The longest side of a screenshot, in image pixels. The Claude API refuses
/// images over 8,000 pixels on a side, and once a request holds more than 20
/// images, a stricter limit applies to all of them. An agent checking its work
/// passes 20 screenshots quickly, and Anthropic's docs suggest at most 3,000
/// pixels a side to stay under that limit everywhere.
pub const MAX_OUTPUT_SIDE: f64 = 3000.0;
/// The most shots one capture takes. Each is an image in the agent's context.
pub const MAX_SHOTS: usize = 10;
/// Device scales a capture accepts.
pub const MIN_SCALE: f64 = 0.25;
pub const MAX_SCALE: f64 = 3.0;
/// How long a page with scripts or animations runs before it's captured.
/// Matches what the agent instructions promise: about 3 seconds after load.
pub const DEFAULT_SETTLE: Duration = Duration::from_secs(3);
pub const MAX_SETTLE: Duration = Duration::from_secs(10);
/// How long a page may take to load its images and fonts.
const LOAD: Duration = Duration::from_secs(20);
/// The outline drawn around highlighted nodes.
const HIGHLIGHT: &str = "2px solid #ff2d55";

/// The device scale to capture `width` × `height` CSS pixels at: `requested`,
/// lowered if needed so the image's longer side fits in [`MAX_OUTPUT_SIDE`].
pub fn output_scale(width: f64, height: f64, requested: f64) -> f64 {
    requested.min(MAX_OUTPUT_SIDE / width.max(height))
}

/// A rectangle in CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn right(&self) -> f64 {
        self.x + self.width
    }

    fn bottom(&self) -> f64 {
        self.y + self.height
    }

    fn offset(&self, dx: f64, dy: f64) -> Self {
        Self::new(self.x + dx, self.y + dy, self.width, self.height)
    }

    fn grow(&self, by: f64) -> Self {
        Self::new(
            self.x - by,
            self.y - by,
            self.width + 2.0 * by,
            self.height + 2.0 * by,
        )
    }

    /// The overlap of two rectangles, if they overlap by at least a pixel's width.
    fn intersect(&self, other: &Self) -> Option<Self> {
        let (x, y) = (self.x.max(other.x), self.y.max(other.y));
        let (right, bottom) = (
            self.right().min(other.right()),
            self.bottom().min(other.bottom()),
        );
        (right - x >= 0.5 && bottom - y >= 0.5).then(|| Self::new(x, y, right - x, bottom - y))
    }

    /// Rounded to whole CSS pixels outward, so a crop never cuts a pixel in half.
    fn snap(&self) -> Self {
        let (x, y) = (self.x.floor(), self.y.floor());
        Self::new(x, y, self.right().ceil() - x, self.bottom().ceil() - y)
    }
}

/// What to capture.
#[derive(Clone, Debug)]
pub struct Shot {
    /// An artboard, or an element or text node inside one. A text node is
    /// captured as its parent element, the smallest box around it.
    pub node: NodeId,
    /// Part of the node to capture, relative to its top-left corner. Omit
    /// for the whole node. It may reach past the node, to the artboard's edges.
    pub region: Option<Rect>,
    /// CSS pixels of surroundings to include on every side.
    pub padding: f64,
}

impl Shot {
    pub fn node(node: impl Into<NodeId>) -> Self {
        Self {
            node: node.into(),
            region: None,
            padding: 0.0,
        }
    }
}

/// The encoding of captured images.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Format {
    #[default]
    Png,
    /// Smaller than PNG for photos and gradients. No transparency.
    Jpeg {
        quality: u8,
    },
    Webp {
        quality: u8,
    },
}

impl Format {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg { .. } => "image/jpeg",
            Self::Webp { .. } => "image/webp",
        }
    }

    fn protocol(self) -> (&'static str, Option<u8>) {
        match self {
            Self::Png => ("png", None),
            Self::Jpeg { quality } => ("jpeg", Some(quality.clamp(1, 100))),
            Self::Webp { quality } => ("webp", Some(quality.clamp(1, 100))),
        }
    }
}

/// How every shot in a capture is rendered.
#[derive(Clone, Debug)]
pub struct Options {
    /// Device pixel ratio, from [`MIN_SCALE`] to [`MAX_SCALE`]. A shot is
    /// captured smaller if its longer side would pass [`MAX_OUTPUT_SIDE`].
    pub scale: f64,
    pub format: Format,
    /// Nodes rendered invisible, keeping their space in the layout, to
    /// see what's behind an overlay or a modal.
    pub hide: Vec<NodeId>,
    /// Nodes outlined, to see their boxes. The outline is drawn inside the
    /// box, so it doesn't move anything.
    pub highlight: Vec<NodeId>,
    /// Leave out the page's background, and the backgrounds of the shot's
    /// ancestors, so the node is shown alone. A shot of an artboard leaves
    /// out the artboard's own background too. Not for JPEG.
    pub transparent: bool,
    /// Show content that overflows the artboard's right and bottom edges
    /// instead of cutting it off, to see what doesn't fit.
    pub reveal_overflow: bool,
    /// How long a page with scripts or animations runs before it's
    /// captured, up to [`MAX_SETTLE`]. Pages without either are captured as
    /// soon as their images and fonts load.
    pub settle: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            scale: 1.0,
            format: Format::Png,
            hide: Vec::new(),
            highlight: Vec::new(),
            transparent: false,
            reveal_overflow: false,
            settle: DEFAULT_SETTLE,
        }
    }
}

/// How far an artboard's content reaches past its edges, in CSS pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Overflow {
    pub right: f64,
    pub bottom: f64,
}

impl Overflow {
    pub fn any(&self) -> bool {
        self.right > 0.0 || self.bottom > 0.0
    }
}

/// One captured shot.
#[derive(Clone, Debug)]
pub struct Image {
    pub data: Vec<u8>,
    pub mime: &'static str,
    /// The node the shot asked for, and the artboard it's in.
    pub node: NodeId,
    pub artboard: NodeId,
    /// The element measured: the node, or a text node's parent element.
    pub element: NodeId,
    /// The captured area, relative to the artboard's top-left corner.
    pub area: Rect,
    /// The element's own box, relative to the artboard's top-left corner.
    pub bounds: Rect,
    /// The image's size in pixels.
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// The scale the shot was captured at, and the one asked for. They
    /// differ when the shot was shrunk to fit [`MAX_OUTPUT_SIDE`].
    pub scale: f64,
    pub requested_scale: f64,
    /// The asked-for area reached past the artboard's edges (or past its
    /// overflowing content, with [`Options::reveal_overflow`]), so the image
    /// shows less than asked.
    pub cut_off: bool,
    /// How far the artboard's content overflows it, and whether the shot
    /// shows that overflow ([`Options::reveal_overflow`]) or cuts it off.
    pub overflow: Overflow,
    pub overflow_shown: bool,
    /// The page has scripts or animations and ran for this long first.
    pub settled: Option<Duration>,
    /// Where every element of the artboard rendered, for a shot of the
    /// whole artboard, so the agent can be told what's cut off.
    pub boxes: Option<Vec<ElementBox>>,
}

/// Where an element rendered, in CSS pixels from the page's top left corner.
#[derive(Clone, Debug, PartialEq)]
pub struct ElementBox {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// How far the element's own text runs past its box, across and down.
    pub text_overflow: (f64, f64),
    /// Whether the element holds text of its own, not just in children.
    pub has_text: bool,
    /// Where that text itself rendered, which can be much smaller than the
    /// element's box: a heading's text in a full-width block, say.
    pub text: Option<Rect>,
}

/// A capture, decided from the document and ready to render.
#[derive(Debug)]
pub struct Plan {
    pages: Vec<Page>,
    shots: usize,
    options: Options,
}

/// One artboard rendered as a standalone page.
#[derive(Debug)]
struct Page {
    artboard: NodeId,
    html: String,
    width: f64,
    height: f64,
    shots: Vec<PlannedShot>,
}

#[derive(Debug)]
struct PlannedShot {
    /// Where its image goes in the results.
    index: usize,
    shot: Shot,
    element: NodeId,
    /// The element's ancestors, nearest first, ending with the artboard.
    ancestors: Vec<NodeId>,
}

/// Decides what to render for `shots`. Fails if a node isn't in the
/// document or the options can't be met.
pub fn plan(doc: &Document, shots: Vec<Shot>, options: Options) -> Result<Plan, String> {
    if shots.is_empty() {
        return Err("nothing to capture: name at least one node".into());
    }
    if shots.len() > MAX_SHOTS {
        return Err(format!(
            "{} shots asked for; one capture takes at most {MAX_SHOTS}",
            shots.len()
        ));
    }
    if options.transparent && matches!(options.format, Format::Jpeg { .. }) {
        return Err("JPEG has no transparency; use PNG or WebP for a transparent capture".into());
    }
    for id in options.hide.iter().chain(&options.highlight) {
        if !doc.contains(id) {
            return Err(format!("node {id:?} not found"));
        }
    }
    let total = shots.len();
    let mut pages: Vec<Page> = Vec::new();
    for (index, shot) in shots.into_iter().enumerate() {
        let node = doc
            .get(&shot.node)
            .ok_or_else(|| format!("node {:?} not found", shot.node))?;
        let element = match node.kind {
            NodeKind::Element { .. } => node,
            NodeKind::Text => node
                .parent
                .as_deref()
                .and_then(|p| doc.get(p))
                .ok_or_else(|| format!("text node {:?} has no element around it", shot.node))?,
        };
        if let Some(region) = shot.region
            && (region.width <= 0.0 || region.height <= 0.0)
        {
            return Err(format!(
                "the region for {:?} is empty: give it a positive width and height",
                shot.node
            ));
        }
        let mut ancestors = Vec::new();
        let mut parent = element.parent.as_deref();
        while let Some(id) = parent {
            ancestors.push(id.to_owned());
            parent = doc.get(id).and_then(|n| n.parent.as_deref());
        }
        let artboard = ancestors
            .last()
            .cloned()
            .unwrap_or_else(|| element.id.clone());
        let planned = PlannedShot {
            index,
            element: element.id.clone(),
            ancestors,
            shot: Shot {
                padding: shot.padding.clamp(0.0, MAX_SIDE),
                ..shot
            },
        };
        match pages.iter_mut().find(|p| p.artboard == artboard) {
            Some(page) => page.shots.push(planned),
            None => {
                let (html, width, height) =
                    page_html(doc, &artboard, &options).expect("the artboard is in the document");
                pages.push(Page {
                    artboard,
                    html,
                    width,
                    height,
                    shots: vec![planned],
                });
            }
        }
    }
    Ok(Plan {
        pages,
        shots: total,
        options,
    })
}

/// A standalone HTML page showing just the artboard, and its size in CSS
/// pixels. Every element carries its node id in [`VIEWER_ID_ATTR`], so
/// shots can find it. The web viewer renders artboards that run scripts
/// from the same HTML.
fn page_html(doc: &Document, artboard: &str, options: &Options) -> Option<(String, f64, f64)> {
    let node = doc.get(artboard)?;
    // Compact, so no whitespace is added between elements: it renders like the viewer.
    let body = html::export_for_viewer(doc, artboard)?;
    let (width, height) = pixel_size(node);
    let width = width.unwrap_or(FALLBACK_WIDTH).clamp(1.0, MAX_SIDE);
    let height = height.unwrap_or(FALLBACK_HEIGHT).clamp(1.0, MAX_SIDE);
    // Overrides come last in the body, after the artboard's own <style>s, so
    // they win ties.
    let mut overrides = String::new();
    let in_board = |id: &&NodeId| doc.artboard_of(id).is_some_and(|b| b.id == artboard);
    let hidden: Vec<_> = options.hide.iter().filter(in_board).collect();
    if !hidden.is_empty() {
        let _ = write!(
            overrides,
            "{} {{ visibility: hidden !important; }}",
            selectors(&hidden)
        );
    }
    let outlined: Vec<_> = options.highlight.iter().filter(in_board).collect();
    if !outlined.is_empty() {
        let _ = write!(
            overrides,
            "{} {{ outline: {HIGHLIGHT} !important; outline-offset: -2px !important; }}",
            selectors(&outlined)
        );
    }
    if options.transparent {
        overrides.push_str("html, body { background: transparent !important; }");
    }
    // The design's shared CSS, in a layer the artboard's own styles
    // override (see `html::shared_style`), after the base styles' layer.
    let shared = doc.css().map_or(String::new(), |css| {
        format!("<style>{}</style>", html::shared_style(css, false))
    });
    let page = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><style>@layer {BASE_LAYER} {{ {BASE_CSS} html, body {{ margin: 0; }} }}</style>{shared}</head><body>{body}<style>{overrides}</style></body></html>"
    );
    Some((page, width, height))
}

/// A CSS selector for the element with node id `id`.
fn selector(id: &str) -> String {
    let mut quoted = String::with_capacity(id.len());
    for c in id.chars() {
        match c {
            '"' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '\n' => quoted.push_str("\\a "),
            c => quoted.push(c),
        }
    }
    // `html body` raises the specificity above the artboard's own class rules.
    format!("html body [{VIEWER_ID_ATTR}=\"{quoted}\"]")
}

fn selectors(ids: &[&NodeId]) -> String {
    ids.iter()
        .map(|id| selector(id))
        .collect::<Vec<_>>()
        .join(", ")
}

/// How many browsers may render at once. Each capture starts its own Chrome,
/// so without a limit, many agents checking their work together would start
/// that many browsers. Further captures wait their turn.
fn browsers() -> &'static tokio::sync::Semaphore {
    static BROWSERS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    BROWSERS.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
        tokio::sync::Semaphore::new((cores / 2).clamp(1, 4))
    })
}

fn chrome() -> Option<PathBuf> {
    // An empty value, as a script sets when it found no browser, means unset.
    if let Some(path) = std::env::var_os("FINITE_CHROME").filter(|p| !p.is_empty()) {
        return Some(path.into());
    }
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

/// Renders a [`Plan`]. The outer error means nothing could be captured,
/// such as no browser; otherwise each shot succeeds or fails on its own, in
/// the order it was asked for. A shot fails when its node has no box on the
/// page (`display: none`, or empty) or lies wholly outside the artboard.
pub async fn capture(plan: Plan) -> Result<Vec<Result<Image, String>>, String> {
    let chrome = chrome().ok_or(
        "no Chrome, Chromium or Edge found for screenshots; set FINITE_CHROME to a browser binary",
    )?;
    let _turn = browsers()
        .acquire()
        .await
        .map_err(|_| "screenshots are shutting down")?;
    let dir = std::env::temp_dir().join(format!("finite-shot-{}", random_id(10)));
    let (browser, mut tab) = cdp::Browser::launch(&chrome, dir.clone()).await?;
    let results = capture_pages(&mut tab, &dir, plan).await;
    browser.close(tab).await;
    results
}

async fn capture_pages(
    tab: &mut cdp::Tab,
    dir: &std::path::Path,
    plan: Plan,
) -> Result<Vec<Result<Image, String>>, String> {
    tab.call("Page.enable", json!({})).await?;
    let mut results: Vec<Option<Result<Image, String>>> = (0..plan.shots).map(|_| None).collect();
    for (n, page) in plan.pages.iter().enumerate() {
        let path = dir.join(format!("page-{n}.html"));
        tokio::fs::write(&path, &page.html)
            .await
            .map_err(|e| e.to_string())?;
        let rendered = render(tab, &path, page, &plan.options).await;
        match rendered {
            Ok(images) => {
                for (index, image) in images {
                    results[index] = Some(image);
                }
            }
            // The page as a whole failed, so each of its shots did.
            Err(error) => {
                for shot in &page.shots {
                    results[shot.index] = Some(Err(error.clone()));
                }
            }
        }
    }
    Ok(results
        .into_iter()
        .map(|r| r.expect("every shot belongs to a page"))
        .collect())
}

/// What the page reports about the artboard and the shots' elements.
#[derive(serde::Deserialize)]
struct Layout {
    board: [f64; 4],
    /// How far the board's content reaches, as scroll width and height.
    scroll: [f64; 2],
    client: [f64; 2],
    /// The board's untransformed border box, from its computed CSS sizes,
    /// which keep fractions, unlike `offsetWidth`.
    offset: [f64; 2],
    animated: bool,
    elements: BTreeMap<String, Option<[f64; 4]>>,
    /// Every element in the artboard with a size: `[id, x, y, width, height,
    /// overflowX, overflowY]`, the overflow being how far its own text runs
    /// past its box.
    nodes: Vec<RawBox>,
}

type RawBox = (String, f64, f64, f64, f64, f64, f64, bool, Option<[f64; 4]>);

fn element_box((id, x, y, width, height, ox, oy, has_text, text): &RawBox) -> ElementBox {
    ElementBox {
        id: id.clone(),
        x: *x,
        y: *y,
        width: *width,
        height: *height,
        text_overflow: (*ox, *oy),
        has_text: *has_text,
        text: text.map(rect),
    }
}

/// An artboard's page, ready to measure without taking a picture.
pub struct Measurement {
    artboard: NodeId,
    html: String,
    width: f64,
    height: f64,
    settle: Duration,
    texts: Vec<TextRuns>,
}

/// Where an element's text nodes are on the page. Text nodes have no
/// [`VIEWER_ID_ATTR`] to find them by, so each is located in its parent:
/// the parent's `k`th DOM text node, characters `start..end` in UTF-16
/// units. Adjacent text nodes in the document parse as one DOM text node,
/// so several can share a `k`.
type TextRuns = (NodeId, Vec<(NodeId, usize, usize, usize)>);

/// The [`TextRuns`] of every element in `artboard`, for those with text.
fn text_runs(doc: &Document, artboard: &str) -> Vec<TextRuns> {
    let mut out = Vec::new();
    for node in doc.subtree(artboard) {
        let Some(tag) = node.tag() else { continue };
        let tag = tag.to_ascii_lowercase();
        // Their text is code, not content.
        if tag == "script" || tag == "style" {
            continue;
        }
        let mut runs = Vec::new();
        let (mut k, mut offset, mut open) = (0, 0, false);
        for (i, child) in doc.children(Some(&node.id)).into_iter().enumerate() {
            if child.tag().is_some() {
                if open {
                    (k, offset, open) = (k + 1, 0, false);
                }
                continue;
            }
            // The parser normalizes line breaks, and drops a newline that
            // opens a `<pre>`.
            let text = child.text.as_deref().unwrap_or("").replace("\r\n", "\n");
            let text = match text.strip_prefix('\n') {
                Some(rest) if i == 0 && (tag == "pre" || tag == "listing") => rest,
                _ => &text,
            };
            let len = text.encode_utf16().count();
            if len == 0 {
                continue;
            }
            runs.push((child.id.clone(), k, offset, offset + len));
            (offset, open) = (offset + len, true);
        }
        if !runs.is_empty() {
            out.push((node.id.clone(), runs));
        }
    }
    out
}

/// Prepares to measure the artboard holding `node`, or fails if it's not in
/// the document.
pub fn plan_measurement(
    doc: &Document,
    node: &str,
    options: Options,
) -> Result<Measurement, String> {
    let artboard = doc
        .artboard_of(node)
        .ok_or_else(|| format!("node {node:?} not found"))?
        .id
        .clone();
    let (html, width, height) =
        page_html(doc, &artboard, &options).expect("the artboard is in the document");
    Ok(Measurement {
        texts: text_runs(doc, &artboard),
        artboard,
        html,
        width,
        height,
        settle: options.settle,
    })
}

/// Where every element of an artboard rendered, in CSS pixels from the
/// page's top left corner, the artboard first. It renders the page as a
/// screenshot would, but takes no picture, so it's cheap to call after
/// every edit.
pub async fn layout(m: Measurement) -> Result<Vec<ElementBox>, String> {
    let chrome = chrome().ok_or(
        "no Chrome, Chromium or Edge found to lay out the page; set FINITE_CHROME to a browser binary",
    )?;
    let _turn = browsers()
        .acquire()
        .await
        .map_err(|_| "layout is shutting down")?;
    let dir = std::env::temp_dir().join(format!("finite-layout-{}", random_id(10)));
    let run = async {
        let (browser, mut tab) = cdp::Browser::launch(&chrome, dir.clone()).await?;
        let result = measure_page(&mut tab, &dir, &m).await;
        browser.close(tab).await;
        result
    };
    // Dropping the run on a timeout kills the browser and removes its profile.
    tokio::time::timeout(LAYOUT_LIMIT, run)
        .await
        .map_err(|_| "the browser took too long to lay out the page".to_owned())?
}

/// The longest a layout measurement may take, so a hung browser can't hold a
/// turn in [`browsers`] for good. It includes the page's settle time.
const LAYOUT_LIMIT: Duration = Duration::from_secs(30);

async fn measure_page(
    tab: &mut cdp::Tab,
    dir: &std::path::Path,
    m: &Measurement,
) -> Result<Vec<ElementBox>, String> {
    load(tab, dir, m).await?;
    let mut layout = measure(tab, &m.artboard, &[]).await?;
    let settle = m.settle.min(MAX_SETTLE);
    if layout.animated && !settle.is_zero() {
        tokio::time::sleep(settle).await;
        layout = measure(tab, &m.artboard, &[]).await?;
    }
    Ok(layout.nodes.iter().map(element_box).collect())
}

/// Opens a measurement's page at the artboard's size, once its images and
/// fonts have loaded.
async fn load(tab: &mut cdp::Tab, dir: &std::path::Path, m: &Measurement) -> Result<(), String> {
    tab.call("Page.enable", json!({})).await?;
    let path = dir.join("page.html");
    tokio::fs::write(&path, &m.html)
        .await
        .map_err(|e| e.to_string())?;
    tab.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": m.width.ceil() as u64,
            "height": m.height.ceil() as u64,
            "deviceScaleFactor": 1,
            "mobile": false,
        }),
    )
    .await?;
    tab.clear_events();
    let url = format!("file://{}", path.display());
    tab.call("Page.navigate", json!({ "url": url })).await?;
    tab.wait_for("Page.loadEventFired", LOAD).await?;
    tab.evaluate("document.fonts.ready.then(() => true)")
        .await?;
    Ok(())
}

/// How an artboard rendered, for an export to a format without CSS: every
/// element's and text node's box, from the artboard's top left corner, and
/// the computed styles in [`finite_transfer::scene::COMPUTED`]. A text node
/// has its parent's styles, and a box as tall as its lines' line height,
/// which is how a text layer is drawn. Elements without a box (`display: none`, or
/// inside one) are left out. It renders the page as [`layout`] does.
pub async fn scene(m: Measurement) -> Result<Scene, String> {
    let chrome = chrome().ok_or(
        "no Chrome, Chromium or Edge found to measure the page; set FINITE_CHROME to a browser binary",
    )?;
    let _turn = browsers()
        .acquire()
        .await
        .map_err(|_| "measuring is shutting down")?;
    let dir = std::env::temp_dir().join(format!("finite-scene-{}", random_id(10)));
    let (browser, mut tab) = cdp::Browser::launch(&chrome, dir.clone()).await?;
    let result = scene_page(&mut tab, &dir, &m).await;
    browser.close(tab).await;
    result
}

async fn scene_page(
    tab: &mut cdp::Tab,
    dir: &std::path::Path,
    m: &Measurement,
) -> Result<Scene, String> {
    load(tab, dir, m).await?;
    let mut raw = measure_scene(tab, m).await?;
    let settle = m.settle.min(MAX_SETTLE);
    if raw.animated && !settle.is_zero() {
        tokio::time::sleep(settle).await;
        raw = measure_scene(tab, m).await?;
    }
    let mut nodes = BTreeMap::new();
    for (id, x, y, width, height, style) in raw.elements {
        nodes.insert(
            id,
            Resolved {
                x,
                y,
                width,
                height,
                style,
            },
        );
    }
    for (id, parent, x, y, width, height) in raw.texts {
        let Some(style) = nodes.get(&parent).map(|p| p.style.clone()) else {
            continue;
        };
        nodes.insert(
            id,
            Resolved {
                x,
                y,
                width,
                height,
                style,
            },
        );
    }
    Ok(Scene { nodes })
}

/// Measures artboards for an export in headless Chrome, with [`scene`].
/// Codecs run on the blocking pool, so it waits on the runtime it was
/// made on from there. Calling it on a runtime thread panics.
pub struct ChromeMeasure(pub tokio::runtime::Handle);

impl Measure for ChromeMeasure {
    fn scene(&self, doc: &Document, artboard: &str) -> Result<Scene, finite_transfer::Error> {
        let m =
            plan_measurement(doc, artboard, Options::default()).map_err(finite_transfer::Error)?;
        self.0.block_on(scene(m)).map_err(finite_transfer::Error)
    }
}

/// What the page reports for a [`Scene`].
#[derive(serde::Deserialize)]
struct RawScene {
    elements: Vec<RawElement>,
    /// `[id, parent id, x, y, width, height]`.
    texts: Vec<(NodeId, NodeId, f64, f64, f64, f64)>,
    animated: bool,
}

/// `[id, x, y, width, height, styles]`.
type RawElement = (NodeId, f64, f64, f64, f64, BTreeMap<String, String>);

async fn measure_scene(tab: &mut cdp::Tab, m: &Measurement) -> Result<RawScene, String> {
    let board = serde_json::to_string(&m.artboard).expect("strings serialize");
    let props = serde_json::to_string(COMPUTED).expect("strings serialize");
    let texts = serde_json::to_string(&m.texts).expect("strings serialize");
    let script = format!(
        r#"(() => {{
  const board = document.querySelector(`[{VIEWER_ID_ATTR}="${{CSS.escape({board})}}"]`);
  const origin = board.getBoundingClientRect();
  const box = (r) => [r.left - origin.left, r.top - origin.top, r.width, r.height];
  const runs = new Map({texts});
  const elements = [];
  const texts = [];
  for (const el of [board, ...board.querySelectorAll(`[{VIEWER_ID_ATTR}]`)]) {{
    if (el !== board && !el.getClientRects().length) continue;
    const id = el.getAttribute("{VIEWER_ID_ATTR}");
    const computed = getComputedStyle(el);
    const style = {{}};
    for (const name of {props}) style[name] = computed.getPropertyValue(name);
    elements.push([id, ...box(el.getBoundingClientRect()), style]);
    const own = [...el.childNodes].filter((c) => c.nodeType === 3);
    const lineHeight = parseFloat(computed.lineHeight);
    for (const [text, k, start, end] of runs.get(id) || []) {{
      const node = own[k];
      if (!node || end > node.length) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      // Each line's box is its glyphs' height; widen it to the line height,
      // as a text layer is drawn.
      let ink = null;
      for (const r of range.getClientRects()) {{
        if (!r.width && !r.height) continue;
        const lead = lineHeight ? (lineHeight - r.height) / 2 : 0;
        const [l, t, rr, b] = [r.left, r.top - lead, r.right, r.bottom + lead];
        ink = ink ? [Math.min(ink[0], l), Math.min(ink[1], t), Math.max(ink[2], rr), Math.max(ink[3], b)] : [l, t, rr, b];
      }}
      if (!ink) continue;
      texts.push([text, id, ...box({{ left: ink[0], top: ink[1], width: ink[2] - ink[0], height: ink[3] - ink[1] }})]);
    }}
  }}
  return {{
    elements,
    texts,
    animated: document.scripts.length > 0 || document.getAnimations().length > 0,
  }};
}})()"#
    );
    let value = tab.evaluate(&script).await?;
    serde_json::from_value(value).map_err(|e| format!("couldn't measure the page: {e}"))
}

fn rect([x, y, width, height]: [f64; 4]) -> Rect {
    Rect::new(x, y, width, height)
}

/// Loads one artboard's page and takes its shots.
async fn render(
    tab: &mut cdp::Tab,
    path: &std::path::Path,
    page: &Page,
    options: &Options,
) -> Result<Vec<(usize, Result<Image, String>)>, String> {
    let requested = options.scale.clamp(MIN_SCALE, MAX_SCALE);
    // Chrome renders at least at device scale 1 here; smaller shots are
    // scaled down in the capture itself.
    let device_scale = requested.max(1.0);
    tab.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": page.width.ceil() as u64,
            "height": page.height.ceil() as u64,
            "deviceScaleFactor": device_scale,
            "mobile": false,
        }),
    )
    .await?;
    if options.transparent {
        tab.call(
            "Emulation.setDefaultBackgroundColorOverride",
            json!({ "color": { "r": 0, "g": 0, "b": 0, "a": 0 } }),
        )
        .await?;
    }
    tab.clear_events();
    let url = format!("file://{}", path.display());
    tab.call("Page.navigate", json!({ "url": url })).await?;
    // A slow image shouldn't stop the capture; it shows as not loaded.
    tab.wait_for("Page.loadEventFired", LOAD).await?;
    tab.evaluate("document.fonts.ready.then(() => true)")
        .await?;

    let ids: Vec<&str> = page.shots.iter().map(|s| s.element.as_str()).collect();
    let layout = measure(tab, &page.artboard, &ids).await?;
    let settle = options.settle.min(MAX_SETTLE);
    let settled = if layout.animated && !settle.is_zero() {
        tokio::time::sleep(settle).await;
        Some(settle)
    } else {
        None
    };
    // Scripts may have changed the layout while the page ran.
    let layout = if settled.is_some() {
        measure(tab, &page.artboard, &ids).await?
    } else {
        layout
    };

    let board = rect(layout.board);
    // Scroll sizes are in the artboard's own pixels; its box on the page
    // includes any transform, such as `scale(2)`.
    // A collapsed side (an auto-height artboard with only positioned children)
    // has no size to take the scale from, so it takes the other side's: a
    // `scale()` transform scales both alike. With neither, it's unscaled.
    let ratio = |boxed: f64, offset: f64| (offset >= 1.0).then(|| boxed / offset);
    let (scale_x, scale_y) = {
        let (x, y) = (
            ratio(board.width, layout.offset[0]),
            ratio(board.height, layout.offset[1]),
        );
        (x.or(y).unwrap_or(1.0), y.or(x).unwrap_or(1.0))
    };
    let overflow = Overflow {
        right: (layout.scroll[0] - layout.client[0]).max(0.0) * scale_x,
        bottom: (layout.scroll[1] - layout.client[1]).max(0.0) * scale_y,
    };
    // Revealed only now: an artboard that doesn't clip its content has no
    // scroll size to measure the overflow by.
    if options.reveal_overflow && overflow.any() {
        let css = format!(
            "{} {{ overflow: visible !important; }}",
            selector(&page.artboard)
        );
        set_style(tab, "finite-reveal-style", &css).await?;
    }
    // What can be captured: the artboard, or with its overflow revealed,
    // everything its content reaches.
    let visible = if options.reveal_overflow {
        Rect::new(
            board.x,
            board.y,
            board.width + overflow.right,
            board.height + overflow.bottom,
        )
    } else {
        board
    };

    let mut images = Vec::new();
    for planned in &page.shots {
        let image = shoot(
            tab,
            planned,
            &layout,
            board,
            visible,
            overflow,
            settled,
            page,
            options,
            requested,
            device_scale,
        )
        .await;
        images.push((planned.index, image));
    }
    Ok(images)
}

async fn measure(tab: &mut cdp::Tab, artboard: &str, ids: &[&str]) -> Result<Layout, String> {
    let ids = serde_json::to_string(ids).expect("strings serialize");
    let board = serde_json::to_string(artboard).expect("strings serialize");
    let script = format!(
        r#"(() => {{
  const find = (id) => document.querySelector(`[{VIEWER_ID_ATTR}="${{CSS.escape(id)}}"]`);
  const box = (el) => {{
    const r = el.getBoundingClientRect();
    return [r.x + scrollX, r.y + scrollY, r.width, r.height];
  }};
  // The untransformed border box. Computed sizes keep fractions, unlike
  // offsetWidth, but follow box-sizing, which an artboard may set.
  const borderBox = (el) => {{
    const s = getComputedStyle(el);
    const px = (...names) => names.reduce((sum, n) => sum + (parseFloat(s[n]) || 0), 0);
    const [w, h] = [px("width"), px("height")];
    if (s.boxSizing === "border-box") return [w, h];
    return [
      w + px("paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"),
      h + px("paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"),
    ];
  }};
  const board = find({board});
  const elements = {{}};
  for (const id of {ids}) {{
    const el = find(id);
    elements[id] = el ? box(el) : null;
  }}
  const nodes = [];
  for (const el of board.querySelectorAll(`[{VIEWER_ID_ATTR}]`)) {{
    const [x, y, w, h] = box(el);
    if (!w && !h) continue;
    let text = false;
    for (const c of el.childNodes) if (c.nodeType === 3 && c.textContent.trim()) text = true;
    const inline = getComputedStyle(el).display === "inline";
    const spill = text && !inline;
    // The union of the element's own text runs.
    let ink = null;
    if (text) {{
      const range = document.createRange();
      for (const c of el.childNodes) {{
        if (c.nodeType !== 3 || !c.textContent.trim()) continue;
        range.selectNodeContents(c);
        for (const r of range.getClientRects()) {{
          if (!r.width || !r.height) continue;
          const [l, t, rr, b] = [r.left + scrollX, r.top + scrollY, r.right + scrollX, r.bottom + scrollY];
          ink = ink ? [Math.min(ink[0], l), Math.min(ink[1], t), Math.max(ink[2], rr), Math.max(ink[3], b)] : [l, t, rr, b];
        }}
      }}
    }}
    nodes.push([el.getAttribute("{VIEWER_ID_ATTR}"), x, y, w, h,
      spill ? el.scrollWidth - el.clientWidth : 0, spill ? el.scrollHeight - el.clientHeight : 0, text,
      ink ? [ink[0], ink[1], ink[2] - ink[0], ink[3] - ink[1]] : null]);
  }}
  nodes.unshift([{board}, ...box(board), 0, 0, false, null]);
  return {{
    nodes,
    board: box(board),
    scroll: [board.scrollWidth, board.scrollHeight],
    client: [board.clientWidth, board.clientHeight],
    offset: borderBox(board),
    animated: document.scripts.length > 0 || document.getAnimations().length > 0,
    elements,
  }};
}})()"#
    );
    let value = tab.evaluate(&script).await?;
    serde_json::from_value(value).map_err(|e| format!("couldn't measure the page: {e}"))
}

#[allow(clippy::too_many_arguments)]
async fn shoot(
    tab: &mut cdp::Tab,
    planned: &PlannedShot,
    layout: &Layout,
    board: Rect,
    visible: Rect,
    overflow: Overflow,
    settled: Option<Duration>,
    page: &Page,
    options: &Options,
    requested: f64,
    device_scale: f64,
) -> Result<Image, String> {
    let shot = &planned.shot;
    let element = layout
        .elements
        .get(&planned.element)
        .copied()
        .flatten()
        .map(rect)
        .ok_or_else(|| format!("node {:?} isn't on the rendered page", shot.node))?;
    if element.width <= 0.0 && element.height <= 0.0 && shot.region.is_none() {
        return Err(format!(
            "node {:?} has no size on the page: it's hidden (display: none), empty, or collapsed",
            shot.node
        ));
    }
    let wanted = match shot.region {
        Some(region) => region.offset(element.x, element.y),
        // A whole artboard with its overflow revealed is everything its content reaches.
        None if planned.element == page.artboard => visible,
        None => element,
    }
    .grow(shot.padding);
    let area = wanted
        .intersect(&visible)
        .ok_or_else(|| {
            format!(
                "node {:?} lies outside the artboard{}, so there's nothing to capture",
                shot.node,
                if options.reveal_overflow {
                    " and its overflow"
                } else {
                    "; reveal the overflow to capture content past its edges"
                }
            )
        })?
        .snap();
    let cut_off = area.intersect(&wanted.snap()) != Some(wanted.snap());

    if options.transparent {
        // The shot's ancestors lose their backgrounds; a shot of the
        // artboard loses the artboard's too.
        let mut clear: Vec<&NodeId> = planned.ancestors.iter().collect();
        if planned.element == page.artboard {
            clear.push(&planned.element);
        }
        let css = if clear.is_empty() {
            String::new()
        } else {
            format!(
                "{} {{ background: transparent !important; }}",
                selectors(&clear)
            )
        };
        set_style(tab, SHOT_STYLE, &css).await?;
    }

    let scale = output_scale(area.width, area.height, requested);
    let (format, quality) = options.format.protocol();
    let mut params = json!({
        "format": format,
        "clip": {
            "x": area.x,
            "y": area.y,
            "width": area.width,
            "height": area.height,
            "scale": scale / device_scale,
        },
        "fromSurface": true,
        // Only overflow reaches past the viewport, which is the artboard's size.
        "captureBeyondViewport": area.right() > page.width || area.bottom() > page.height,
    });
    if let Some(quality) = quality {
        params["quality"] = json!(quality);
    }
    let result = tab.call("Page.captureScreenshot", params).await;
    if options.transparent {
        set_style(tab, SHOT_STYLE, "").await?;
    }
    let data = result?["data"]
        .as_str()
        .ok_or("the browser returned no image")?
        .to_owned();
    let data = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("the browser returned a broken image: {e}"))?;
    Ok(Image {
        data,
        mime: options.format.mime(),
        node: shot.node.clone(),
        artboard: page.artboard.clone(),
        element: planned.element.clone(),
        area: area.offset(-board.x, -board.y),
        bounds: element.offset(-board.x, -board.y),
        pixel_width: (area.width * scale).round() as u32,
        pixel_height: (area.height * scale).round() as u32,
        scale,
        requested_scale: requested,
        cut_off,
        overflow,
        overflow_shown: options.reveal_overflow,
        settled,
        boxes: (planned.element == page.artboard)
            .then(|| layout.nodes.iter().map(element_box).collect()),
    })
}

/// The `<style>` element holding CSS for one shot only.
const SHOT_STYLE: &str = "finite-shot-style";

/// Sets the text of the `<style>` with element id `id`, added at the end of
/// the page if it's not there, and waits for the page to render it.
async fn set_style(tab: &mut cdp::Tab, id: &str, css: &str) -> Result<(), String> {
    let id = serde_json::to_string(id).expect("strings serialize");
    let css = serde_json::to_string(css).expect("strings serialize");
    tab.evaluate(&format!(
        r#"(() => {{
  let style = document.getElementById({id});
  if (!style) {{
    style = document.createElement("style");
    style.id = {id};
    document.body.append(style);
  }}
  style.textContent = {css};
  return new Promise((done) => requestAnimationFrame(() => done(true)));
}})()"#
    ))
    .await
    .map(|_: Value| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshots_fit_the_api_image_limit() {
        // A desktop artboard at 2× fits.
        assert_eq!(output_scale(1440.0, 900.0, 2.0), 2.0);
        // A tall page doesn't, so it's captured smaller.
        let scale = output_scale(1440.0, 8000.0, 2.0);
        assert_eq!((8000.0 * scale).round(), MAX_OUTPUT_SIDE);
        assert_eq!((1440.0 * scale).round(), 540.0);
    }

    #[test]
    fn rectangles_overlap_and_snap() {
        let board = Rect::new(0.0, 0.0, 100.0, 100.0);
        let past = Rect::new(80.0, -10.0, 40.0, 40.0);
        assert_eq!(
            past.intersect(&board),
            Some(Rect::new(80.0, 0.0, 20.0, 30.0))
        );
        assert_eq!(Rect::new(200.0, 0.0, 10.0, 10.0).intersect(&board), None);
        assert_eq!(
            Rect::new(1.5, 2.25, 10.0, 10.0).snap(),
            Rect::new(1.0, 2.0, 11.0, 11.0)
        );
    }

    #[test]
    fn selectors_quote_ids() {
        assert_eq!(
            selector(r#"a"b\c"#),
            r#"html body [data-finite-id="a\"b\\c"]"#
        );
    }
}
