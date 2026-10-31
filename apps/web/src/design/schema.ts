import { Schema } from "effect";

// Mirrors the Rust types in crates/design (Node, Op, Change, Snapshot, Comment) and
// crates/server/src/hub/messages.rs (Presence, DesignSummary, the socket messages).
// Keep both sides in sync.

export const Node = Schema.Struct({
  id: Schema.String,
  /** `null` for artboards, which sit directly on the canvas. */
  parent: Schema.NullOr(Schema.String),
  /** Fractional index: siblings sort by this string. */
  index: Schema.String,
  type: Schema.Literals(["element", "text"]),
  tag: Schema.optionalKey(Schema.String),
  name: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  x: Schema.NullOr(Schema.Number),
  y: Schema.NullOr(Schema.Number),
  styles: Schema.Record(Schema.String, Schema.String),
  attrs: Schema.Record(Schema.String, Schema.String),
});
export type Node = typeof Node.Type;

/** `name`, `text`, `x`, `y`, `style:<css-property>` or `attr:<attribute>`. */
export type PropKey = string;

export const Op = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create"), node: Node }),
  Schema.Struct({ op: Schema.Literal("delete"), id: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("set"),
    id: Schema.String,
    key: Schema.String,
    value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    id: Schema.String,
    parent: Schema.NullOr(Schema.String),
    index: Schema.String,
  }),
]);
export type Op = typeof Op.Type;

export const DesignMeta = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type DesignMeta = typeof DesignMeta.Type;

export const Author = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["user", "agent"]),
});
export type Author = typeof Author.Type;

/** An edit an agent's reply links to: its change `seq`, label and the nodes it touched. */
export const ChangeRef = Schema.Struct({
  seq: Schema.Number,
  label: Schema.String,
  nodeIds: Schema.Array(Schema.String),
});
export type ChangeRef = typeof ChangeRef.Type;

export const CommentMessage = Schema.Struct({
  author: Author,
  body: Schema.String,
  at: Schema.Number,
  seq: Schema.Number,
  changes: Schema.optionalKey(Schema.Array(ChangeRef)),
});
export type CommentMessage = typeof CommentMessage.Type;

export const Comment = Schema.Struct({
  id: Schema.String,
  /** The artboard the pin sits on. `x` and `y` are relative to it, or to the canvas when `null`. */
  artboardId: Schema.NullOr(Schema.String),
  /** The element the user pointed at. */
  nodeId: Schema.NullOr(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  resolved: Schema.Boolean,
  createdAt: Schema.Number,
  /** The first message is the comment itself; the rest are replies. */
  messages: Schema.Array(CommentMessage),
  /** Where the pin was on the canvas when its artboard was deleted. */
  detachedAt: Schema.optionalKey(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  /** Goes up by one with every change, so of two copies the higher one is newer. */
  rev: Schema.Number,
});
export type Comment = typeof Comment.Type;

export const Snapshot = Schema.Struct({
  meta: DesignMeta,
  seq: Schema.Number,
  nodes: Schema.Array(Node),
  comments: Schema.Array(Comment),
});
export type Snapshot = typeof Snapshot.Type;

export const Change = Schema.Struct({
  seq: Schema.Number,
  actor: Schema.String,
  origin: Schema.Literals(["edit", "undo", "redo"]),
  label: Schema.String,
  ops: Schema.Array(Op),
});
export type Change = typeof Change.Type;

export const Presence = Schema.Struct({
  actor: Schema.String,
  name: Schema.String,
  nodeIds: Schema.Array(Schema.String),
  status: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
});
export type Presence = typeof Presence.Type;

export const DesignSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  seq: Schema.Number,
  artboardCount: Schema.Number,
  nodeCount: Schema.Number,
});
export type DesignSummary = typeof DesignSummary.Type;

/** Sent on `/api/designs/{id}/ws`. */
export const DesignMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: Snapshot,
    presence: Schema.Array(Presence),
    /** Names this load of the design on the server. Send it back to resume. */
    epoch: Schema.String,
  }),
  /** Instead of a snapshot, after reconnecting with `?epoch=…&since=…`: what was missed. */
  Schema.Struct({
    type: Schema.Literal("resume"),
    changes: Schema.Array(Schema.Struct({ change: Change, actorName: Schema.String })),
    comments: Schema.Array(Comment),
    presence: Schema.Array(Presence),
    meta: DesignMeta,
  }),
  Schema.Struct({ type: Schema.Literal("change"), change: Change, actorName: Schema.String }),
  Schema.Struct({ type: Schema.Literal("presence"), presence: Schema.Array(Presence) }),
  Schema.Struct({ type: Schema.Literal("meta"), meta: DesignMeta }),
  Schema.Struct({ type: Schema.Literal("comment"), comment: Comment }),
]);
export type DesignMessage = typeof DesignMessage.Type;

/** Sent on `/api/designs/ws`. */
export const LobbyMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("designs"), designs: Schema.Array(DesignSummary) }),
  Schema.Struct({ type: Schema.Literal("design"), design: DesignSummary }),
]);
export type LobbyMessage = typeof LobbyMessage.Type;
