//! Limits on the short labels agents write: names and statuses that every
//! viewer shows. A longer label is cut, not refused, so a long name never
//! fails a tool call. Names people comment under have their own limit,
//! [`crate::comment::MAX_NAME`], which agents' display names share.

/// The longest layer name, in characters.
pub const LAYER_NAME: usize = 120;
/// The longest design name, in characters.
pub const DESIGN_NAME: usize = 120;
/// The longest "working on" status, in characters.
pub const STATUS: usize = 120;

/// `text` without surrounding whitespace, cut to `max` characters.
pub fn clip(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_by_characters_after_trimming() {
        assert_eq!(clip("  Header  ", 120), "Header");
        assert_eq!(clip("ééé", 2), "éé");
    }
}
