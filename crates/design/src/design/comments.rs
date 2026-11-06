//! The comments on a design: threads, pins, and which agent a comment waits for.

use std::collections::{BTreeSet, HashSet};

use crate::{
    NodeId,
    comment::{
        self, Anchor, Audience, Author, AuthorKind, ChangeLog, ChangeRef, Comment, CommentError,
        Message, Point,
    },
    document::Document,
};

use super::Design;

impl Design {
    /// Comments a change has updated since the last call, so the server can
    /// send them to viewers and save them.
    pub fn take_comment_updates(&mut self) -> Vec<Comment> {
        let ids = std::mem::take(&mut self.comment_updates);
        self.comments
            .iter()
            .filter(|c| ids.contains(&c.id))
            .cloned()
            .collect()
    }

    pub fn comments(&self) -> &[Comment] {
        &self.comments
    }

    /// Pins a new comment for `audience`, with `body` as its first message.
    /// `new_id` must return a fresh random id; it's called again if the id is taken.
    pub fn add_comment(
        &mut self,
        author: Author,
        anchor: Anchor,
        audience: Audience,
        body: &str,
        new_id: &mut impl FnMut() -> String,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let body = comment::check_body(body)?;
        comment::check_anchor(self.view(), &anchor)?;
        let audience = comment::check_audience(audience)?;
        self.check_room_to_open()?;
        let id = crate::id::fresh(new_id, |id| self.comments.iter().any(|c| c.id == id));
        self.comments.push(Comment {
            id,
            artboard_id: anchor.artboard_id,
            node_id: anchor.node_id,
            extra_node_ids: anchor.extra_node_ids,
            x: anchor.x,
            y: anchor.y,
            resolved: false,
            resolved_at: None,
            created_at: now,
            messages: vec![Message {
                author,
                body,
                at: now,
                seq: self.seq,
                changes: Vec::new(),
                edited_at: None,
            }],
            detached_at: None,
            rev: 0,
            audience,
            passed_by: Vec::new(),
            taken_by: None,
        });
        Ok(self.comments.last().expect("just pushed"))
    }

