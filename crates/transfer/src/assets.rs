//! References from a design to the files in its blob store.
//!
//! Inside a design, an image points at its blob with a URL the server
//! answers, `/api/designs/<design>/assets/<sha256>`. That URL names the
//! design, so it means nothing in a file. On the way out, a codec turns it
//! into `finite-asset:<sha256>`, and on the way in, [`crate::Imported::place`]
//! turns that back into a URL for the design it lands in.

use base64::{Engine, engine::general_purpose::STANDARD};
use finite_design::{html::Fragment, import::BlobHash};

use crate::{Blobs, Diagnostic, Error, Feature, Score};

/// How a file refers to a blob, followed by its hash.
pub const SCHEME: &str = "finite-asset:";

/// The URL a design's nodes use for blob `hash`.
pub fn url(design: &str, hash: &BlobHash) -> String {
    format!("/api/designs/{design}/assets/{hash}")
}

/// `value` with every blob URL, for any design, turned into [`SCHEME`]
/// references, and the hashes it found, in order.
pub fn portable(value: &str) -> (String, Vec<BlobHash>) {
    let mut found = Vec::new();
    let out = rewrite_urls(value, |hash| {
        found.push(hash.clone());
        Some(format!("{SCHEME}{hash}"))
    });
    (out, found)
}

