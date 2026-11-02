//! Blobs: images and other files a design refers to by the sha256 of their
//! bytes. A blob never changes, so a hash names the same bytes everywhere, and
//! the same file stored twice is stored once. See [`crate::store::Store::put_blob`].

use std::io;

pub use finite_design::import::{BlobHash, NotAHash};
pub use finite_transfer::assets::media_type;

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
}