    /// Adds a reply to comment `id`. See [`crate::comment`] for how replies
    /// link changes and change the resolved state. `resolve` sets the state
    /// explicitly. A person's reply clears the passes, and an agent's reply
    /// makes the thread that agent's.
    pub fn reply(
        &mut self,
        id: &str,
        author: Author,
        body: &str,
        resolve: Option<bool>,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let body = comment::check_body(body)?;
        let room_to_open = self.check_room_to_open();
        let index = self
            .comments
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| CommentError::NotFound(id.into()))?;
        if self.comments[index].messages.len() >= comment::MAX_MESSAGES {
            return Err(CommentError::ThreadFull);
        }
        let resolved =
            resolve.unwrap_or(self.comments[index].resolved && author.kind == AuthorKind::Agent);
        if self.comments[index].resolved && !resolved {
            room_to_open?;
        }
        let changes = match author.kind {
            AuthorKind::Agent => changes_for_reply(&self.comments, &self.log, index, &author.id),
            AuthorKind::User => Vec::new(),
        };
        let comment = &mut self.comments[index];
        match author.kind {
            AuthorKind::Agent => comment.taken_by = Some(author.clone()),
            AuthorKind::User => comment.passed_by.clear(),
        }
        mark_resolved(comment, resolved, now);
        comment.messages.push(Message {
            author,
            body,
            at: now,
            seq: self.seq,
            changes,
            edited_at: None,
        });
        comment.rev += 1;
        Ok(comment)
    }

    pub fn set_resolved(
        &mut self,
        id: &str,
        resolved: bool,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let room_to_open = self.check_room_to_open();
        let comment = find(&mut self.comments, id)?;
        if comment.resolved && !resolved {
            room_to_open?;
        }
        mark_resolved(comment, resolved, now);
        comment.rev += 1;
        Ok(comment)
    }

    /// Replaces the body of comment `id`'s newest message, which must be by
    /// `author_id`. A person's edit clears the passes, since the request changed.
    pub fn edit_message(
        &mut self,
        id: &str,
        author_id: &str,
        body: &str,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let body = comment::check_body(body)?;
        let comment = find(&mut self.comments, id)?;
        let message = comment
            .messages
            .last_mut()
            .filter(|m| m.author.id == author_id)
            .ok_or(CommentError::NotEditable)?;
        message.body = body;
        message.edited_at = Some(now);
        if message.author.kind == AuthorKind::User {
            comment.passed_by.clear();
        }
        comment.rev += 1;
        Ok(comment)
    }

    /// Pins comment `id` to `node`, an artboard or an element inside one,
    /// when the one it was pinned to is gone (a screen that was removed and
    /// rebuilt). The pin keeps its offset from the artboard's top-left corner,
    /// held inside the artboard, and the comment's other elements are dropped.
    pub fn repin(&mut self, id: &str, node: &str) -> Result<&Comment, CommentError> {
        let (board, origin, size) = {
            let doc = self.view();
            let board = doc
                .artboard_of(node)
                .ok_or_else(|| CommentError::NodeNotFound(node.into()))?;
            (
                board.id.clone(),
                (board.x.unwrap_or(0.0), board.y.unwrap_or(0.0)),
                crate::edit::pixel_size(board),
            )
        };
        let comment = find(&mut self.comments, id)?;
        if comment.artboard_id.is_none() {
            // A canvas pin's x and y are canvas coordinates.
            comment.x -= origin.0;
            comment.y -= origin.1;
        }
        let inside = |at: f64, extent: Option<f64>| at.clamp(0.0, extent.unwrap_or(f64::MAX));
        comment.x = inside(comment.x, size.0);
        comment.y = inside(comment.y, size.1);
        comment.node_id = (node != board).then(|| node.to_owned());
        comment.artboard_id = Some(board);
        comment.extra_node_ids.clear();
        comment.detached_at = None;
        comment.rev += 1;
        Ok(comment)
    }

    /// Changes who comment `id` is for, open or resolved, and clears the
    /// passes and who took it. The same audience again changes nothing.
    pub fn set_audience(&mut self, id: &str, audience: Audience) -> Result<&Comment, CommentError> {
        let audience = comment::check_audience(audience)?;
        let comment = find(&mut self.comments, id)?;
        if comment.audience != audience {
            comment.audience = audience;
            comment.passed_by.clear();
            comment.taken_by = None;
            comment.rev += 1;
        }
        Ok(comment)
    }

    /// The agent comment `comment` goes to, given which agents are
    /// `listening`. See [`Comment::routed_to`].
    pub fn routed_to<'a>(
        &'a self,
        comment: &'a Comment,
        listening: impl Fn(&str) -> bool,
    ) -> Option<&'a str> {
        let editor = comment
            .artboard_id
            .as_deref()
            .and_then(|board| self.log.last_agent_on(board));
        comment.routed_to(editor, listening)
    }

    /// Whether `agent` should act on `comment` now: it's waiting, `agent`
    /// hasn't passed on it, and it goes to `agent` or to whoever asks first.
    pub fn awaits(&self, comment: &Comment, agent: &str, listening: impl Fn(&str) -> bool) -> bool {
        comment.waiting()
            && !comment.passed(agent)
            && self
                .routed_to(comment, listening)
                .is_none_or(|to| to == agent)
    }

    /// `agent` takes comment `id` to work on, so it goes to that agent until
    /// it passes or stops listening. Check [`Design::awaits`] first.
    pub fn take(&mut self, id: &str, agent: Author) -> Result<&Comment, CommentError> {
        let comment = find(&mut self.comments, id)?;
        if comment.taken_by.as_ref().is_none_or(|a| a.id != agent.id) {
            comment.taken_by = Some(agent);
            comment.rev += 1;
        }
        Ok(comment)
    }

    /// `agent` steps back from comment `id`, so it goes to another agent and
    /// stops waking `agent` until a person writes in it again. Passing on a
    /// comment that isn't waiting changes nothing.
    pub fn pass(&mut self, id: &str, agent: Author) -> Result<&Comment, CommentError> {
        let comment = find(&mut self.comments, id)?;
        if comment.waiting() && !comment.passed(&agent.id) {
            if comment.taken_by.as_ref().is_some_and(|a| a.id == agent.id) {
                comment.taken_by = None;
            }
            comment.passed_by.push(agent);
            comment.rev += 1;
        }
        Ok(comment)
    }

    pub fn delete_comment(&mut self, id: &str) -> Result<(), CommentError> {
        let index = self
            .comments
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| CommentError::NotFound(id.into()))?;
        self.comments.remove(index);
        Ok(())
    }
}

