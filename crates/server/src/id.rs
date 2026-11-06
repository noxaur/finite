//! Ids the server makes, and which ones it accepts. The shape new ids have is
//! in [`finite_design::id`].

/// Whether `id` could be a stored design's id: 1 to 64 ASCII letters, digits,
/// `-` or `_`. Ids arrive in URLs and become file names, so anything else is
/// refused. That is wider than [`finite_design::id::is_design_id`], which is
/// the shape [`random_id`] gives new designs, so designs stored under older ids
/// still open.
pub fn is_stored_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A short random id: lowercase letters and digits.
pub fn random_id(len: usize) -> String {
    const ALPHABET: &[u8] = finite_design::id::ALPHABET;
    let mut out = String::with_capacity(len);
    while out.len() < len {
        for byte in uuid::Uuid::new_v4().into_bytes() {
            if out.len() == len {
                break;
            }
            out.push(ALPHABET[byte as usize % ALPHABET.len()] as char);
        }
    }
    out
}

/// A random id of the shape nodes, pages and modes have
/// ([`finite_design::id`]). Pass it to `id::fresh` with a check for ids in use.
pub fn node_id() -> String {
    random_id(finite_design::id::LEN)
}
