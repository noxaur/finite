import { Schema } from "effect";

// Mirrors the Rust types in crates/design (Node, Op, Change, Snapshot, Comment, UserEdit) and
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
  /** The artboard's page. Absent, or a page that's gone, means the first page. */
  page: Schema.optionalKey(Schema.String),
  /** The token mode the artboard renders in. Absent, or a mode that's gone, means the first mode. */
  mode: Schema.optionalKey(Schema.String),
  styles: Schema.Record(Schema.String, Schema.String),
  attrs: Schema.Record(Schema.String, Schema.String),
  /** Set on a component's root: instances elsewhere show this subtree. */
  component: Schema.optionalKey(Schema.Boolean),
  /** On an instance, the component it shows. It has no children of its own. */
  instanceOf: Schema.optionalKey(Schema.String),
  /** On an instance, what it shows differently, keyed by `<path>/<property>`. `null` removes a value. */
  overrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});
export type Node = typeof Node.Type;

/**
 * `name`, `text`, `x`, `y`, `style:<css-property>` or `attr:<attribute>`,
 * and for components `component`, `instanceOf` and `override:<key>`.
 */
export type PropKey = string;

/** A named group of artboards; the viewer shows one page at a time. */
export const Page = Schema.Struct({
  name: Schema.String,
  /** Fractional index: pages sort by this string. */
  index: Schema.String,
});
export type Page = typeof Page.Type;

/** A set of token values, like Light or Dark. Each artboard renders in one. */
export const Mode = Schema.Struct({
  name: Schema.String,
  /** Fractional index: modes sort by this string. */
  index: Schema.String,
});
export type Mode = typeof Mode.Type;

/** A token's CSS values, by mode id. */
export const TokenValues = Schema.Record(Schema.String, Schema.String);
export type TokenValues = typeof TokenValues.Type;

export const Op = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create"), node: Node }),
  Schema.Struct({ op: Schema.Literal("delete"), id: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("set"),
    id: Schema.String,
    key: Schema.String,
    /** `true` marks a component; `false` is a value an instance removes. */
    value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    id: Schema.String,
    parent: Schema.NullOr(Schema.String),
    index: Schema.String,
  }),
  /** Replaces the old shared CSS. Only journals from before tokens hold it. */
  Schema.Struct({
    op: Schema.Literal("css"),
    css: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  /** Sets a token's value in one mode, or removes it when `value` is `null`. */
  Schema.Struct({
    op: Schema.Literal("token"),
    name: Schema.String,
    modeId: Schema.String,
    value: Schema.NullOr(Schema.String),
  }),
  /** Creates, renames or reorders a mode, or removes it when `mode` is `null`. */
  Schema.Struct({
    op: Schema.Literal("mode"),
    id: Schema.String,
    mode: Schema.NullOr(Mode),
  }),
  /** Creates, renames or reorders a page, or removes it when `page` is `null`. */
  Schema.Struct({
    op: Schema.Literal("page"),
    id: Schema.String,
    page: Schema.NullOr(Page),
  }),
]);
export type Op = typeof Op.Type;

/**
 * One thing a person changes on the canvas (`user_edit::UserEdit` in Rust).
 * Each states where things end up, not by how much they change.
 */
export const UserEdit = Schema.Union([
  /** Puts artboards at these canvas positions. */
  Schema.Struct({
    kind: Schema.Literal("setPosition"),
    moves: Schema.Array(Schema.Struct({ id: Schema.String, x: Schema.Number, y: Schema.Number })),
  }),
  /** Sets inline styles, or removes one when its value is `null`. */
  Schema.Struct({
    kind: Schema.Literal("setStyles"),
    ids: Schema.Array(Schema.String),
    styles: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  }),
  /** Moves nodes under `parent` (the canvas when `null`), right before `before`, or last. */
  Schema.Struct({
    kind: Schema.Literal("place"),
    ids: Schema.Array(Schema.String),
    parent: Schema.NullOr(Schema.String),
    before: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("delete"), ids: Schema.Array(Schema.String) }),
  /** Copies nodes, each right after its original. */
  Schema.Struct({ kind: Schema.Literal("duplicate"), ids: Schema.Array(Schema.String) }),
  /** Wraps sibling nodes in a new `<div>`, where the first of them was. */
  Schema.Struct({ kind: Schema.Literal("group"), ids: Schema.Array(Schema.String) }),
  /** Puts each node's children in its place and deletes it. */
  Schema.Struct({ kind: Schema.Literal("ungroup"), ids: Schema.Array(Schema.String) }),
  /** Replaces the text of a text node, or of an element holding only text. */
  Schema.Struct({ kind: Schema.Literal("setText"), id: Schema.String, text: Schema.String }),
  /** Makes an element a component, which instances can follow. */
  Schema.Struct({
    kind: Schema.Literal("makeComponent"),
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  /** Turns instances into plain copies of what they show. */
  Schema.Struct({ kind: Schema.Literal("detach"), ids: Schema.Array(Schema.String) }),
  /**
   * Sets attributes, or removes one when its value is `null`: `data-name`
   * renames a layer, `hidden` hides it and `data-locked` locks it.
   */
  Schema.Struct({
    kind: Schema.Literal("setAttributes"),
    ids: Schema.Array(Schema.String),
    attrs: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  }),
  /** Adds a page after the others. */
  Schema.Struct({ kind: Schema.Literal("createPage"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("renamePage"), id: Schema.String, name: Schema.String }),
  /** Deletes a page and every artboard on it. */
  Schema.Struct({ kind: Schema.Literal("deletePage"), id: Schema.String }),
  /** Moves artboards to another page, into free space there. */
  Schema.Struct({
    kind: Schema.Literal("moveToPage"),
    ids: Schema.Array(Schema.String),
    page: Schema.String,
  }),
]);
export type UserEdit = typeof UserEdit.Type;

/** The tab and its counter that sent a mutation, on the change it made. */
export const Stamp = Schema.Struct({ client: Schema.String, mid: Schema.Number });
export type Stamp = typeof Stamp.Type;

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
  /** When its author last changed the body. */
  editedAt: Schema.optionalKey(Schema.Number),
});
export type CommentMessage = typeof CommentMessage.Type;

/** Who a comment is for. Mirrors `Audience` in crates/design/src/comment.rs. */
export const Audience = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agents") }),
  Schema.Struct({ kind: Schema.Literal("people") }),
  Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String, name: Schema.String }),
]);
export type Audience = typeof Audience.Type;

