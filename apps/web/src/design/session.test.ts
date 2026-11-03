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
    s.receive({ type: "presence", presence: [] });
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
