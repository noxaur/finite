//! A minimal ustar writer and reader, for a design folder as one file.
//!
//! Entries are regular files with fixed ownership, mode and time, so the
//! same design always writes the same bytes. The reader accepts what
//! `tar` and `bsdtar` write when you archive an edited folder: directory
//! entries, pax headers and macOS `._` sidecar files are skipped.

use crate::Error;

const BLOCK: usize = 512;

/// A file in an archive.
#[derive(Debug)]
pub struct Entry {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// `entries` as a tar archive. Paths must be ASCII and at most 100 bytes.
pub fn write(entries: &[Entry]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    for entry in entries {
        if !entry.path.is_ascii() || entry.path.len() > 100 {
            return Err(Error(format!(
                "{:?} can't be a tar path: use ASCII, at most 100 bytes",
                entry.path
            )));
        }
        let mut header = [0u8; BLOCK];
        header[..entry.path.len()].copy_from_slice(entry.path.as_bytes());
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", entry.bytes.len()).as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].fill(b' ');
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
        header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(&entry.bytes);
        out.resize(out.len().next_multiple_of(BLOCK), 0);
    }
    out.resize(out.len() + 2 * BLOCK, 0);
    Ok(out)
}

/// The files in a tar archive, in order.
pub fn read(bytes: &[u8]) -> Result<Vec<Entry>, Error> {
    let bad = |what: &str| Error(format!("this isn't a readable tar archive: {what}"));
    let long = || {
        bad(
            "it uses long file names (a pax or GNU extension), which a Finite folder doesn't need; repack it with `tar --format=ustar`",
        )
    };
    let mut entries = Vec::new();
    let mut at = 0;
    while at + BLOCK <= bytes.len() {
        let header = &bytes[at..at + BLOCK];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let field = |range: std::ops::Range<usize>| {
            let raw = &header[range];
            let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).into_owned()
        };
        let octal = |range: std::ops::Range<usize>| {
            u64::from_str_radix(field(range).trim(), 8).map_err(|_| bad("a header is damaged"))
        };
        let expected = octal(148..156)?;
        let sum: u64 = header
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    u64::from(*b)
                }
            })
            .sum();
        if sum != expected {
            return Err(bad("a header's checksum is wrong"));
        }
        let size = usize::try_from(octal(124..136)?).map_err(|_| bad("a file is too large"))?;
        let start = at + BLOCK;
        let end = start.checked_add(size).filter(|end| *end <= bytes.len());
        let end = end.ok_or_else(|| bad("it ends in the middle of a file"))?;
        let kind = header[156];
        let prefix = field(345..500);
        let name = field(0..100);
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        match kind {
            b'0' | 0 => entries.push(Entry {
                path,
                bytes: bytes[start..end].to_vec(),
            }),
            // Directories, and the pax headers that precede a file.
            b'5' | b'g' => {}
            // A pax header holds the next file's real name when it's too long
            // for the header, which would leave this reader with a cut-off name.
            b'x' if renames(&bytes[start..end]) => return Err(long()),
            b'x' => {}
            b'L' | b'K' => return Err(long()),
            other => {
                return Err(bad(&format!(
                    "{path:?} is a {:?} entry, and only files are allowed",
                    other as char
                )));
            }
        }
        at = end.next_multiple_of(BLOCK);
    }
    Ok(entries)
}

/// Whether a pax header's records give a file a different name or link
/// target. Each record is `<length> <key>=<value>\n`, the length counting
/// the whole record.
fn renames(mut records: &[u8]) -> bool {
    while let Some(space) = records.iter().position(|b| *b == b' ') {
        let length = std::str::from_utf8(&records[..space])
            .ok()
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| (space + 1..=records.len()).contains(n));
        let Some(length) = length else {
            return false;
        };
        let key = records[space + 1..length].split(|b| *b == b'=').next();
        if matches!(key, Some(b"path" | b"linkpath")) {
            return true;
        }
        records = &records[length..];
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_round_trip_and_the_bytes_are_stable() {
        let entries = [
            Entry {
                path: "finite.json".into(),
                bytes: b"{}".to_vec(),
            },
            Entry {
                path: "assets/big".into(),
                bytes: vec![7; 1000],
            },
        ];
        let tar = write(&entries).unwrap();
        assert_eq!(tar, write(&entries).unwrap());
        assert_eq!(tar.len() % BLOCK, 0);
        let back = read(&tar).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].path, "finite.json");
        assert_eq!(back[1].bytes, vec![7; 1000]);
    }

    #[test]
    fn damage_is_refused() {
        let mut tar = write(&[Entry {
            path: "a".into(),
            bytes: b"hi".to_vec(),
        }])
        .unwrap();
        assert!(read(&tar[..513]).is_err());
        tar[0] = b'b';
        assert!(read(&tar).unwrap_err().0.contains("checksum"));
        assert!(read(b"not a tar").unwrap().is_empty());
        let long = Entry {
            path: "x".repeat(101),
            bytes: Vec::new(),
        };
        assert!(write(&[long]).is_err());
    }
}
