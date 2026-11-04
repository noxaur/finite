import {
  type Applied,
  type LocalOutcome,
  type PageEntry,
  Replica,
  type TokenTable,
} from "./replica";
import type {
  Change,
  ClientMessage,
  Comment,
  DesignMessage,
  DesignMeta,
  Listener,
  Presence,
  Stamp,
  UserEdit,
} from "./schema";
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
  /** Catches up after a change's ops have all applied: draws the instances they changed again. */
  flush(): void;
  /** Badges the artboards agents are working on, keyed by artboard id. */
  setWorking(working: ReadonlyMap<string, string>): void;
}

export interface SessionState {
  readonly status: SocketStatus;
  /** `null` until the first snapshot arrives. */
  readonly meta: DesignMeta | null;
  readonly presence: ReadonlyArray<Presence>;
  /** Agents checking this design for comments. */
  readonly listening: ReadonlyArray<Listener>;
  /** The label shown on each artboard an agent is working on, keyed by artboard id. */
  readonly working: ReadonlyMap<string, string>;
  readonly comments: ReadonlyMap<string, Comment>;
  /** Recent changes, newest first. */
  readonly activity: ReadonlyArray<Activity>;
  readonly artboardCount: number;
  /** The design's tokens and modes. */
  readonly tokens: TokenTable;
  /** The design's pages in order, with how many artboards each has. */
  readonly pages: ReadonlyArray<PageEntry & { readonly artboardCount: number }>;
  /** Bumps after every snapshot or change, so anything positioned on the design can follow it. */
  readonly version: number;
}

/** How a person's edit, undo or redo ended. */
export type EditResult =
  | { readonly kind: "landed" }
  /** The design already looked like that, or there was nothing to undo. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly message: string }
  /** The connection was replaced by a fresh snapshot before an answer came; the snapshot shows what happened. */
  | { readonly kind: "lost" };

/** Who is editing: the browser's person, as comments name them. */
export interface Editor {
  readonly id: string;
  readonly name: string;
}

/** How many recent changes `activity` keeps. */
export const ACTIVITY_LIMIT = 6;

