//! The document model from `finite-design`, compiled to WebAssembly for the
//! web viewer, so the browser applies ops and exports HTML with the same
//! Rust code as the server.
//!
//! The exports are a plain C ABI. The TypeScript side
//! (`apps/web/src/design/wasm.ts`) is hand-written and small, because every
//! call passes UTF-8 strings, mostly JSON:
//!
//! 1. JS asks for an input buffer of `n` bytes with [`input`], which returns
//!    its address in linear memory, and writes the arguments there.
//! 2. It calls a function with the arguments' byte lengths. A function that
//!    returns text writes it to the output buffer and returns its length.
//!    A negative length means an error, and the output holds the message.
//! 3. JS reads the result at [`output`] before the next call overwrites it.
//!
//! A replica is a handle: an index into a table of documents here.
//! `crates/wasm/build.mjs` builds this crate for `wasm32-unknown-unknown`.

mod replica;

use std::cell::RefCell;

use finite_design::html;
pub use replica::Replica;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static REPLICAS: RefCell<Vec<Option<Replica>>> = const { RefCell::new(Vec::new()) };
    /// The message of the last panic. A panic aborts, so JS reads it after
    /// the trap with [`panic_message`] and [`panic_message_len`].
    static PANIC: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Call once after instantiating: keeps panic messages for JS to read.
#[unsafe(no_mangle)]
pub extern "C" fn init() {
    std::panic::set_hook(Box::new(|info| {
        PANIC.with(|p| *p.borrow_mut() = info.to_string());
    }));
}

/// Makes the input buffer `len` bytes long, keeping what it holds, and
/// returns its address.
#[unsafe(no_mangle)]
pub extern "C" fn input(len: usize) -> *mut u8 {
    INPUT.with(|buffer| {
        let mut buffer = buffer.borrow_mut();
        buffer.resize(len, 0);
        buffer.as_mut_ptr()
    })
}

/// The address of the last result.
#[unsafe(no_mangle)]
pub extern "C" fn output() -> *const u8 {
    OUTPUT.with(|buffer| buffer.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn panic_message() -> *const u8 {
    PANIC.with(|p| p.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn panic_message_len() -> usize {
    PANIC.with(|p| p.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_new() -> u32 {
    REPLICAS.with(|table| {
        let mut table = table.borrow_mut();
        let slot = table.iter().position(Option::is_none).unwrap_or_else(|| {
            table.push(None);
            table.len() - 1
        });
        table[slot] = Some(Replica::default());
        slot as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_free(handle: u32) {
    REPLICAS.with(|table| {
        if let Some(slot) = table.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// [`Replica::load`] with the nodes JSON in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_load(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.load(text(input, 0, len)?))
    })
}

/// [`Replica::apply`] with the ops JSON in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_apply(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.apply(text(input, 0, len)?))
    })
}

/// [`Replica::export`] for the node id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_export(handle: u32, len: usize, ids: u32) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.export(text(input, 0, len)?, ids != 0)))
    })
}

/// [`Replica::pages`].
#[unsafe(no_mangle)]
pub extern "C" fn replica_pages(handle: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.pages()))
}

/// [`Replica::expand`] for the instance id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_expand(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.expand(text(input, 0, len)?)))
    })
}

/// [`Replica::take_dirty`].
#[unsafe(no_mangle)]
pub extern "C" fn replica_take_dirty(handle: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.take_dirty()))
}

/// [`Replica::set_client`] with the client id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_set_client(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| {
            replica.set_client(text(input, 0, len)?);
            Ok(String::new())
        })
    })
}

/// [`Replica::draft`] for mutation id `seed`, with the edits JSON (or
/// `null`) in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_draft(handle: u32, seed: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.draft(seed.into(), text(input, 0, len)?))
    })
}

/// [`Replica::propose`] for mutation `mid`, with the edits JSON in the
/// first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_propose(handle: u32, mid: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.propose(mid.into(), text(input, 0, len)?))
    })
}

/// [`Replica::receive`] with the ops JSON in the first `len` input bytes.
/// `mine` is the tab's mutation id for the change, or 0 when it isn't the
/// tab's own (mutation ids start at 1).
#[unsafe(no_mangle)]
pub extern "C" fn replica_receive(handle: u32, len: usize, mine: u32) -> i32 {
    with_replica(handle, |replica| {
        let mine = (mine != 0).then_some(mine.into());
        with_input(|input| replica.receive(text(input, 0, len)?, mine))
    })
}

/// [`Replica::settle`].
#[unsafe(no_mangle)]
pub extern "C" fn replica_settle(handle: u32, mid: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.settle(mid.into())))
}

/// [`Replica::has_local`], as 1 or 0. Not a handle error: a freed replica has none.
#[unsafe(no_mangle)]
pub extern "C" fn replica_has_local(handle: u32) -> u32 {
    REPLICAS.with(|table| {
        table
            .borrow()
            .get(handle as usize)
            .and_then(Option::as_ref)
            .is_some_and(Replica::has_local)
            .into()
    })
}

