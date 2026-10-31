//! Fractional indexing: sibling order is a string key per node, so inserting or
//! moving a node rewrites only that node. Concurrent edits to different nodes
//! never conflict, which is what lets several actors reorder one parent at once.
//!
//! Keys are base-62 strings compared bytewise and never end in `0`, following
//! David Greenspan's "Implementing Fractional Indexing".

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(byte: u8) -> usize {
    DIGITS
        .iter()
        .position(|&d| d == byte)
        .expect("fractional index keys only contain base-62 digits")
}

/// Whether `key` can be used as a sibling index.
pub fn is_valid(key: &str) -> bool {
    !key.is_empty() && !key.ends_with('0') && key.bytes().all(|b| DIGITS.contains(&b))
}

/// Returns a key strictly between `a` and `b`. `a` must sort before `b`.
fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        // Copy the shared prefix, treating a missing digit in `a` as `0`.
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let da = a.first().map_or(0, |&c| digit(c));
    let db = b.map_or(DIGITS.len(), |b| digit(b[0]));
    if db - da > 1 {
        return vec![DIGITS[(da + db).div_ceil(2)]];
    }
    // Adjacent digits: extend `b`'s first digit if it has more, otherwise recurse into `a`.
    match b {
        Some(b) if b.len() > 1 => vec![b[0]],
        _ => {
            let mut out = vec![DIGITS[da]];
            out.extend(midpoint(a.get(1..).unwrap_or(&[]), None));
            out
        }
    }
}

/// A key that sorts after `a` (or first, if `None`) and before `b` (or last, if `None`).
pub fn key_between(a: Option<&str>, b: Option<&str>) -> String {
    if let (Some(a), Some(b)) = (a, b) {
        assert!(a < b, "key_between: {a:?} must sort before {b:?}");
    }
    let key = midpoint(a.unwrap_or("").as_bytes(), b.map(str::as_bytes));
    String::from_utf8(key).expect("digits are ASCII")
}

/// `n` ascending keys between `a` and `b`, bisected so key length grows with log(n).
pub fn keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let mid = key_between(a, b);
    let left_len = n / 2;
    let mut keys = keys_between(a, Some(&mid), left_len);
    let right = keys_between(Some(&mid), b, n - left_len - 1);
    keys.push(mid);
    keys.extend(right);
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_ordered_and_valid() {
        let keys = keys_between(None, None, 500);
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        assert!(keys.iter().all(|k| is_valid(k)));
        assert!(
            keys.iter().all(|k| k.len() <= 4),
            "bisection keeps keys short"
        );
    }

    #[test]
    fn repeated_inserts_between_neighbours() {
        let (mut lo, hi) = (key_between(None, None), key_between(None, None) + "V");
        for _ in 0..200 {
            let mid = key_between(Some(&lo), Some(&hi));
            assert!(lo < mid && mid < hi && is_valid(&mid));
            lo = mid;
        }
    }

    #[test]
    fn before_first_and_after_last() {
        let first = key_between(None, None);
        let before = key_between(None, Some(&first));
        let after = key_between(Some(&first), None);
        assert!(before < first && first < after);
        let edge = key_between(None, Some("01"));
        assert!(edge.as_str() < "01" && is_valid(&edge));
    }
}