/// `value` with each blob URL, for any design, replaced by what `f` returns
/// for its hash. A URL `f` returns `None` for stays as it is.
///
/// Only a whole URL counts: one that starts where a URL can, like after a
/// quote or `url(`. So `https://example.com/api/designs/…` is someone
/// else's server and stays as it is.
pub fn rewrite_urls(value: &str, mut f: impl FnMut(&BlobHash) -> Option<String>) -> String {
    const PREFIX: &str = "/api/designs/";
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find(PREFIX) {
        let before = rest[..at].chars().last().or_else(|| out.chars().last());
        let starts_url = is_url_start(before);
        out.push_str(&rest[..at]);
        let tail = &rest[at + PREFIX.len()..];
        if !starts_url {
            out.push_str(PREFIX);
            rest = tail;
            continue;
        }
        let matched = tail.split_once('/').and_then(|(design, after)| {
            let is_design = !design.is_empty()
                && design
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            let hex = after.strip_prefix("assets/")?.get(..64)?;
            let hash = BlobHash::parse(hex).ok().filter(|_| is_design)?;
            Some((hash, design.len() + "/assets/".len() + 64))
        });
        match matched.and_then(|(hash, len)| Some((f(&hash)?, len))) {
            Some((replacement, len)) => {
                out.push_str(&replacement);
                rest = &tail[len..];
            }
            None => {
                out.push_str(PREFIX);
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `text` with each stored file its URLs point to written inline as a
/// `data:` URL, since the URLs only work on this server. A file the store
/// doesn't have stays a URL and gets a diagnostic.
pub fn inline(text: &str, blobs: &dyn Blobs) -> Result<(String, Vec<Diagnostic>), Error> {
    let mut diagnostics = Vec::new();
    let mut failed = None;
    let text = rewrite_urls(text, |hash| match blobs.get(hash) {
        Ok(Some(bytes)) => Some(format!(
            "data:{};base64,{}",
            media_type(&bytes),
            STANDARD.encode(&bytes)
        )),
        Ok(None) => {
            diagnostics.push(Diagnostic {
                node: None,
                path: url("…", hash),
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
    match failed {
        Some(error) => Err(error),
        None => Ok((text, diagnostics)),
    }
}

/// Whether a URL can start right after `before`: at the start of a value,
/// after a quote or bracket, or after a space, a comma or an `=`.
fn is_url_start(before: Option<char>) -> bool {
    before.is_none_or(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '(' | ',' | '='))
}

/// The blobs `value` refers to with [`SCHEME`].
pub fn referenced(value: &str) -> Vec<BlobHash> {
    let mut found = Vec::new();
    let mut rest = value;
    while let Some(at) = rest.find(SCHEME) {
        rest = &rest[at + SCHEME.len()..];
        if let Some(hash) = rest.get(..64).and_then(|hex| BlobHash::parse(hex).ok()) {
            found.push(hash);
        }
    }
    found
}

/// `value` with each [`SCHEME`] reference turned into a URL for `design`.
pub fn resolve(value: &str, design: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find(SCHEME) {
        out.push_str(&rest[..at]);
        let tail = &rest[at + SCHEME.len()..];
        match tail.get(..64).and_then(|hex| BlobHash::parse(hex).ok()) {
            Some(hash) => {
                out.push_str(&url(design, &hash));
                rest = &tail[64..];
            }
            None => {
                out.push_str(SCHEME);
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Runs `f` on every value in `fragments` where blob references can be: an
/// attribute like `<img src>`, a style like `background-image`, and the
/// text of a `<style>` element.
pub fn for_each_value(fragments: &mut [Fragment], f: &mut impl FnMut(&mut String)) {
    for fragment in fragments {
        fragment.attrs.values_mut().for_each(&mut *f);
        fragment.styles.values_mut().for_each(&mut *f);
        if fragment.tag() == Some("style") {
            for child in &mut fragment.children {
                child.text.iter_mut().for_each(&mut *f);
            }
        }
        for_each_value(&mut fragment.children, f);
    }
}

/// The media type a blob is served as, from its first bytes. A blob has no
/// name or type of its own, and one that claims to be an image mustn't be
/// served as a page.
pub fn media_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if is_svg(bytes) {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

/// An SVG is text, so it has no magic bytes: it's XML-ish text, after an
/// optional byte order mark and spaces, that has an `<svg` tag near the top.
fn is_svg(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let bytes = &bytes[start..];
    let head = &bytes[..bytes.len().min(1024)];
    let lower = head.to_ascii_lowercase();
    let opens = [&b"<svg"[..], b"<?xml", b"<!--", b"<!doctype"];
    opens.iter().any(|open| lower.starts_with(open))
        && lower.windows(4).any(|window| window == b"<svg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_urls_become_portable_and_back() {
        let hash = BlobHash::of(b"png");
        let inside = format!("url(\"{}\") no-repeat", url("abc123", &hash));
        let (portable, found) = portable(&inside);
        assert_eq!(portable, format!("url(\"finite-asset:{hash}\") no-repeat"));
        assert_eq!(found, std::slice::from_ref(&hash));
        assert_eq!(referenced(&portable), std::slice::from_ref(&hash));
        assert_eq!(
            resolve(&portable, "new"),
            format!("url(\"{}\") no-repeat", url("new", &hash))
        );
    }

    #[test]
    fn other_urls_are_left_alone() {
        for value in [
            "https://example.com/a.png",
            "/api/designs/abc/thumbnail",
            "/api/designs/abc/assets/short",
            "finite-asset:nothex",
            "https://example.com/api/designs/abc/assets/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ] {
            assert_eq!(portable(value), (value.to_owned(), Vec::new()));
            assert_eq!(resolve(value, "d"), value);
        }
    }

    #[test]
    fn media_types_come_from_the_bytes() {
        let cases: [(&[u8], &str); 9] = [
            (b"\x89PNG\r\n\x1a\n....", "image/png"),
            (b"\xff\xd8\xff\xe0....", "image/jpeg"),
            (b"GIF89a....", "image/gif"),
            (b"RIFF\x10\0\0\0WEBPVP8 ", "image/webp"),
            (
                b"<svg xmlns='http://www.w3.org/2000/svg'/>",
                "image/svg+xml",
            ),
            (
                b"\xef\xbb\xbf \n<?xml version='1.0'?><svg/>",
                "image/svg+xml",
            ),
            (b"<html><svg></svg></html>", "application/octet-stream"),
            (b"RIFF\x10\0\0\0WAVEfmt ", "application/octet-stream"),
            (b"", "application/octet-stream"),
        ];
        for (bytes, expected) in cases {
            assert_eq!(media_type(bytes), expected, "{bytes:?}");
        }
    }
}
