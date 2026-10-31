//! Renders an artboard to PNG with a headless Chrome, so agents can check
//! their work visually.

use std::{path::PathBuf, process::Stdio, time::Duration};

use finite_design::{
    Document,
    edit::pixel_size,
    html::{self, BASE_CSS, CSP},
};
use tokio::process::Command;

use crate::hub::random_id;

/// Artboards without a pixel height are captured at this height.
const FALLBACK_HEIGHT: f64 = 900.0;
const MAX_SIDE: f64 = 8000.0;

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
pub fn page(doc: &Document, artboard: &str) -> Option<(String, f64, f64)> {
    let node = doc.get(artboard)?;
    // Compact, so no whitespace is added between elements: it renders like the viewer.
    let body = html::export_compact(doc, artboard)?;
    let (width, height) = pixel_size(node);
    let width = width.unwrap_or(1440.0).clamp(1.0, MAX_SIDE);
    let height = height.unwrap_or(FALLBACK_HEIGHT).clamp(1.0, MAX_SIDE);
    let page = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><style>{BASE_CSS} html, body {{ margin: 0; }}</style></head><body>{body}</body></html>"
    );
    Some((page, width, height))
}

/// Captures `page` at `width` × `height` CSS pixels, scaled by `scale`.
pub async fn capture(page: &str, width: f64, height: f64, scale: f64) -> Result<Vec<u8>, String> {
    let chrome = chrome().ok_or(
        "no Chrome, Chromium or Edge found for screenshots; set FINITE_CHROME to a browser binary",
    )?;
    let dir = std::env::temp_dir().join(format!("finite-shot-{}", random_id(10)));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let result = run(&chrome, &dir, page, width, height, scale).await;
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
) -> Result<Vec<u8>, String> {
    let html_path = dir.join("index.html");
    let png_path = dir.join("shot.png");
    tokio::fs::write(&html_path, page)
        .await
        .map_err(|e| e.to_string())?;
    let status = Command::new(chrome)
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
        .arg(format!("file://{}", html_path.display()))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    match tokio::time::timeout(Duration::from_secs(30), status).await {
        Err(_) => return Err("the browser took too long to render the screenshot".into()),
        Ok(Err(error)) => return Err(format!("couldn't start the browser: {error}")),
        Ok(Ok(_)) => {}
    }
    tokio::fs::read(&png_path)
        .await
        .map_err(|_| "the browser didn't produce a screenshot".to_string())
}