/// Edits `actor` made on this comment's artboard that a reply should link.
///
/// The window opens after the thread's latest message. An edit already
/// linked to any message is skipped, and each edit (one change `seq`) is
/// linked once.
pub(super) fn changes_for_reply(
    comments: &[Comment],
    log: &ChangeLog,
    index: usize,
    actor: &str,
) -> Vec<ChangeRef> {
    let comment = &comments[index];
    let mut seen: HashSet<u64> = comments
        .iter()
        .flat_map(|c| &c.messages)
        .flat_map(|m| &m.changes)
        .map(|c| c.seq)
        .collect();
    log.since(actor, comment.last_seq(), comment.artboard_id.as_deref())
        .into_iter()
        .filter(|change| seen.insert(change.seq))
        .collect()
}

/// Sets the resolved state, and when it went to resolved.
pub(super) fn mark_resolved(comment: &mut Comment, resolved: bool, now: u64) {
    if resolved && !comment.resolved {
        comment.resolved_at = Some(now);
    }
    comment.resolved = resolved;
}

impl Design {
    /// Refuses another open comment, new or reopened, past [`comment::MAX_OPEN`].
    fn check_room_to_open(&self) -> Result<(), CommentError> {
        let open = self.comments.iter().filter(|c| !c.resolved).count();
        if open >= comment::MAX_OPEN {
            return Err(CommentError::TooManyOpen);
        }
        Ok(())
    }
}

/// Canvas positions of the given artboards, before a change applies.
pub(super) fn board_places(doc: &Document, boards: &BTreeSet<NodeId>) -> Vec<(NodeId, Point)> {
    boards
        .iter()
        .filter_map(|id| doc.get(id))
        .filter(|board| board.is_artboard())
        .map(|board| {
            let at = Point {
                x: board.x.unwrap_or(0.0),
                y: board.y.unwrap_or(0.0),
            };
            (board.id.clone(), at)
        })
        .collect()
}

/// After a change: pins whose artboard is gone stay where they were on the
/// canvas, and pins whose artboard came back (by undo, say) follow it again.
/// The ids of comments it changes go on `updates`.
pub(super) fn reattach(
    doc: &Document,
    comments: &mut [Comment],
    updates: &mut Vec<String>,
    places: &[(NodeId, Point)],
) {
    for comment in comments {
        let Some(board_id) = comment.artboard_id.as_deref() else {
            continue;
        };
        let on_canvas = doc.get(board_id).is_some_and(|n| n.is_artboard());
        let detached = match (on_canvas, comment.detached_at) {
            (true, Some(_)) => None,
            (false, None) => match places.iter().find(|(id, _)| id == board_id) {
                Some((_, at)) => Some(Point {
                    x: at.x + comment.x,
                    y: at.y + comment.y,
                }),
                None => continue,
            },
            _ => continue,
        };
        comment.detached_at = detached;
        comment.rev += 1;
        updates.push(comment.id.clone());
    }
}

