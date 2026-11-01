//! Renders an artboard to PNG with a headless Chrome, so agents can check
//! their work visually.

use std::{path::PathBuf, process::Stdio, time::Duration};

use finite_design::{
    Document,
    edit::pixel_size,
    html::{self, BASE_CSS, BASE_LAYER, CSP},
};
use tokio::process::Command;

use crate::hub::random_id;

/// Artboards without a pixel height are captured at this height.
const FALLBACK_HEIGHT: f64 = 900.0;
const MAX_SIDE: f64 = 8000.0;
/// The longest side of a screenshot, in image pixels. The Claude API refuses
/// images over 8,000 pixels on a side, and once a request holds more than 20
/// images, a stricter limit applies to all of them. An agent checking its work
/// passes 20 screenshots quickly, and Anthropic's docs suggest at most 3,000
/// pixels a side to stay under that limit everywhere.
pub const MAX_OUTPUT_SIDE: f64 = 3000.0;

/// The device scale to capture `width` × `height` CSS pixels at: `requested`,
/// lowered if needed so the image's longer side fits in [`MAX_OUTPUT_SIDE`].
pub fn output_scale(width: f64, height: f64, requested: f64) -> f64 {
    requested.min(MAX_OUTPUT_SIDE / width.max(height))
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
    if let Some(path) = std::env::var_os("FINITE_CHROME") {
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

/// A standalone HTML page showing just the artboard, and its pixel size.
/// Every element carries its node id, and a script measures them just before
/// the capture, so [`capture`] can report the layout too. The design's
/// shared CSS comes after the base CSS, in a layer the artboard's own
/// styles override (see [`html::shared_style`]), as in the viewer.
pub fn page(doc: &Document, artboard: &str) -> Option<(String, f64, f64)> {
    let node = doc.get(artboard)?;
    // Compact, so no whitespace is added between elements: it renders like the
    // viewer, which marks elements the same way.
    let body = html::export_for_viewer(doc, artboard)?;
    let (width, height) = pixel_size(node);
    let width = width.unwrap_or(1440.0).clamp(1.0, MAX_SIDE);
    let height = height.unwrap_or(FALLBACK_HEIGHT).clamp(1.0, MAX_SIDE);
    let shared = doc.css().map_or(String::new(), |css| {
        format!("<style>{}</style>", html::shared_style(css, false))
    });
    let page = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><style>@layer {BASE_LAYER} {{ {BASE_CSS} html, body {{ margin: 0; }} }}</style>{shared}</head><body>{body}{MEASURE}</body></html>"
    );
    Some((page, width, height))
}

/// Measures every element 2.5 seconds after load, half a second before the
/// capture, and leaves the boxes in the DOM for `--dump-dom` to print. Each
/// box is `[id, left, top, width, height, overflowX, overflowY]`; the overflow
/// is how far an element's own text runs past its box, for elements with text.
const MEASURE: &str = r#"<script>setTimeout(function(){var out=[];document.querySelectorAll("[data-finite-id]").forEach(function(e){var r=e.getBoundingClientRect();if(!r.width&&!r.height)return;var text=false;e.childNodes.forEach(function(c){if(c.nodeType===3&&c.textContent.trim())text=true});var inline=getComputedStyle(e).display==="inline";var ox=text&&!inline?e.scrollWidth-e.clientWidth:0,oy=text&&!inline?e.scrollHeight-e.clientHeight:0;out.push([e.getAttribute("data-finite-id"),Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height),ox,oy])});var s=document.createElement("script");s.type="application/json";s.id="__finite_layout";s.textContent=JSON.stringify(out);document.body.appendChild(s)},2500)</script>"#;

/// Where an element rendered, in CSS pixels from the page's top left corner.
#[derive(Clone, Debug, PartialEq)]
pub struct Box {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// How far the element's own text runs past its box, across and down.
    pub text_overflow: (f64, f64),
}

/// What a capture produced: the PNG, and the rendered boxes when the page
/// could be measured.
pub struct Capture {
    pub png: Vec<u8>,
    pub boxes: Option<Vec<Box>>,
}

/// The boxes [`MEASURE`] left in the DOM that Chrome printed.
fn boxes_from_dom(dom: &str) -> Option<Vec<Box>> {
    let start = dom.find("id=\"__finite_layout\">")? + "id=\"__finite_layout\">".len();
    let end = start + dom[start..].find("</script>")?;
    type Raw = (String, f64, f64, f64, f64, f64, f64);
    let raw: Vec<Raw> = serde_json::from_str(&dom[start..end]).ok()?;
    Some(
        raw.into_iter()
            .map(|(id, x, y, width, height, ox, oy)| Box {
                id,
                x,
                y,
                width,
                height,
                text_overflow: (ox, oy),
            })
            .collect(),
    )
}

/// The smallest device scale Chrome renders at.
const MIN_DEVICE_SCALE: f64 = 0.5;

/// `page` with `html { zoom: scale }` added right after its doctype, so the
/// page stays in standards mode.
fn zoom(page: &str, scale: f64) -> String {
    let style = format!("<style>html {{ zoom: {scale}; }}</style>");
    let doctype = "<!doctype html>";
    match page.get(..doctype.len()) {
        Some(start) if start.eq_ignore_ascii_case(doctype) => {
            format!("{doctype}{style}{}", &page[doctype.len()..])
        }
        _ => format!("{style}{page}"),
    }
}

/// Captures `page` at `width` × `height` CSS pixels, scaled by `scale`.
/// Boxes are measured only at a device scale, not when the page is zoomed to
/// get below one, because zoom changes what the page measures.
pub async fn capture(page: &str, width: f64, height: f64, scale: f64) -> Result<Capture, String> {
    let chrome = chrome().ok_or(
        "no Chrome, Chromium or Edge found for screenshots; set FINITE_CHROME to a browser binary",
    )?;
    let _turn = browsers()
        .acquire()
        .await
        .map_err(|_| "screenshots are shutting down")?;
    let dir = std::env::temp_dir().join(format!("finite-shot-{}", random_id(10)));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    // Chrome doesn't go below 0.5 for --force-device-scale-factor: asked
    // for 0.375, it rendered at 0.5. So below that, render at 1 and shrink
    // the page itself with CSS zoom, in a window of the scaled size.
    let result = if scale < MIN_DEVICE_SCALE {
        let zoomed = zoom(page, scale);
        run(&chrome, &dir, &zoomed, width * scale, height * scale, 1.0)
            .await
            .map(|(png, _)| Capture { png, boxes: None })
    } else {
        run(&chrome, &dir, page, width, height, scale)
            .await
            .map(|(png, dom)| Capture {
                png,
                boxes: boxes_from_dom(&dom),
            })
    };
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}

async fn run(
    chrome: &PathBuf,
    dir: &std::path::Path,
    page: &str,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(Vec<u8>, String), String> {
    let html_path = dir.join("index.html");
    let png_path = dir.join("shot.png");
    tokio::fs::write(&html_path, page)
        .await
        .map_err(|e| e.to_string())?;
    let output = Command::new(chrome)
        .arg("--headless")
        .arg("--disable-gpu")
        .arg("--hide-scrollbars")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--mute-audio")
        .arg(format!("--user-data-dir={}", dir.join("profile").display()))
        .arg(format!("--window-size={},{}", width.ceil(), height.ceil()))
        .arg(format!("--force-device-scale-factor={scale}"))
        .arg("--virtual-time-budget=3000")
        .arg(format!("--screenshot={}", png_path.display()))
        // Prints the DOM as it was at the capture, with MEASURE's boxes.
        .arg("--dump-dom")
        .arg(format!("file://{}", html_path.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let dom = match tokio::time::timeout(Duration::from_secs(30), output).await {
        Err(_) => return Err("the browser took too long to render the screenshot".into()),
        Ok(Err(error)) => return Err(format!("couldn't start the browser: {error}")),
        Ok(Ok(output)) => String::from_utf8_lossy(&output.stdout).into_owned(),
    };
    let png = tokio::fs::read(&png_path)
        .await
        .map_err(|_| "the browser didn't produce a screenshot".to_string())?;
    Ok((png, dom))
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
}
