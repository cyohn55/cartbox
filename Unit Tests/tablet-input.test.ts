/**
 * The tablet input layer (TABLET_EDITOR_ROADMAP.md T1): pointer samples,
 * pressure, pick reach, and the recogniser that turns a Pencil, fingers and a
 * mouse into tool strokes, orbit and pinch zoom, undo/redo taps and long
 * presses — driven here with scripted pointer sequences.
 */

import { describe, expect, it } from "vitest";

import {
  GestureRecognizer,
  pickReachNdc,
  pressureBrush,
  samplePointer,
  strokePressure,
  withModifiers,
  type GestureEvent,
  type PointerKind,
  type PointerSample,
} from "../apps/web/src/lib/tabletInput";

let clock = 0;
const at = (kind: PointerKind, id: number, x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample => ({
  id,
  kind,
  x,
  y,
  t: clock,
  button: 0,
  buttons: 1,
  pressure: kind === "pen" ? 0.5 : 1,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});
const types = (events: GestureEvent[]) => events.map((e) => e.type);

describe("samples", () => {
  it("reads a Pencil's force, and full strength for a mouse or a finger", () => {
    const base = { pointerId: 3, clientX: 10, clientY: 20, timeStamp: 5, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
    expect(samplePointer({ ...base, pointerType: "pen", buttons: 1, pressure: 0.3, tiltX: 20, tiltY: -5, twist: 90 })).toMatchObject({ kind: "pen", pressure: 0.3, tiltX: 20, twist: 90 });
    // Safari may report 0 on first contact: a floor keeps the dab.
    expect(samplePointer({ ...base, pointerType: "pen", buttons: 1, pressure: 0 }).pressure).toBe(0.05);
    expect(samplePointer({ ...base, pointerType: "pen", buttons: 0, pressure: 0 }).pressure).toBe(0); // hovering
    expect(samplePointer({ ...base, pointerType: "touch", buttons: 1, pressure: 0.5 }).pressure).toBe(1);
    expect(samplePointer({ ...base, pointerType: "mouse", buttons: 1, pressure: 0.5 }).kind).toBe("mouse");
  });

  it("scales a brush by Pencil pressure on a gentle curve, and leaves a mouse and a finger at full", () => {
    expect(strokePressure({ kind: "mouse", pressure: 0.2 })).toBe(1);
    expect(strokePressure({ kind: "touch", pressure: 0.2 })).toBe(1);
    expect(strokePressure({ kind: "pen", pressure: 1 })).toBe(1);
    const light = strokePressure({ kind: "pen", pressure: 0.2 });
    expect(light).toBeGreaterThan(0.2); // light touches stay usable
    expect(light).toBeLessThan(strokePressure({ kind: "pen", pressure: 0.6 }));
    expect(strokePressure({ kind: "pen", pressure: 0 })).toBe(0.08);
  });

  it("reaches further for a fingertip than a Pencil, and a Pencil further than a mouse", () => {
    const w = 600;
    expect(pickReachNdc("touch", w)).toBeGreaterThan(pickReachNdc("pen", w));
    expect(pickReachNdc("pen", w)).toBeGreaterThan(pickReachNdc("mouse", w));
    expect(pickReachNdc("touch", w)).toBeCloseTo(24 / 300, 6);
    // Never tighter than the canvas's own radius.
    expect(pickReachNdc("mouse", w, 0.05)).toBe(0.05);
  });

  it("lets the touch bar's toggles stand in for held keys", () => {
    const s = at("touch", 1, 0, 0);
    expect(withModifiers(s, { add: true, remove: false, loop: true })).toMatchObject({ shiftKey: true, ctrlKey: false, altKey: true });
    expect(withModifiers(s, { add: false, remove: false, loop: false })).toBe(s);
  });

  it("scales the texture brush's size and opacity by pressure, as chosen", () => {
    expect(pressureBrush(10, 0.8, 1, "both")).toEqual({ radius: 10, opacity: 0.8 });
    expect(pressureBrush(10, 0.8, 0.5, "both")).toEqual({ radius: 7, opacity: 0.4 });
    expect(pressureBrush(10, 0.8, 0.5, "size")).toEqual({ radius: 7, opacity: 0.8 });
    expect(pressureBrush(10, 0.8, 0.5, "opacity")).toEqual({ radius: 10, opacity: 0.4 });
    expect(pressureBrush(10, 0.8, 0.5, "off")).toEqual({ radius: 10, opacity: 0.8 });
  });
});

describe("the recogniser", () => {
  it("passes a mouse straight through, right button and all, and reports hover", () => {
    const g = new GestureRecognizer();
    expect(types(g.move(at("mouse", 1, 5, 5, { buttons: 0 })))).toEqual(["hover"]);
    expect(g.down(at("mouse", 1, 5, 5, { button: 2, buttons: 2 }))).toEqual([{ type: "tool-down", sample: expect.objectContaining({ button: 2 }) }]);
    expect(types(g.move(at("mouse", 1, 9, 5, { buttons: 2 })))).toEqual(["tool-move"]);
    expect(types(g.up(at("mouse", 1, 9, 5, { buttons: 0 })))).toEqual(["tool-up"]);
  });

  it("draws one stroke with the Pencil under a resting palm, the palm ignored", () => {
    const g = new GestureRecognizer();
    const out: GestureEvent[] = [];
    out.push(...g.down(at("pen", 7, 100, 100)));
    // The palm lands, moves about and lifts while the Pencil draws.
    out.push(...g.down(at("touch", 20, 300, 400)));
    out.push(...g.move(at("pen", 7, 110, 104)));
    out.push(...g.move(at("touch", 20, 320, 410)));
    out.push(...g.down(at("touch", 21, 340, 420)));
    out.push(...g.move(at("touch", 21, 360, 440)));
    out.push(...g.move(at("pen", 7, 120, 108)));
    out.push(...g.up(at("touch", 20, 320, 410)));
    out.push(...g.up(at("pen", 7, 120, 108)));
    out.push(...g.up(at("touch", 21, 360, 440)));
    expect(types(out)).toEqual(["tool-down", "tool-move", "tool-move", "tool-up"]);
    expect(g.penSeen).toBe(true);
  });

  it("drops a palm already resting when the Pencil lands, cancelling any stroke it began", () => {
    const g = new GestureRecognizer();
    expect(g.down(at("touch", 1, 0, 0))).toEqual([]);
    expect(types(g.move(at("touch", 1, 30, 0)))).toEqual(["tool-down", "tool-move"]); // a finger drawing (no Pencil yet)
    expect(types(g.down(at("pen", 2, 50, 50)))).toEqual(["tool-cancel", "tool-down"]);
    expect(g.move(at("touch", 1, 40, 0))).toEqual([]);
    expect(types(g.up(at("pen", 2, 50, 50)))).toEqual(["tool-up"]);
    expect(g.up(at("touch", 1, 40, 0))).toEqual([]);
  });

  it("holds a finger back until it moves, so a quick tap picks and a drag strokes", () => {
    const g = new GestureRecognizer();
    expect(g.down(at("touch", 1, 50, 50))).toEqual([]);
    expect(g.move(at("touch", 1, 53, 51))).toEqual([]); // within the slop
    expect(types(g.up(at("touch", 1, 53, 51)))).toEqual(["tool-down", "tool-up"]);
    g.down(at("touch", 2, 50, 50));
    const drawn = g.move(at("touch", 2, 70, 50));
    expect(types(drawn)).toEqual(["tool-down", "tool-move"]);
    expect((drawn[0] as { sample: PointerSample }).sample).toMatchObject({ x: 50, y: 50 }); // the stroke starts where the finger landed
    expect(types(g.up(at("touch", 2, 70, 50)))).toEqual(["tool-up"]);
  });

  it("turns a finger into a pinch when a second lands, cancelling the stroke it had begun", () => {
    const g = new GestureRecognizer();
    g.down(at("touch", 1, 100, 100));
    expect(types(g.move(at("touch", 1, 120, 100)))).toEqual(["tool-down", "tool-move"]);
    expect(types(g.down(at("touch", 2, 220, 100)))).toEqual(["tool-cancel"]);
    // Spread apart: zoom in about the centre; slide: orbit.
    const spread = g.move(at("touch", 2, 320, 100));
    expect(spread.find((e) => e.type === "zoom")).toMatchObject({ factor: 2 });
    const slide = [...g.move(at("touch", 1, 120, 140)), ...g.move(at("touch", 2, 320, 140))];
    const orbit = slide.filter((e) => e.type === "orbit") as { dx: number; dy: number }[];
    expect(orbit.reduce((a, e) => a + e.dy, 0)).toBeCloseTo(40, 6);
    clock += 1000;
    expect(g.up(at("touch", 1, 120, 140))).toEqual([]);
    expect(g.up(at("touch", 2, 320, 140))).toEqual([]); // moved: no undo
  });

  it("pans with two fingers where the canvas pans, and always with three", () => {
    const g = new GestureRecognizer({ drag: "pan" });
    g.down(at("touch", 1, 0, 0));
    g.down(at("touch", 2, 100, 0));
    expect(types(g.move(at("touch", 1, 10, 0)))).toContain("pan");
    const three = new GestureRecognizer();
    three.down(at("touch", 1, 0, 0));
    three.down(at("touch", 2, 100, 0));
    three.down(at("touch", 3, 50, 80));
    expect(types(three.move(at("touch", 3, 50, 90)))).toContain("pan");
  });

  it("undoes on a quick two-finger tap and redoes on a three-finger tap", () => {
    const g = new GestureRecognizer();
    clock = 10_000;
    g.down(at("touch", 1, 100, 100));
    g.down(at("touch", 2, 200, 100));
    clock += 120;
    expect(g.up(at("touch", 1, 100, 100))).toEqual([]);
    expect(types(g.up(at("touch", 2, 200, 100)))).toEqual(["undo"]);
    g.down(at("touch", 1, 100, 100));
    g.down(at("touch", 2, 200, 100));
    g.down(at("touch", 3, 150, 180));
    clock += 150;
    g.up(at("touch", 3, 150, 180));
    g.up(at("touch", 2, 200, 100));
    expect(types(g.up(at("touch", 1, 100, 100)))).toEqual(["redo"]);
    // A slow two-finger touch is no tap.
    g.down(at("touch", 1, 100, 100));
    g.down(at("touch", 2, 200, 100));
    clock += 900;
    g.up(at("touch", 1, 100, 100));
    expect(g.up(at("touch", 2, 200, 100))).toEqual([]);
  });

  it("fires a long press once for a finger held still, and then nothing until it lifts", () => {
    const g = new GestureRecognizer();
    clock = 20_000;
    g.down(at("touch", 1, 40, 40));
    expect(g.tick(clock + 200)).toEqual([]);
    expect(types(g.tick(clock + 520))).toEqual(["long-press"]);
    expect(g.tick(clock + 900)).toEqual([]);
    expect(g.move(at("touch", 1, 90, 40))).toEqual([]);
    expect(g.up(at("touch", 1, 90, 40))).toEqual([]);
    // A finger that moved first is no long press.
    g.down(at("touch", 2, 40, 40));
    g.move(at("touch", 2, 60, 40));
    expect(g.tick(clock + 2000)).toEqual([]);
  });

  it("navigates with one finger once a Pencil has been used, a tap still picking", () => {
    const g = new GestureRecognizer();
    g.down(at("pen", 9, 0, 0));
    g.up(at("pen", 9, 0, 0));
    expect(g.fingersDraw()).toBe(false);
    g.down(at("touch", 1, 100, 100));
    g.move(at("touch", 1, 104, 100));
    const orbit = g.move(at("touch", 1, 130, 100));
    expect(orbit).toEqual([{ type: "orbit", dx: 26, dy: 0 }]);
    expect(g.up(at("touch", 1, 130, 100))).toEqual([]);
    g.down(at("touch", 2, 60, 60));
    expect(types(g.up(at("touch", 2, 61, 60)))).toEqual(["tool-down", "tool-up"]);
    // Forced: fingers draw again.
    g.setOptions({ fingers: "draw" });
    expect(g.fingersDraw()).toBe(true);
  });

  it("reports a hovering Pencil, and abandons a stroke the browser cancels", () => {
    const g = new GestureRecognizer();
    expect(types(g.move(at("pen", 4, 10, 10, { buttons: 0, pressure: 0 })))).toEqual(["hover"]);
    g.down(at("pen", 4, 10, 10));
    expect(types(g.cancel(at("pen", 4, 10, 10)))).toEqual(["tool-cancel"]);
  });
});