pub(super) fn find<'a>(
    comments: &'a mut [Comment],
    id: &str,
) -> Result<&'a mut Comment, CommentError> {
    comments
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| CommentError::NotFound(id.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::tests::{author, color, create, design, pin};
    use crate::{Node, Op, Record};

    #[test]
    fn agent_reply_links_its_changes_and_resolves() {
        let mut d = design();
        d.commit(
            "agent",
            "boards",
            &[create("a", None), create("b", None)],
            1,
        );
        let id = pin(&mut d, "a");

        // Only the agent's change to the comment's artboard, made after the comment, is linked.
        d.commit("agent", "b red", &[color("b", "red")], 2);
        d.commit("other", "a blue", &[color("a", "blue")], 3);
        d.commit("agent", "a red", &[color("a", "red")], 4);
        let agent = author("agent", AuthorKind::Agent);
        let replied = d.reply(&id, agent, "Made it red", Some(true), 5).unwrap();
        assert!(replied.resolved);
        let reply = replied.messages.last().unwrap();
        assert_eq!(
            reply
                .changes
                .iter()
                .map(|c| c.label.as_str())
                .collect::<Vec<_>>(),
            ["a red"]
        );
        assert_eq!(reply.changes[0].node_ids, ["a"]);

        // A user's reply reopens the comment and links nothing.
        let user = author("user:1", AuthorKind::User);
        let reopened = d.reply(&id, user, "Darker", None, 6).unwrap();
        assert!(!reopened.resolved);
        assert!(reopened.messages.last().unwrap().changes.is_empty());
        assert_eq!(d.snapshot().comments.len(), 1);
    }

    #[test]
    fn a_reply_links_an_edit_once() {
        let mut d = design();
        d.commit(
            "agent",
            "boards",
            &[create("a", None), create("b", None)],
            1,
        );
        let first = pin(&mut d, "a");
        let second = pin(&mut d, "a");
        let on_b = pin(&mut d, "b");
        let agent = author("agent", AuthorKind::Agent);
        let labels = |d: &Design, id: &str| -> Vec<String> {
            d.comments()
                .iter()
                .find(|c| c.id == id)
                .unwrap()
                .messages
                .last()
                .unwrap()
                .changes
                .iter()
                .map(|c| c.label.clone())
                .collect()
        };

        d.commit("agent", "one", &[color("a", "red")], 2);
        d.commit("agent", "two", &[color("a", "blue")], 3);
        d.reply(&first, agent.clone(), "First", Some(true), 4)
            .unwrap();
        assert_eq!(labels(&d, &first), ["one", "two"]);

        // Another thread on the same artboard does not take those edits again.
        d.commit("agent", "three", &[color("a", "green")], 5);
        d.reply(&second, agent.clone(), "Second", Some(true), 6)
            .unwrap();
        assert_eq!(labels(&d, &second), ["three"]);

        // The same thread's next reply only adds edits made since it.
        d.commit("agent", "four", &[color("a", "black")], 7);
        d.reply(&first, agent.clone(), "More", None, 8).unwrap();
        assert_eq!(labels(&d, &first), ["four"]);

        // One edit that touches two artboards is linked by the first reply.
        d.commit(
            "agent",
            "both",
            &[color("a", "white"), color("b", "white")],
            9,
        );
        d.reply(&on_b, agent.clone(), "On B", None, 10).unwrap();
        assert_eq!(labels(&d, &on_b), ["both"]);
        d.reply(&second, agent.clone(), "Not again", None, 11)
            .unwrap();
        assert!(labels(&d, &second).is_empty());

        // A later message in the thread moves the window, so the edit before
        // it stays unlinked.
        d.commit("agent", "before", &[color("a", "pink")], 12);
        d.reply(
            &second,
            author("user:1", AuthorKind::User),
            "Now do this",
            None,
            13,
        )
        .unwrap();
        d.commit("agent", "after", &[color("a", "orange")], 14);
        d.reply(&second, agent, "After", None, 15).unwrap();
        assert_eq!(labels(&d, &second), ["after"]);
    }

    #[test]
    fn an_older_thread_links_edits_a_later_reply_missed() {
        let mut d = design();
        d.commit("agent", "boards", &[create("a", None)], 1);
        let older = pin(&mut d, "a");
        d.commit("agent", "red", &[color("a", "red")], 2);
        let newer = pin(&mut d, "a");
        let agent = author("agent", AuthorKind::Agent);
        let labels = |d: &Design, id: &str| -> Vec<String> {
            d.comments()
                .iter()
                .find(|c| c.id == id)
                .unwrap()
                .messages
                .last()
                .unwrap()
                .changes
                .iter()
                .map(|c| c.label.clone())
                .collect()
        };

        // The newer thread starts after the edit, so its reply links nothing.
        d.reply(&newer, agent.clone(), "Nothing new", None, 3)
            .unwrap();
        assert!(labels(&d, &newer).is_empty());
        // The older thread's window still covers that edit, and nobody has linked it.
        d.reply(&older, agent, "That was it", None, 4).unwrap();
        assert_eq!(labels(&d, &older), ["red"]);
    }

    #[test]
    fn a_comment_goes_to_the_agent_that_edited_its_artboard() {
        let mut d = design();
        d.commit(
            "agent:e",
            "boards",
            &[create("a", None), create("b", None)],
            1,
        );
        d.commit("agent:f", "b red", &[color("b", "red")], 2);
        d.commit("user:1", "a blue", &[color("a", "blue")], 3);
        let id = pin(&mut d, "a");
        let all = |_: &str| true;
        let comment = d.comments()[0].clone();
        assert_eq!(
            d.routed_to(&comment, all),
            Some("agent:e"),
            "people's edits don't count"
        );
        assert!(d.awaits(&comment, "agent:e", all));
        assert!(!d.awaits(&comment, "agent:f", all));
        assert!(
            d.awaits(&comment, "agent:f", |id| id != "agent:e"),
            "e stopped listening"
        );

        let taken = d
            .take(&id, author("agent:f", AuthorKind::Agent))
            .unwrap()
            .clone();
        assert!(
            d.awaits(&taken, "agent:f", all),
            "f took it while e was away"
        );
        let passed = d
            .pass(&id, author("agent:f", AuthorKind::Agent))
            .unwrap()
            .clone();
        assert_eq!(passed.taken_by, None);
        assert!(d.awaits(&passed, "agent:e", all));
        assert!(!d.awaits(&passed, "agent:f", all), "f passed");

        let replied = d.reply(&id, author("agent:e", AuthorKind::Agent), "Done", None, 4);
        assert_eq!(
            replied.unwrap().taken_by.as_ref().map(|a| a.id.as_str()),
            Some("agent:e")
        );
        let back = d
            .reply(&id, author("user:1", AuthorKind::User), "Darker", None, 5)
            .unwrap();
        assert!(back.passed_by.is_empty(), "a person wrote again");
    }

    #[test]
    fn only_the_newest_message_can_be_edited_by_its_author() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        let edited = d.edit_message(&id, "user:1", " Make it blue ", 2).unwrap();
        assert_eq!(edited.messages[0].body, "Make it blue");
        assert_eq!(edited.messages[0].edited_at, Some(2));
        assert_eq!(edited.rev, 1);
        assert_eq!(
            d.edit_message(&id, "user:2", "Mine now", 3).unwrap_err(),
            CommentError::NotEditable
        );
        // Once an agent answers, the person's message isn't the newest.
        d.reply(&id, author("agent", AuthorKind::Agent), "Done", None, 4)
            .unwrap();
        assert_eq!(
            d.edit_message(&id, "user:1", "Actually red", 5)
                .unwrap_err(),
            CommentError::NotEditable
        );
    }

    #[test]
    fn resolving_stamps_when_and_deleting_survives_replay() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        assert_eq!(d.set_resolved(&id, true, 7).unwrap().resolved_at, Some(7));
        // Resolving again keeps the first time.
        assert_eq!(d.set_resolved(&id, true, 9).unwrap().resolved_at, Some(7));
        let agent = author("agent", AuthorKind::Agent);
        d.set_resolved(&id, false, 10).unwrap();
        let resolved = d.reply(&id, agent, "Done", Some(true), 11).unwrap();
        assert_eq!(resolved.resolved_at, Some(11));

        let comment = resolved.clone();
        d.delete_comment(&id).unwrap();
        assert!(d.comments().is_empty());
        assert!(matches!(
            d.delete_comment(&id),
            Err(CommentError::NotFound(_))
        ));
        let mut restored = design();
        restored.replay(Record::Comment { comment });
        restored.replay(Record::CommentDeleted { id });
        assert!(restored.comments().is_empty());
    }

    #[test]
    fn every_comment_change_bumps_its_revision() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        let rev = |d: &Design| d.comments()[0].rev;
        assert_eq!(rev(&d), 0);
        d.reply(&id, author("agent", AuthorKind::Agent), "Done", None, 2)
            .unwrap();
        d.set_resolved(&id, true, 3).unwrap();
        assert_eq!(rev(&d), 2);
        // Deleting the artboard moves the pin, and that's a change too.
        d.commit("agent", "delete", &[Op::Delete { id: "a".into() }], 3);
        assert_eq!(rev(&d), 3);
    }

    #[test]
    fn undo_that_deletes_nodes_still_links_to_their_artboard() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        d.commit("agent", "child", &[create("b", Some("a"))], 2);
        // Undoing the child deletes it, so after the undo it's on no artboard.
        d.undo("agent", 3).unwrap();
        let agent = author("agent", AuthorKind::Agent);
        let replied = d.reply(&id, agent, "Tried and reverted", None, 4).unwrap();
        let seqs: Vec<_> = replied.messages[1].changes.iter().map(|c| c.seq).collect();
        assert_eq!(seqs, [2, 3]);
    }

    #[test]
    fn comments_and_threads_have_limits() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let ids: Vec<String> = (0..comment::MAX_OPEN).map(|_| pin(&mut d, "a")).collect();
        let anchor = Anchor {
            artboard_id: Some("a".into()),
            node_id: None,
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
        };
        let user = author("user:1", AuthorKind::User);
        let more = d.add_comment(
            user.clone(),
            anchor.clone(),
            Audience::Agents,
            "One more",
            &mut || "z".into(),
            0,
        );
        assert_eq!(more.unwrap_err(), CommentError::TooManyOpen);

        // Resolving one makes room, and reopening it is refused once that room is taken.
        d.set_resolved(&ids[0], true, 0).unwrap();
        d.add_comment(
            user.clone(),
            anchor,
            Audience::Agents,
            "One more",
            &mut || "z".into(),
            0,
        )
        .unwrap();
        assert_eq!(
            d.set_resolved(&ids[0], false, 0).unwrap_err(),
            CommentError::TooManyOpen
        );
        // A person's reply would reopen it too.
        assert_eq!(
            d.reply(&ids[0], user.clone(), "Not done", None, 0)
                .unwrap_err(),
            CommentError::TooManyOpen
        );

        // A thread holds at most MAX_MESSAGES.
        let thread = &ids[1];
        for _ in 1..comment::MAX_MESSAGES {
            d.reply(thread, user.clone(), "And another thing", None, 0)
                .unwrap();
        }
        assert_eq!(
            d.reply(thread, user, "Too many", None, 0).unwrap_err(),
            CommentError::ThreadFull
        );
    }

    #[test]
    fn comments_must_point_at_real_nodes() {
        let mut d = design();
        let anchor = Anchor {
            artboard_id: Some("missing".into()),
            node_id: None,
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
        };
        let user = author("user:1", AuthorKind::User);
        let result = d.add_comment(user, anchor, Audience::Agents, "Hi", &mut || "c".into(), 0);
        assert!(matches!(result, Err(CommentError::NodeNotFound(_))));
        let agent = author("agent", AuthorKind::Agent);
        assert!(matches!(
            d.reply("nope", agent, "Hi", None, 0),
            Err(CommentError::NotFound(_))
        ));
    }

    #[test]
    fn replies_link_edits_made_before_a_restart() {
        let mut live = design();
        live.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut live, "a");
        live.commit("agent", "red", &[color("a", "red")], 2);
        let saved = live.snapshot_to_save();
        assert!(live.snapshot().log.is_none(), "viewers never get the log");
        let blue = live
            .commit("agent", "blue", &[color("a", "blue")], 3)
            .unwrap();

        // A clean restart from the snapshot, then a crash that replays the journal.
        let mut restored = Design::from_snapshot(saved);
        restored.replay(Record::Change { change: blue });
        let agent = author("agent", AuthorKind::Agent);
        let replied = restored.reply(&id, agent, "Done", None, 4).unwrap();
        let labels: Vec<&str> = replied.messages[1]
            .changes
            .iter()
            .map(|c| c.label.as_str())
            .collect();
        assert_eq!(labels, ["red", "blue"]);
    }

    #[test]
    fn pins_stay_put_when_their_artboard_goes_and_follow_it_back() {
        let mut d = design();
        let mut board = Node::element("a", "div");
        board.index = "V".into();
        board.x = Some(100.0);
        board.y = Some(50.0);
        d.commit("agent", "board", &[Op::Create { node: board }], 1);
        let id = pin(&mut d, "a");
        assert!(d.take_comment_updates().is_empty());

        d.commit("agent", "delete", &[Op::Delete { id: "a".into() }], 2);
        let updated = d.take_comment_updates();
        assert_eq!(updated.len(), 1);
        // The pin was 10, 20 into the artboard at 100, 50.
        assert_eq!(updated[0].detached_at, Some(Point { x: 110.0, y: 70.0 }));

        d.undo("agent", 3).unwrap();
        let updated = d.take_comment_updates();
        assert_eq!(updated[0].id, id);
        assert_eq!(updated[0].detached_at, None, "back on its artboard");
    }

    #[test]
    fn a_pin_can_move_to_a_rebuilt_artboard() {
        let mut d = design();
        let sized = |id: &str, x: f64, width: &str| {
            let mut board = Node::element(id, "div");
            board.index = "V".into();
            board.x = Some(x);
            board.y = Some(50.0);
            board.styles.insert("width".into(), width.into());
            board.styles.insert("height".into(), "200px".into());
            Op::Create { node: board }
        };
        d.commit("agent", "board", &[sized("a", 100.0, "300px")], 1);
        let id = pin(&mut d, "a");
        let orphans = |d: &Design, root: &str| {
            comment::pinned_inside(d.view(), d.comments(), &[root.into()]).len()
        };
        assert_eq!(orphans(&d, "a"), 1);

        // The screen is removed and rebuilt narrow, elsewhere, with a new id.
        d.commit("agent", "delete", &[Op::Delete { id: "a".into() }], 2);
        d.commit(
            "agent",
            "rebuild",
            &[sized("b", 900.0, "5px"), create("h", Some("b"))],
            3,
        );
        d.take_comment_updates();
        assert!(d.comments()[0].detached_at.is_some());

        let pinned = d.repin(&id, "h").unwrap().clone();
        assert_eq!(pinned.artboard_id.as_deref(), Some("b"));
        assert_eq!(pinned.node_id.as_deref(), Some("h"));
        assert_eq!(pinned.detached_at, None);
        // The offset is kept, held inside the 5px-wide artboard.
        assert_eq!((pinned.x, pinned.y), (5.0, 20.0));
        assert_eq!(orphans(&d, "h"), 1);
        assert_eq!(orphans(&d, "b"), 1, "removing its artboard orphans it too");

        // Pointing it at the artboard itself leaves no element.
        let pinned = d.repin(&id, "b").unwrap();
        assert_eq!(pinned.node_id, None);
        assert!(d.repin(&id, "nowhere").is_err());
        assert!(d.repin("missing", "b").is_err());
    }
}
