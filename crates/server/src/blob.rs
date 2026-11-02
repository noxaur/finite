//! Blobs: images and other files a design refers to by the sha256 of their
//! bytes. A blob never changes, so a hash names the same bytes everywhere, and
//! the same file stored twice is stored once. See [`crate::store::Store::put_blob`].

use std::io;

pub use finite_design::import::{BlobHash, NotAHash};

/// The largest blob a store accepts. A design holds many, and a viewer
/// downloads each one whole.
pub const MAX_BLOB: usize = 32 << 20;

/// The hash of `bytes`, or `InvalidInput` if they're over [`MAX_BLOB`]. Every
/// store calls this first in `put_blob`.
pub fn accept(bytes: &[u8]) -> io::Result<BlobHash> {
    if bytes.len() > MAX_BLOB {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a blob is at most {} MB", MAX_BLOB >> 20),
        ));
    }
    Ok(BlobHash::of(bytes))
}

/// The content type a blob is served as, from its first bytes. A blob has no
/// name or type of its own, and one that claims to be an image mustn't be
/// served as a page.
pub fn content_type(bytes: &[u8]) -> &'static str {
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
    fn hashes_are_sha256_in_lowercase_hex() {
        assert_eq!(
            BlobHash::of(b"").as_str(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            BlobHash::parse(BlobHash::of(b"abc").as_str()),
            Ok(BlobHash::of(b"abc"))
        );
    }

    #[test]
    fn only_a_full_lowercase_hash_parses() {
        let good = BlobHash::of(b"x").to_string();
        for bad in [
            "",
            "abc",
            "../../etc/passwd",
            &good.to_uppercase(),
            &good[1..],
            &format!("{good}0"),
            &format!("{}/", &good[1..]),
            &format!("{}é", &good[2..]),
        ] {
            assert_eq!(BlobHash::parse(bad), Err(NotAHash), "{bad:?}");
        }
    }

    #[test]
    fn big_blobs_are_refused() {
        assert!(accept(&vec![0; MAX_BLOB]).is_ok());
        let error = accept(&vec![0; MAX_BLOB + 1]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn content_types_come_from_the_bytes() {
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
            assert_eq!(content_type(bytes), expected, "{bytes:?}");
        }
    }
}