export const initialSessionState: SessionState = {
  status: "connecting",
  meta: null,
  presence: [],
  listening: [],
  working: new Map(),
  comments: new Map(),
  activity: [],
  artboardCount: 0,
  tokens: { modes: [], tokens: {} },
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
  /** Sends on the open connection, or `null` while there's none. */
  private send: ((data: string) => void) | null = null;
  /** Names this tab in the stamps of its mutations. One person can have several tabs. */
  private readonly client = crypto.randomUUID().slice(0, 12);
  private nextMid = 1;
  /** Messages sent and not yet answered, by mutation id, oldest first. */
  private readonly waiting = new Map<
    number,
    { readonly message: ClientMessage; readonly done: (result: EditResult) => void }
  >();
  /** `settled` answers that came before the changes they follow. */
  private early: Array<{ readonly mid: number; readonly seq: number; readonly error?: string }> =
    [];
  private readonly draftLost = new Set<(reason: string) => void>();

  /** `view` must draw from `replica`, so pass the renderer the same replica. */
  constructor(
    private readonly view: DesignView,
    readonly replica: Replica = new Replica(),
    private readonly now: () => number = Date.now,
    private readonly editor: () => Editor = () => ({ id: "guest", name: "Guest" }),
  ) {
    replica.setClient(this.client);
  }

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
        onSend: (send) => this.setSender(send),
      },
      () =>
        this.epoch ? `?epoch=${encodeURIComponent(this.epoch)}&since=${this.replica.seq}` : "",
    );
  }

  /** Where this tab's edits go: the open connection, or `null` while there's none. */
  setSender(send: ((data: string) => void) | null) {
    this.send = send;
  }

  /**
   * Shows `edits` as the gesture in progress, planned as the server will
   * plan them, or clears them with `null`. Nothing is sent. When they can't
   * be planned, like a move inside an instance, `error` says why.
   */
  draft(edits: ReadonlyArray<UserEdit> | null): LocalOutcome {
    // Planned as the mutation it'll be sent as, so the nodes it makes keep their ids.
    const outcome = this.replica.draft(this.nextMid, edits, (a) => this.view.apply(a));
    this.view.flush();
    return outcome;
  }

  /**
   * Sends a gesture's edits as one undo step. They show at once: when
   * they're the draft's, the screen doesn't change. Resolves when the
   * server's change for them arrives, or it answers that it refused them.
   */
  commit(edits: ReadonlyArray<UserEdit>): Promise<EditResult> {
    const mid = this.nextMid++;
    const outcome = this.replica.propose(mid, edits, (a) => this.view.apply(a));
    this.view.flush();
    if (outcome.error !== null) {
      return Promise.resolve({ kind: "refused", message: outcome.error });
    }
    return this.request({ type: "mutate", author: this.editor(), stamp: this.stamp(mid), edits });
  }

  /** Undoes this person's last edit. Not shown ahead: the server holds the history. */
  undo(): Promise<EditResult> {
    const stamp = this.stamp(this.nextMid++);
    return this.request({ type: "undo", author: this.editor(), stamp });
  }

  redo(): Promise<EditResult> {
    const stamp = this.stamp(this.nextMid++);
    return this.request({ type: "redo", author: this.editor(), stamp });
  }

  /** Calls `listener` when a change from someone else means the gesture's draft no longer applies. */
  onDraftLost(listener: (reason: string) => void): () => void {
    this.draftLost.add(listener);
    return () => this.draftLost.delete(listener);
  }

  private stamp(mid: number): Stamp {
    return { client: this.client, mid };
  }

  private request(message: ClientMessage): Promise<EditResult> {
    return new Promise((done) => {
      this.waiting.set(message.stamp.mid, { message, done });
      // Without a connection, it's sent once a reconnect resumes.
      this.send?.(JSON.stringify(message));
    });
  }

  /** Ends the wait for mutation `mid`. */
  private answer(mid: number, result: EditResult) {
    const waiting = this.waiting.get(mid);
    this.waiting.delete(mid);
    waiting?.done(result);
  }

  /** Runs the `settled` answers whose changes have all arrived. */
  private settleEarly() {
    const ready = this.early.filter((s) => s.seq <= this.replica.seq);
    if (ready.length === 0) return;
    this.early = this.early.filter((s) => s.seq > this.replica.seq);
    for (const { mid, error } of ready) {
      if (this.waiting.get(mid)?.message.type === "mutate") {
        this.replica.settle(mid, (a) => this.view.apply(a));
        this.view.flush();
      }
      this.answer(
        mid,
        error === undefined ? { kind: "unchanged" } : { kind: "refused", message: error },
      );
    }
  }

  receive(message: DesignMessage) {
    switch (message.type) {
      case "snapshot":
        this.epoch = message.epoch;
        // A snapshot replaces the tab's own edits: they may be in it already.
        const drafting = this.replica.hasLocal;
        this.replica.load(message.snapshot);
        // A gesture planned against the old document would commit what it saw there.
        if (drafting) for (const listener of this.draftLost) listener("The design reloaded.");
        this.early = [];
        for (const mid of [...this.waiting.keys()]) this.answer(mid, { kind: "lost" });
        this.view.reset();
        this.update({
          meta: message.snapshot.meta,
          comments: new Map(message.snapshot.comments.map((c) => [c.id, c])),
          listening: message.listening,
          ...this.withPresence(message.presence),
          ...this.synced(),
        });
        return;
      case "resume": {
        const missed = message.changes.flatMap((m) =>
          this.applyChange(m.change, m.actorName, m.mutation),
        );
        // Whatever the server didn't get before the connection dropped goes again.
        for (const { message: unanswered } of this.waiting.values()) {
          this.send?.(JSON.stringify(unanswered));
        }
        this.update({
          meta: message.meta,
          comments: new Map(message.comments.map((c) => [c.id, c])),
          activity: [...missed.reverse(), ...this.current.activity].slice(0, ACTIVITY_LIMIT),
          listening: message.listening,
          ...this.withPresence(message.presence),
          ...this.synced(),
        });
        return;
      }
      case "settled":
        this.early.push(message);
        this.settleEarly();
        return;
      case "change": {
        const entry = this.applyChange(message.change, message.actorName, message.mutation);
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
        this.update({ listening: message.listening, ...this.withPresence(message.presence) });
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
  private applyChange(change: Change, actor: string, mutation?: Stamp): Activity[] {
    if (change.seq <= this.replica.seq) return [];
    const mine = mutation?.client === this.client ? mutation.mid : null;
    // One call into WebAssembly for the whole change; the view patches op by op.
    const outcome = this.replica.receive(change.ops, mine, (applied) => this.view.apply(applied));
    this.view.flush();
    this.replica.seq = change.seq;
    if (mine !== null) this.answer(mine, { kind: "landed" });
    // A dropped mutation still gets the server's own answer, which decides.
    if (outcome.draftLost !== null) {
      for (const listener of this.draftLost) listener(outcome.draftLost);
    }
    this.settleEarly();
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
      tokens: this.replica.tokens,
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
