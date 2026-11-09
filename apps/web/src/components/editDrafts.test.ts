import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ColorEdit } from "./ColorPicker";
import type { StyleEdit } from "./inspector/styleEditor";

// There's no DOM to render into here, so components run on these hooks: state changes render
// again when the event is over, as React flushes a discrete event, and effects run once.
const hooks = vi.hoisted(() => {
  type Cell = { value: unknown };
  type Instance = { cells: Cell[]; at: number; cleanups: Array<() => void>; dirty: boolean };
  let active: Instance | null = null;
  const cell = (first: () => unknown) => {
    const i = active!;
    return (i.cells[i.at++] ??= { value: first() });
  };
  const useState = (first: unknown) => {
    const i = active!;
    const c = cell(() => (typeof first === "function" ? first() : first));
    const set = (next: unknown) => {
      c.value = typeof next === "function" ? next(c.value) : next;
      i.dirty = true;
    };
    return [c.value, set];
  };
  const useRef = (first: unknown) => cell(() => ({ current: first })).value;
  const useEffect = (effect: () => void | (() => void)) => {
    const i = active!;
    cell(() => {
      const cleanup = effect();
      if (cleanup) i.cleanups.push(cleanup);
      return null;
    });
  };
  const mount = <T>(component: () => T) => {
    const i: Instance = { cells: [], at: 0, cleanups: [], dirty: false };
    const render = () => {
      active = i;
      i.at = 0;
      i.dirty = false;
      const out = component();
      active = null;
      return out;
    };
    const view = {
      now: render(),
      /** Runs one event, then renders what it changed. */
      act(event: () => void) {
        event();
        while (i.dirty) view.now = render();
      },
      unmount: () => i.cleanups.forEach((c) => c()),
    };
    return view;
  };
  return { mount, useState, useRef, useEffect };
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useEffect,
}));
vi.mock("@stylexjs/stylex", () => ({ create: () => ({}), props: () => ({}) }));
vi.mock("@/styles/tokens.stylex", () => {
  const any: object = new Proxy(
    {},
    {
      get: (_, key) => (key === Symbol.toPrimitive ? () => "" : any),
    },
  );
  return {
    colors: any,
    cursors: any,
    face: any,
    fonts: any,
    motion: any,
    radii: any,
    shadows: any,
    size: any,
    space: any,
  };
});
vi.mock("@/client/finite", () => ({ finite: {} }));
vi.mock("./ColorPicker", () => ({ ColorPicker: () => null }));

const { useDraftField } = await import("./DraftField");
const { createStyleEditor } = await import("./inspector/styleEditor");
const { ColorSwatch } = await import("./TokensPanel");

const color = (value: string): StyleEdit[] => [
  { kind: "setStyles", ids: ["a"], styles: { color: value } },
];
/** Like a color field: three digits only read as a color once they're finished. */
const toEdits = (text: string, done: boolean) =>
  text.length === 6 || (done && text.length === 3) ? color(`#${text}`) : null;

const setup = () => {
  const send = vi.fn(async (_groups: unknown) => {});
  const editor = createStyleEditor(() => ({ frameId: "f", loc: "src/a.tsx:1:1" }), send);
  const field = hooks.mount(() => useDraftField(editor, "", toEdits));
  const type = (value: string) =>
    field.act(() =>
      field.now.props.onChange({ target: { value } } as React.ChangeEvent<HTMLInputElement>),
    );
  const blur = () => field.act(() => field.now.props.onBlur());
  const press = () =>
    field.act(() => {
      editor.drive(
        { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as PointerEvent,
        new EventTarget() as HTMLElement,
        { move: () => null },
      );
    });
  const sent = () => send.mock.calls.map(([groups]) => groups);
  return { editor, field, type, blur, press, sent };
};
const sentColor = (value: string) => [{ locs: ["src/a.tsx:1:1"], styles: { color: value } }];

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});

