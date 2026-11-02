import { type Applied, type PageEntry, Replica } from "./replica";
import type { Change, Comment, DesignMessage, DesignMeta, Presence } from "./schema";
import { connectDesign, type SocketStatus } from "./socket";

/** One line in the activity list: a recent change and who made it. */
export interface Activity {
  readonly seq: number;
  readonly actor: string;
  readonly label: string;
  readonly at: number;
}

/** What draws the design. `Renderer` implements it; tests pass a fake. */
export interface DesignView {
  /** Rebuilds everything from the replica, after a snapshot. */
  reset(): void;
  /** Patches what one applied op touched. */
  apply(applied: Applied): void;
  /** Badges the artboards agents are working on, keyed by artboard id. */
  setWorking(working: ReadonlyMap<string, string>): void;
}

export interface SessionState {
  readonly status: SocketStatus;
  /** `null` until the first snapshot arrives. */
  readonly meta: DesignMeta | null;
  readonly presence: ReadonlyArray<Presence>;
  /** The label shown on each artboard an agent is working on, keyed by artboard id. */
  readonly working: ReadonlyMap<string, string>;
  readonly comments: ReadonlyMap<string, Comment>;
  /** Recent changes, newest first. */
  readonly activity: ReadonlyArray<Activity>;
  readonly artboardCount: number;
  /** The design's shared CSS, or `null` when it has none. */
  readonly css: string | null;
  /** The design's pages in order, with how many artboards each has. */
  readonly pages: ReadonlyArray<PageEntry & { readonly artboardCount: number }>;
  /** Bumps after every snapshot or change, so anything positioned on the design can follow it. */
  readonly version: number;
}

/** How many recent changes `activity` keeps. */
export const ACTIVITY_LIMIT = 6;

export const initialSessionState: SessionState = {
  status: "connecting",
  meta: null,
  presence: [],
  working: new Map(),
  comments: new Map(),
  activity: [],
  artboardCount: 0,
  css: null,
  pages: [],
  version: 0,
};

/**
 * The live state of one open design. It applies the server's messages to a
 * `Replica`, forwards each applied op to the view, and keeps everything else a
 * viewer shows (meta, presence, comments, recent activity) as one immutable
 * state object that React reads.
 */
export class DesignSession {
  private current = initialSessionState;
  private readonly listeners = new Set<() => void>();
  /** The server's name for the load our snapshot came from, so a reconnect can resume. */
  private epoch: string | null = null;
  /** Comments deleted while open, so a late REST answer can't bring one back. */
  private readonly deleted = new Set<string>();

  /** `view` must draw from `replica`, so pass the renderer the same replica. */
  constructor(
    private readonly view: DesignView,
    readonly replica: Replica = new Replica(),
    private readonly now: () => number = Date.now,
  ) {}

  get state(): SessionState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Streams the design from the server. After a dropped connection it asks to
   * resume from the last change it applied, so the server sends only what it
   * missed instead of a snapshot that would rebuild every artboard.
   * Returns a function that disconnects.
   */
  connect(id: string): () => void {
    return connectDesign(
      id,
      {
        onStatus: (status) => this.update({ status }),
        onMessage: (message) => this.receive(message),
      },
      () =>
        this.epoch ? `?epoch=${encodeURIComponent(this.epoch)}&since=${this.replica.seq}` : "",
    );
  }

  receive(message: DesignMessage) {
    switch (message.type) {
      case "snapshot":
        this.epoch = message.epoch;
        this.replica.load(message.snapshot);
        this.view.reset();
        this.update({
          meta: message.snapshot.meta,
          comments: new Map(message.snapshot.comments.map((c) => [c.id, c])),
          ...this.withPresence(message.presence),
          ...this.synced(),
        });
        return;
      case "resume": {
        const missed = message.changes.flatMap((m) => this.applyChange(m.change, m.actorName));
        this.update({
          meta: message.meta,
          comments: new Map(message.comments.map((c) => [c.id, c])),
          activity: [...missed.reverse(), ...this.current.activity].slice(0, ACTIVITY_LIMIT),
          ...this.withPresence(message.presence),
          ...this.synced(),
        });
        return;
      }
      case "change": {
        const entry = this.applyChange(message.change, message.actorName);
        if (entry.length === 0) return;
        this.update({
          activity: [...entry, ...this.current.activity].slice(0, ACTIVITY_LIMIT),
          // A change can move the nodes an agent is working on to another artboard.
          ...this.withPresence(this.current.presence),
          ...this.synced(),
        });
        return;
      }
      case "presence":
        this.update(this.withPresence(message.presence));
        return;
      case "meta":
        this.update({ meta: message.meta });
        return;
      case "comment":
        this.upsertComment(message.comment);
        return;
      case "commentDeleted":
        this.removeComment(message.id);
        return;
    }
  }

  /**
   * Adds or replaces a comment, from the server's `comment` message or a REST
   * reply. The same change arrives both ways, in either order, so an older
   * copy than the one we have is ignored.
   */
  upsertComment(comment: Comment) {
    const known = this.current.comments.get(comment.id);
    if ((known && known.rev > comment.rev) || this.deleted.has(comment.id)) return;
    this.update({ comments: new Map(this.current.comments).set(comment.id, comment) });
  }

  /** Drops a deleted comment, from the server's message or our own delete. */
  removeComment(id: string) {
    this.deleted.add(id);
    if (!this.current.comments.has(id)) return;
    const comments = new Map(this.current.comments);
    comments.delete(id);
    this.update({ comments });
  }

  /** Applies a change we haven't seen, and returns its activity entry (none if we had). */
  private applyChange(change: Change, actor: string): Activity[] {
    if (change.seq <= this.replica.seq) return [];
    // One call into WebAssembly for the whole change; the view patches op by op.
    this.replica.applyAll(change.ops, (applied) => this.view.apply(applied));
    this.replica.seq = change.seq;
    const label =
      change.origin === "edit"
        ? change.label
        : `${change.origin === "undo" ? "Undo" : "Redo"}: ${change.label}`;
    return [{ seq: change.seq, actor, label, at: this.now() }];
  }

  private synced() {
    const boards = this.replica.artboards();
    const counts = new Map<string, number>();
    for (const board of boards) {
      const page = this.replica.pageOf(board);
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    return {
      artboardCount: boards.length,
      css: this.replica.css,
      pages: this.replica.pages.map((p) => ({ ...p, artboardCount: counts.get(p.id) ?? 0 })),
      version: this.current.version + 1,
    };
  }

  private withPresence(presence: ReadonlyArray<Presence>) {
    const working = new Map<string, string>();
    for (const p of presence) {
      for (const nodeId of p.nodeIds) {
        const board = this.replica.artboardOf(nodeId);
        if (board) working.set(board.id, p.status ? `${p.name}: ${p.status}` : p.name);
      }
    }
    this.view.setWorking(working);
    return { presence, working };
  }

  private update(patch: Partial<SessionState>) {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }
}