export const Comment = Schema.Struct({
  id: Schema.String,
  /** The artboard the pin sits on. `x` and `y` are relative to it, or to the canvas when `null`. */
  artboardId: Schema.NullOr(Schema.String),
  /** The element the user pointed at. */
  nodeId: Schema.NullOr(Schema.String),
  /** The other elements the user selected with it. */
  extraNodeIds: Schema.optionalKey(Schema.Array(Schema.String)),
  x: Schema.Number,
  y: Schema.Number,
  resolved: Schema.Boolean,
  /** When it was last resolved. Absent on comments resolved before this was recorded. */
  resolvedAt: Schema.optionalKey(Schema.Number),
  createdAt: Schema.Number,
  /** The first message is the comment itself; the rest are replies. */
  messages: Schema.Array(CommentMessage),
  /** Where the pin was on the canvas when its artboard was deleted. */
  detachedAt: Schema.optionalKey(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  /** Goes up by one with every change, so of two copies the higher one is newer. */
  rev: Schema.Number,
  /** Who it's for. Absent means any agent. */
  audience: Schema.optionalKey(Audience),
  /** Agents that passed on it since a person last wrote in it. */
  passedBy: Schema.optionalKey(Schema.Array(Author)),
  /** The agent that took it or last replied, so a follow-up goes back to it. */
  takenBy: Schema.optionalKey(Author),
});
export type Comment = typeof Comment.Type;

export const Snapshot = Schema.Struct({
  meta: DesignMeta,
  seq: Schema.Number,
  nodes: Schema.Array(Node),
  /** Pages by id. Absent when the design has only its implicit first page. */
  pages: Schema.optionalKey(Schema.Record(Schema.String, Page)),
  /** Token values by name. Absent when there are none. */
  tokens: Schema.optionalKey(Schema.Record(Schema.String, TokenValues)),
  /** Modes by id. Absent when the design has only its implicit first mode. */
  modes: Schema.optionalKey(Schema.Record(Schema.String, Mode)),
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

/** An agent checking this design for comments, so comments can go to it. */
export const Listener = Schema.Struct({ actor: Schema.String, name: Schema.String });
export type Listener = typeof Listener.Type;

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
    listening: Schema.Array(Listener),
    /** Names this load of the design on the server. Send it back to resume. */
    epoch: Schema.String,
  }),
  /** Instead of a snapshot, after reconnecting with `?epoch=…&since=…`: what was missed. */
  Schema.Struct({
    type: Schema.Literal("resume"),
    changes: Schema.Array(
      Schema.Struct({
        change: Change,
        actorName: Schema.String,
        mutation: Schema.optionalKey(Stamp),
      }),
    ),
    comments: Schema.Array(Comment),
    presence: Schema.Array(Presence),
    listening: Schema.Array(Listener),
    meta: DesignMeta,
  }),
  Schema.Struct({
    type: Schema.Literal("change"),
    change: Change,
    actorName: Schema.String,
    /** The mutation that made it, when a person's tab sent one. */
    mutation: Schema.optionalKey(Stamp),
  }),
  /**
   * Only to the tab that sent mutation `mid`, when it changed nothing:
   * `error` says why it was refused. Apply every change up to `seq` first.
   */
  Schema.Struct({
    type: Schema.Literal("settled"),
    mid: Schema.Number,
    seq: Schema.Number,
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("presence"),
    presence: Schema.Array(Presence),
    listening: Schema.Array(Listener),
  }),
  Schema.Struct({ type: Schema.Literal("meta"), meta: DesignMeta }),
  Schema.Struct({ type: Schema.Literal("comment"), comment: Comment }),
  Schema.Struct({ type: Schema.Literal("commentDeleted"), id: Schema.String }),
]);
export type DesignMessage = typeof DesignMessage.Type;

/** What a person's tab sends on `/api/designs/{id}/ws`, besides pings. */
export type ClientMessage =
  | {
      readonly type: "mutate";
      readonly author: { readonly id: string; readonly name: string };
      readonly stamp: Stamp;
      readonly edits: ReadonlyArray<UserEdit>;
    }
  | {
      readonly type: "undo" | "redo";
      readonly author: { readonly id: string; readonly name: string };
      readonly stamp: Stamp;
    };

/** Sent on `/api/designs/ws`. */
export const LobbyMessage = Schema.Union([
  /** The most recently edited designs, and how many there are in all. */
  Schema.Struct({
    type: Schema.Literal("designs"),
    designs: Schema.Array(DesignSummary),
    total: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("design"), design: DesignSummary }),
]);
export type LobbyMessage = typeof LobbyMessage.Type;