describe("a field whose draft is taken over", () => {
  it("sends text that only reads as a value once finished", () => {
    const { type, press, blur, sent } = setup();
    type("1");
    type("1f");
    type("1f3");
    press();
    blur();
    expect(sent()).toEqual([sentColor("#1f3")]);
  });

  it("sends a whole value once, not again when the blur follows", () => {
    const { type, press, blur, sent } = setup();
    type("112233");
    press();
    blur();
    expect(sent()).toEqual([sentColor("#112233")]);
  });

  it("stops typing into the draft it lost", () => {
    const { type, press, field } = setup();
    type("1f3");
    expect(field.now.typing).toBe(true);
    press();
    expect(field.now.typing).toBe(false);
  });

  it("starts a new draft when typed into again", () => {
    const { type, press, blur, sent } = setup();
    type("1f3");
    press();
    type("445566");
    blur();
    expect(sent()).toEqual([sentColor("#1f3"), sentColor("#445566")]);
  });

  it("is told when another field begins too", () => {
    const { editor, field, type, sent } = setup();
    type("1f3");
    field.act(() => editor.begin());
    expect(field.now.typing).toBe(false);
    expect(sent()).toEqual([sentColor("#1f3")]);
  });
});

describe("a field that goes away", () => {
  it("sends what was typed, read as finished", () => {
    const { type, field, sent } = setup();
    type("1f3");
    field.unmount();
    expect(sent()).toEqual([sentColor("#1f3")]);
  });
});

describe("createStyleEditor", () => {
  it("doesn't tell a draft that's already finished", () => {
    const { editor } = setup();
    const onLost = vi.fn();
    editor.begin({ onLost }).commit();
    editor.begin();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("still sends a draft's last preview when its owner doesn't finish it", () => {
    const { editor, sent } = setup();
    const onLost = vi.fn();
    editor.begin({ onLost }).preview(color("#112233"));
    editor.begin();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([sentColor("#112233")]);
  });
});

describe("ColorSwatch", () => {
  const pick = { hex: "#112233", alpha: 100, part: "color" } as const;
  type Tree = ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;

  const setupSwatch = () => {
    let saved = "#000000";
    const onPick = vi.fn((c: string) => (saved = c));
    const swatch = hooks.mount(
      () => ColorSwatch({ name: "--brand", color: saved, onPick }) as Tree,
    );
    const button = () => swatch.now.props.children[0]!;
    const picker = () =>
      swatch.now.props.children[1] as unknown as ReactElement<{
        edit: ColorEdit;
        onClose: () => void;
      }>;
    swatch.act(() => (button().props.ref as (b: object) => void)({}));
    const open = () => swatch.act(() => (button().props.onClick as () => void)());
    const background = () => (button().props.style as { background: string }).background;
    const change = (to: string) => (saved = to);
    return { swatch, picker, open, background, change, onPick };
  };

  /** Pressing outside: `close` runs, then the picker unmounts and finishes its open gesture. */
  const pressOutside = (s: ReturnType<typeof setupSwatch>) => {
    const { edit, onClose } = s.picker().props;
    s.swatch.act(() => onClose());
    s.swatch.act(() => edit.commit(pick));
  };

  it("holds no pick once the picker has closed", () => {
    const s = setupSwatch();
    s.open();
    s.swatch.act(() => s.picker().props.edit.preview(pick));
    pressOutside(s);
    expect(s.onPick.mock.calls).toEqual([["#112233"]]);
    s.change("#445566");
    s.open();
    expect(s.background()).toBe("#445566");
  });

  it("never saves an old pick over a newer value when reopened and closed", () => {
    const s = setupSwatch();
    s.open();
    s.swatch.act(() => s.picker().props.edit.preview(pick));
    pressOutside(s);
    s.change("#445566");
    s.open();
    s.swatch.act(() => s.picker().props.onClose());
    expect(s.onPick).toHaveBeenCalledTimes(1);
  });

  it("still keeps a gesture that finishes while the picker is open", () => {
    const s = setupSwatch();
    s.open();
    s.swatch.act(() => s.picker().props.edit.preview(pick));
    s.swatch.act(() => s.picker().props.edit.commit(pick));
    s.swatch.act(() => s.picker().props.onClose());
    expect(s.onPick.mock.calls).toEqual([["#112233"]]);
  });
});
