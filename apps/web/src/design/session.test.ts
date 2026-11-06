import "./wasm.node";
import { describe, expect, it } from "vite-plus/test";
import type { Applied } from "./replica";
import type { Comment, DesignMessage, Node, Presence } from "./schema";
import { ACTIVITY_LIMIT, DesignSession, type DesignView } from "./session";

const node = (id: string, parent: string | null): Node => ({
  id,
  parent,
  index: "V",
  type: "element",
  tag: "div",
  name: null,
  text: null,
  x: parent === null ? 0 : null,
  y: parent === null ? 0 : null,
  styles: {},
  attrs: {},
});

const snapshot = (presence: ReadonlyArray<Presence> = []): DesignMessage => ({
  type: "snapshot",
  snapshot: {
    meta: { id: "d", name: "Landing", createdAt: 0, updatedAt: 0 },
    seq: 3,
    nodes: [node("a", null), node("b", "a")],
    comments: [],
  },
  presence,
  listening: [],
  epoch: "e1",
});

const recolor = (seq: number, origin: "edit" | "undo" = "edit"): DesignMessage => ({
  type: "change",
  actorName: "Claude",
  change: {
    seq,
    actor: "agent:Claude",
    origin,
    label: "Update styles",
    ops: [{ op: "set", id: "b", key: "style:color", value: `#${seq}` }],
  },
});

const presence = (nodeIds: ReadonlyArray<string>): Presence => ({
  actor: "agent:Claude",
  name: "Claude",
  nodeIds,
  status: "Building",
  updatedAt: 0,
});

class FakeView implements DesignView {
  resets = 0;
  applied: Applied[] = [];
  working: ReadonlyMap<string, string> = new Map();
  reset() {
    this.resets++;
  }
  apply(applied: Applied) {
    this.applied.push(applied);
  }
  flushes = 0;
  flush() {
    this.flushes++;
  }
  setWorking(working: ReadonlyMap<string, string>) {
    this.working = working;
  }
}

const session = () => {
  const view = new FakeView();
  return { view, session: new DesignSession(view, undefined, () => 42) };
};

