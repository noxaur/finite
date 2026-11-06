//! Who makes a change. An actor id starts with what kind of actor it is, and
//! this module is the one place that knows the prefixes.

/// Identifies whoever made a change, with the prefix of its kind.
pub type ActorId = String;

/// The actor that commits [`crate::Design::migrate_css`]. Nobody undoes it.
pub const MIGRATION: &str = "finite";

/// An agent that named itself with a header: `agent:{name}`.
const AGENT: &str = "agent:";

/// An agent known only by its MCP session on this server. Sessions live in
/// memory, so such an agent never comes back once its session ends or the
/// server restarts.
const SESSION: &str = "mcp:";

/// A person, by the id their browser picked: `user:{id}`.
const USER: &str = "user:";

pub fn agent(name: &str) -> ActorId {
    format!("{AGENT}{name}")
}

pub fn session(id: &str) -> ActorId {
    format!("{SESSION}{id}")
}

pub fn user(id: &str) -> ActorId {
    format!("{USER}{id}")
}

/// Whether `id` is an agent's actor id, named or by session.
pub fn is_agent(id: &str) -> bool {
    id.starts_with(AGENT) || is_session(id)
}

/// Whether `id` is an agent known by its MCP session.
pub fn is_session(id: &str) -> bool {
    id.starts_with(SESSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_are_named_or_by_session() {
        assert!(is_agent(&agent("Claude")));
        assert!(is_agent(&session("s1")));
        assert!(is_session(&session("s1")));
        assert!(!is_session(&agent("Claude")));
        assert!(!is_agent(&user("1")));
        assert!(!is_agent(MIGRATION));
    }
}
