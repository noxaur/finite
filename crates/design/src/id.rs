//! The shape of the ids that nodes, pages and modes get: lowercase letters
//! and digits, [`LEN`] of them.

/// The characters an id is made of.
pub const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// How many characters a node id has.
pub const LEN: usize = 8;

/// How many characters a design's id has.
pub const DESIGN_LEN: usize = 10;

/// Whether `text` is a design's id: [`DESIGN_LEN`] characters of [`ALPHABET`].
pub fn is_design_id(text: &str) -> bool {
    text.len() == DESIGN_LEN && text.bytes().all(|b| ALPHABET.contains(&b))
}

/// Whether `text` is a node id as [`LEN`] and [`ALPHABET`] make them. It has
/// at least one digit, so a word like `backdrop` isn't taken for one.
pub fn is_node_id(text: &str) -> bool {
    text.len() == LEN
        && text.bytes().all(|b| ALPHABET.contains(&b))
        && text.bytes().any(|b| b.is_ascii_digit())
}

/// The first id `make` returns that isn't `taken`.
pub fn fresh(make: &mut impl FnMut() -> String, taken: impl Fn(&str) -> bool) -> String {
    loop {
        let id = make();
        if !taken(&id) {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_ids_have_the_shape_and_a_digit() {
        assert!(is_node_id("k3x9a2bq"));
        assert!(!is_node_id("backdrop"));
        assert!(!is_node_id("k3x9a2b"));
        assert!(!is_node_id("K3x9a2bq"));
    }

    #[test]
    fn fresh_skips_taken_ids() {
        let mut n = 0;
        let id = fresh(
            &mut || {
                n += 1;
                format!("id{n}")
            },
            |id| id != "id3",
        );
        assert_eq!(id, "id3");
    }
}