describe("DesignSession", () => {
  it("applies only the missed changes when it resumes, without redrawing", () => {
    const { view, session: s } = session();
    s.receive(snapshot());
    s.receive(recolor(4));
    const changes = [5, 6].map((seq) => {
      const message = recolor(seq);
      if (message.type !== "change") throw new Error("expected a change");
      return { change: message.change, actorName: message.actorName };
    });
    const pin: Comment = {
      id: "c1",
      artboardId: null,
      nodeId: null,
      x: 0,
      y: 0,
      resolved: false,
      createdAt: 0,
      messages: [],
      rev: 0,
    };
    s.receive({
      type: "resume",
      // A change it already has is skipped.
      changes: [...changes.slice(0, 1), ...changes],
      comments: [pin],
      presence: [presence(["b"])],
      listening: [],
      meta: { id: "d", name: "Renamed", createdAt: 0, updatedAt: 0 },
    });
    expect(view.resets).toBe(1);
    expect(view.applied).toHaveLength(3);
    expect(s.replica.seq).toBe(6);
    expect(s.state.activity.map((a) => a.seq)).toEqual([6, 5, 4]);
    expect([...s.state.comments.keys()]).toEqual(["c1"]);
    expect(s.state.meta?.name).toBe("Renamed");
    expect(view.working).toEqual(new Map([["a", "Claude: Building"]]));
  });

  it("loads a snapshot and draws it from scratch", () => {
    const { view, session: s } = session();
    s.receive(snapshot());
    expect(view.resets).toBe(1);
    expect(s.state.meta?.name).toBe("Landing");
    expect(s.state.artboardCount).toBe(1);
    expect(s.state.version).toBe(1);
  });

  it("applies new changes, skips old ones, and records activity", () => {
    const { view, session: s } = session();
    s.receive(snapshot());
    s.receive(recolor(3));
    expect(view.applied).toHaveLength(0);
    s.receive(recolor(4));
    s.receive(recolor(5, "undo"));
    expect(view.applied).toHaveLength(2);
    expect(s.replica.get("b")?.styles.color).toBe("#5");
    expect(s.state.activity.map((a) => a.label)).toEqual(["Undo: Update styles", "Update styles"]);
    expect(s.state.activity[0]).toMatchObject({ seq: 5, actor: "Claude", at: 42 });
  });

  it("keeps only the latest activity", () => {
    const { session: s } = session();
    s.receive(snapshot());
    for (let seq = 4; seq < 4 + ACTIVITY_LIMIT + 3; seq++) s.receive(recolor(seq));
    expect(s.state.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(s.state.activity[0]?.seq).toBe(3 + ACTIVITY_LIMIT + 3);
  });

  it("badges the artboard that holds the nodes an agent works on", () => {
    const { view, session: s } = session();
    s.receive(snapshot([presence(["b"])]));
    expect(view.working).toEqual(new Map([["a", "Claude: Building"]]));
    s.receive({ type: "presence", presence: [], listening: [] });
    expect(s.state.working.size).toBe(0);
  });

  it("replaces comments by id and notifies listeners", () => {
    const { session: s } = session();
    let calls = 0;
    const unsubscribe = s.subscribe(() => calls++);
    s.receive(snapshot());
    const comment: Comment = {
      id: "c1",
      artboardId: "a",
      nodeId: "b",
      x: 0,
      y: 0,
      resolved: false,
      createdAt: 0,
      messages: [],
      rev: 0,
    };
    s.receive({ type: "comment", comment });
    s.upsertComment({ ...comment, resolved: true, rev: 1 });
    expect([...s.state.comments.values()].map((c) => c.resolved)).toEqual([true]);
    expect(calls).toBe(3);
    unsubscribe();
    s.upsertComment({ ...comment, rev: 2 });
    expect(calls).toBe(3);
  });

  it("keeps a deleted comment gone when a late copy arrives", () => {
    const { session: s } = session();
    s.receive(snapshot());
    const comment: Comment = {
      id: "c1",
      artboardId: null,
      nodeId: null,
      x: 0,
      y: 0,
      resolved: false,
      createdAt: 0,
      messages: [],
      rev: 0,
    };
    s.receive({ type: "comment", comment });
    s.receive({ type: "commentDeleted", id: "c1" });
    s.upsertComment({ ...comment, rev: 1 });
    expect(s.state.comments.size).toBe(0);
  });

  it("keeps the newer copy of a comment when an older one arrives late", () => {
    const { session: s } = session();
    s.receive(snapshot());
    const comment: Comment = {
      id: "c1",
      artboardId: null,
      nodeId: null,
      x: 0,
      y: 0,
      resolved: false,
      createdAt: 0,
      messages: [],
      rev: 0,
    };
    // The agent's reply comes over the socket before the REST answer to ours.
    s.receive({ type: "comment", comment: { ...comment, resolved: true, rev: 2 } });
    s.upsertComment({ ...comment, rev: 1 });
    expect(s.state.comments.get("c1")?.resolved).toBe(true);
  });
});

describe("a person's edits", () => {
  const editing = () => {
    const { view, session: s } = session();
    const sent: Array<Record<string, unknown>> = [];
    s.setSender((data) => sent.push(JSON.parse(data) as Record<string, unknown>));
    s.receive(snapshot());
    return { view, s, sent };
  };
  const move = (left: string) =>
    [{ kind: "setStyles", ids: ["b"], styles: { left } }] as const satisfies ReadonlyArray<unknown>;
  const ours = (sent: Array<Record<string, unknown>>, i: number) =>
    sent[i]!.stamp as { client: string; mid: number };
  const change = (seq: number, left: string, mutation?: { client: string; mid: number }) =>
    ({
      type: "change",
      actorName: "Per",
      change: {
        seq,
        actor: "user:p",
        origin: "edit",
        label: "Change styles",
        ops: [{ op: "set", id: "b", key: "style:left", value: left }],
      },
      ...(mutation && { mutation }),
    }) satisfies DesignMessage;

  it("shows a draft, sends it on commit, and lands when its change comes back", async () => {
    const { s, sent } = editing();
    expect(s.draft(move("4px")).error).toBeNull();
    expect(s.replica.get("b")?.styles.left).toBe("4px");
    expect(sent).toHaveLength(0);
    const result = s.commit(move("4px"));
    expect(sent[0]).toMatchObject({ type: "mutate", edits: move("4px") });
    expect(s.replica.hasLocal).toBe(true);
    s.receive(change(4, "4px", ours(sent, 0)));
    await expect(result).resolves.toEqual({ kind: "landed" });
    expect(s.replica.hasLocal).toBe(false);
    expect(s.replica.get("b")?.styles.left).toBe("4px");
  });

  it("makes a component and detaches an instance with the server's plan", () => {
    const { s } = editing();
    expect(s.draft([{ kind: "makeComponent", id: "b", name: "Card" }]).error).toBeNull();
    expect(s.replica.get("b")).toMatchObject({ component: true, name: "Card" });
    expect(s.draft([{ kind: "detach", ids: ["b"] }]).error).toMatch(/isn't an instance/);
  });

  it("keeps its edit on top of someone else's change to the same node", () => {
    const { s, sent } = editing();
    void s.commit(move("4px"));
    s.receive(recolor(4));
    expect(s.replica.get("b")?.styles).toEqual({ left: "4px", color: "#4" });
    s.receive(change(5, "4px", ours(sent, 0)));
    expect(s.replica.hasLocal).toBe(false);
  });

  it("rolls a refused edit back once the changes before the answer arrived", async () => {
    const { s, sent } = editing();
    const result = s.commit(move("4px"));
    // The server ran an agent's change first, then refused ours.
    s.receive({ type: "settled", mid: ours(sent, 0).mid, seq: 4, error: 'node "b" not found' });
    expect(s.replica.get("b")?.styles.left).toBe("4px");
    s.receive(recolor(4));
    await expect(result).resolves.toEqual({ kind: "refused", message: 'node "b" not found' });
    expect(s.replica.get("b")?.styles).toEqual({ color: "#4" });
  });

  it("loses the draft when someone deletes what it moves", () => {
    const { s } = editing();
    const lost: string[] = [];
    s.onDraftLost((reason) => lost.push(reason));
    s.draft(move("4px"));
    s.receive({
      type: "change",
      actorName: "Claude",
      change: {
        seq: 4,
        actor: "agent:Claude",
        origin: "edit",
        label: "Delete",
        ops: [{ op: "delete", id: "b" }],
      },
    });
    expect(lost).toHaveLength(1);
    expect(s.replica.hasLocal).toBe(false);
  });

  it("sends unanswered edits again after resuming, and gives up on them after a snapshot", async () => {
    const { s, sent } = editing();
    s.setSender(null);
    const first = s.commit(move("4px"));
    expect(sent).toHaveLength(0);
    s.setSender((data) => sent.push(JSON.parse(data) as Record<string, unknown>));
    s.receive({
      type: "resume",
      changes: [],
      comments: [],
      presence: [],
      listening: [],
      meta: { id: "d", name: "Landing", createdAt: 0, updatedAt: 0 },
    });
    expect(sent.map((m) => m.type)).toEqual(["mutate"]);
    s.receive(snapshot());
    await expect(first).resolves.toEqual({ kind: "lost" });
    expect(s.replica.hasLocal).toBe(false);
  });

  it("ends the gesture when a snapshot replaces the document it was drawn on", () => {
    const { s } = editing();
    const lost: string[] = [];
    s.onDraftLost((reason) => lost.push(reason));
    s.draft(move("4px"));
    s.receive(snapshot());
    expect(lost).toEqual(["The design reloaded."]);
    expect(s.replica.get("b")?.styles.left).toBeUndefined();
  });

  it("undoes on the server and resolves with the change", async () => {
    const { s, sent } = editing();
    const undone = s.undo();
    expect(sent[0]).toMatchObject({ type: "undo", author: { name: "Guest" } });
    s.receive({
      ...change(4, "0px", ours(sent, 0)),
      change: { ...change(4, "0px").change, origin: "undo" },
    });
    await expect(undone).resolves.toEqual({ kind: "landed" });
  });
});

describe("DesignSession.subscribeDoc", () => {
  it("tells panels about the tab's own drafts and edits before the server answers", () => {
    const { session: s } = session();
    s.setSender(() => {});
    s.receive(snapshot());
    const changes: Array<{ origin: string; touched: string[]; structural: boolean }> = [];
    s.subscribeDoc((c) =>
      changes.push({ origin: c.origin, touched: [...c.touched], structural: c.structural }),
    );
    s.draft([{ kind: "setStyles", ids: ["b"], styles: { color: "red" } }]);
    expect(changes).toEqual([{ origin: "draft", touched: ["b"], structural: false }]);
    const version = s.state.version;
    // The draft's own edits show already, so committing them changes nothing on screen.
    void s.commit([{ kind: "setStyles", ids: ["b"], styles: { color: "red" } }]);
    expect(changes).toHaveLength(1);
    void s.commit([{ kind: "place", ids: ["b"], parent: null, before: null }]);
    expect(changes[1]).toMatchObject({ origin: "local", structural: true });
    expect(changes[1]!.touched).toEqual(expect.arrayContaining(["b", "a"]));
    expect(s.state.version).toBe(version + 1);
  });

  it("adds a page at once, with the id the server will give it", () => {
    const { session: s } = session();
    s.setSender(() => {});
    s.receive(snapshot());
    let pages = false;
    s.subscribeDoc((c) => (pages ||= c.pages));
    void s.commit([{ kind: "createPage", name: "Flows" }]);
    expect(pages).toBe(true);
    expect(s.state.pages.map((p) => p.name)).toEqual(["Page 1", "Flows"]);
  });
});