/// [`Replica::component_info`] for the node id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_component_info(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.component_info(text(input, 0, len)?)))
    })
}

/// [`html::is_safe_attr`] for a name in the first `name_len` input bytes
/// and a value in the `value_len` bytes after it. Returns 1 or 0.
#[unsafe(no_mangle)]
pub extern "C" fn is_safe_attr(name_len: usize, value_len: usize) -> u32 {
    with_input(
        |input| match (text(input, 0, name_len), text(input, name_len, value_len)) {
            (Ok(name), Ok(value)) => html::is_safe_attr(name, value) as u32,
            _ => 0,
        },
    )
}

/// [`html::shared_style`] for the CSS in the first `len` input bytes, for a
/// shadow root when `shadow` is 1.
#[unsafe(no_mangle)]
pub extern "C" fn shared_style(len: usize, shadow: u32) -> i32 {
    respond(with_input(|input| {
        Ok(html::shared_style(text(input, 0, len)?, shadow != 0))
    }))
}

/// [`html::BASE_CSS`], the styles every artboard renders with.
#[unsafe(no_mangle)]
pub extern "C" fn base_css() -> i32 {
    respond(Ok(html::BASE_CSS.to_owned()))
}

/// [`html::CSP`], the content policy for artboards that run scripts.
#[unsafe(no_mangle)]
pub extern "C" fn csp() -> i32 {
    respond(Ok(html::CSP.to_owned()))
}

fn with_input<T>(f: impl FnOnce(&[u8]) -> T) -> T {
    INPUT.with(|buffer| f(&buffer.borrow()))
}

/// The input bytes at `start..start + len`, as text.
fn text(input: &[u8], start: usize, len: usize) -> Result<&str, String> {
    let bytes = input
        .get(start..start + len)
        .ok_or("the argument is outside the input buffer")?;
    std::str::from_utf8(bytes).map_err(|e| e.to_string())
}

fn with_replica(handle: u32, f: impl FnOnce(&mut Replica) -> Result<String, String>) -> i32 {
    let result = REPLICAS.with(|table| {
        match table
            .borrow_mut()
            .get_mut(handle as usize)
            .and_then(Option::as_mut)
        {
            Some(replica) => f(replica),
            None => Err(format!("no replica {handle}")),
        }
    });
    respond(result)
}

/// Puts a result in the output buffer. Returns its length, negated for an error.
fn respond(result: Result<String, String>) -> i32 {
    let (text, ok) = match result {
        Ok(text) => (text, true),
        Err(message) => (message, false),
    };
    let len = text.len() as i32;
    OUTPUT.with(|buffer| *buffer.borrow_mut() = text.into_bytes());
    if ok { len } else { -len.max(1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes `args` to the input buffer one after another, as the
    /// TypeScript side does, and returns their byte lengths.
    fn put(args: &[&str]) -> Vec<usize> {
        let bytes = args.concat().into_bytes();
        let ptr = input(bytes.len());
        // SAFETY: `input` returned a buffer of exactly `bytes.len()` bytes.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
        args.iter().map(|a| a.len()).collect()
    }

    /// Reads a function's result the way the TypeScript side does.
    fn result(n: i32) -> Result<String, String> {
        let text = OUTPUT.with(|o| String::from_utf8(o.borrow().clone()).unwrap());
        if n >= 0 {
            assert_eq!(n as usize, text.len());
            Ok(text)
        } else {
            Err(text)
        }
    }

    #[test]
    fn a_replica_round_trips_through_the_abi() {
        let h = replica_new();
        let nodes = r#"[{"id":"a","parent":null,"index":"V","type":"element","tag":"p"},{"id":"t","parent":"a","index":"V","type":"text","text":"Grüße 👋"}]"#;
        assert!(result(replica_load(h, put(&[nodes])[0])).is_ok());
        let html = result(replica_export(h, put(&["a"])[0], 0));
        assert_eq!(html.unwrap(), "<p>Grüße 👋</p>");
        let ops = r#"[{"op":"set","id":"t","key":"text","value":"Hej"}]"#;
        let applied = result(replica_apply(h, put(&[ops])[0])).unwrap();
        assert!(applied.contains(r#""text":"Hej""#), "{applied}");
        replica_free(h);
        let gone = result(replica_export(h, put(&["a"])[0], 0));
        assert_eq!(gone, Err(format!("no replica {h}")));
        // The freed slot is reused.
        assert_eq!(replica_new(), h);
    }

    #[test]
    fn errors_come_back_as_messages() {
        let h = replica_new();
        let err = result(replica_apply(h, put(&["not json"])[0])).unwrap_err();
        assert!(err.contains("expected"), "{err}");
    }

    #[test]
    fn attribute_checks_read_two_arguments() {
        let safe = |name: &str, value: &str| {
            let lens = put(&[name, value]);
            is_safe_attr(lens[0], lens[1]) == 1
        };
        assert!(safe("href", "https://example.com"));
        assert!(!safe("href", "java\tscript:alert(1)"));
        assert!(!safe("onclick", "x"));
    }
}
