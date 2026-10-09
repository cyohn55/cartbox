/**
 * The holographic HUD (HALO_INFINITE_STYLE_ROADMAP.md I12): holo documents in
 * the UI model, the vector stroke font, and the renderer that draws them —
 * arcs filled by their binding, a radar with its blips, text at any size,
 * glow that fades to nothing, and the curve toward the screen's edges.
 */

import { describe, expect, it } from "vitest";
import {
  BLIP_RGB,
  LOCKOUT_CODE,
  RADAR_SWEEP_SPEED,
  RADAR_SWEEP_STEP,
  createHoloCache,
  LOCKOUT_UI,
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  glyphSegments,
  hasGlyph,
  holoSource,
  holoTarget,
  layoutStrokeText,
  parseUiDocuments,
  renderHoloDocument,
  segmentDistance,
  strokeTextWidth,
  type UiDocument,
  type UiWidget,
  holoBindingKeys,
} from "@cartbox/editor";

const W = 400, H = 300;
const blank = () => new Uint8ClampedArray(W * H * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0));
const lit = (out: Uint8ClampedArray, x: number, y: number) => out[(y * W + x) * 4 + 2]! > 128;
const holo = (widgets: UiWidget[], extra: Partial<UiDocument> = {}): UiDocument => ({ name: "h", style: "holo", widgets, ...extra });
const at = (w: Omit<UiWidget, "anchor" | "pivot">): UiWidget => ({ anchor: [0, 0], pivot: [0, 0], ...w } as UiWidget);

describe("holo documents", () => {
  it("read their style, curve, glow and the holo fields, clamped", () => {
    const [doc] = parseUiDocuments([
      { name: "hud", style: "holo", curve: 3, glow: -1, widgets: [{ kind: "arc", id: "a", size: [10, 10], rgb: [2, 0.5, -1], start: -900, sweep: 120, thickness: 0, segments: 99, textSize: 1 }] },
    ]);
    expect(doc).toMatchObject({ style: "holo", curve: 1, glow: 0 });
    expect(doc!.widgets[0]).toMatchObject({ kind: "arc", rgb: [1, 0.5, 0], start: -720, sweep: 120, thickness: 0.5, segments: 64, textSize: 2 });
    // A console document ignores a curve.
    expect(parseUiDocuments([{ name: "menu", curve: 0.5, widgets: [] }])[0]).toEqual({ name: "menu", widgets: [] });
  });
});

describe("the stroke font", () => {
  it("has every digit and capital, reads lowercase as capitals, and draws the rest as a box", () => {
    for (const ch of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ./-:%") expect(hasGlyph(ch), ch).toBe(true);
    expect(glyphSegments("a")).toEqual(glyphSegments("A"));
    expect(hasGlyph("~")).toBe(false);
    expect(glyphSegments("~").length).toBe(4);
    // Every stroke stays in its cell.
    for (const ch of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      for (const s of glyphSegments(ch)) for (const v of [s[0], s[2]]) expect(v >= 0 && v <= GLYPH_WIDTH, ch).toBe(true);
    }
  });

  it("lays text out at any height, aligned in its span", () => {
    expect(strokeTextWidth("AB", 12)).toBeCloseTo((GLYPH_ADVANCE + GLYPH_WIDTH) * (12 / GLYPH_HEIGHT), 9);
    const left = layoutStrokeText("1", 0, 0, 100, 30, "left")[0]!;
    const right = layoutStrokeText("1", 0, 0, 100, 30, "right")[0]!;
    expect(left.x0).toBe(0);
    expect(right.x1).toBeCloseTo(100, 9);
    expect(segmentDistance(5, 3, [0, 0, 10, 0])).toBe(3);
    expect(segmentDistance(13, 4, [0, 0, 10, 0])).toBe(5);
  });
});

describe("the renderer", () => {
  it("lights an arc's share of its sweep and only dims the rest", () => {
    const out = blank();
    renderHoloDocument(out, W, H, holo([at({ id: "a", kind: "arc", offset: [50, 50], size: [200, 200], value: "v", start: -90, sweep: 180, thickness: 6 })]), { bindings: { v: 0.5 }, time: 0 });
    // Centre (150, 150), radius 97, from the left end over the top: lit up to the top, not past it.
    expect(lit(out, 53, 150)).toBe(true);
    expect(lit(out, 81, 81)).toBe(true); // 45° from the start
    expect(lit(out, 198, 66)).toBe(false); // 30° past the top
    expect(out[(150 * W + 247) * 4 + 2]!).toBeGreaterThan(20); // the dim track is there…
    expect(out[(150 * W + 247) * 4 + 2]!).toBeLessThan(110); // …dimly
    expect(out[(200 * W + 150) * 4 + 2]!).toBe(0); // below the arc: nothing
  });

  it("draws a radar's blips in their colours", () => {
    const out = blank();
    renderHoloDocument(out, W, H, holo([at({ id: "r", kind: "radar", offset: [100, 50], size: [200, 200], value: "b" })]), { bindings: { b: [0.5, 0, 1, -0.5, 0, 2] }, time: 0 });
    const px = (x: number, y: number) => Array.from(out.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
    const r = 100 - 1.5;
    const hostile = px(Math.round(200 + 0.5 * r), 150);
    const objective = px(Math.round(200 - 0.5 * r), 150);
    expect(hostile[0]!).toBeGreaterThan(hostile[2]!); // red
    expect(Math.abs(hostile[0]! - BLIP_RGB[1]![0] * 255)).toBeLessThan(30);
    expect(objective[1]!).toBeGreaterThan(objective[2]!); // gold
  });

  it("draws text, and leaves out what is bound invisible", () => {
    const text = at({ id: "t", kind: "text", offset: [20, 20], size: [300, 40], text: "{n}", textSize: 40, visible: "on" });
    const draw = (on: boolean) => {
      const out = blank();
      renderHoloDocument(out, W, H, holo([text]), { bindings: { n: 88, on }, time: 0 });
      return out;
    };
    const count = (out: Uint8ClampedArray) => out.filter((v, i) => i % 4 === 2 && v > 128).length;
    expect(count(draw(true))).toBeGreaterThan(100);
    expect(count(draw(false))).toBe(0);
  });

  it("glows round its lines, fading smoothly to nothing", () => {
    const out = blank();
    renderHoloDocument(out, W, H, holo([at({ id: "p", kind: "panel", offset: [100, 100], size: [200, 100] })], { glow: 1 }), { bindings: {}, time: 0 });
    const blue = (y: number) => out[(y * W + 200) * 4 + 2]!;
    // Moving away above the panel's top edge (y 100): bright, then fading, then nothing.
    expect(blue(100)).toBeGreaterThan(150);
    expect(blue(95)).toBeGreaterThan(blue(90));
    expect(blue(90)).toBeGreaterThan(blue(85));
    expect(blue(60)).toBe(0);
    for (let y = 60; y < 99; y += 1) expect(blue(y + 1) - blue(y)).toBeGreaterThanOrEqual(-1); // no step anywhere
  });

  it("curves toward the edges: a corner's widget lands nearer the centre, the middle's stays put", () => {
    expect(holoSource(W / 2, H / 2, W, H, 1)).toEqual([W / 2, H / 2]);
    const [sx, sy] = holoSource(380, 280, W, H, 1);
    expect(sx).toBeGreaterThan(380);
    expect(sy).toBeGreaterThan(280);
    const [tx, ty] = holoTarget(sx, sy, W, H, 1);
    expect(tx).toBeCloseTo(380, 3);
    expect(ty).toBeCloseTo(280, 3);
    // The same panel in a corner, curved: its lit pixels sit further in.
    const panel = at({ id: "p", kind: "panel", offset: [330, 240], size: [50, 40] });
    const centroid = (curve: number) => {
      const out = blank();
      renderHoloDocument(out, W, H, holo([panel], { curve }), { bindings: {}, time: 0 });
      let sx2 = 0, n = 0;
      for (let i = 0; i < W * H; i += 1) if (out[i * 4 + 2]! > 128) { sx2 += i % W; n += 1; }
      return sx2 / n;
    };
    expect(centroid(1)).toBeLessThan(centroid(0) - 2);
  });
});

describe("the layer cache", () => {
  const doc = holo([
    at({ id: "a", kind: "arc", offset: [50, 50], size: [200, 200], value: "v", start: -90, sweep: 180, segments: 6 }),
    at({ id: "r", kind: "radar", offset: [220, 120], size: [150, 150], value: "b" }),
    at({ id: "t", kind: "text", offset: [20, 260], size: [200, 20], text: "{n}", textSize: 16 }),
  ], { curve: 0.4 });
  const frame = (bindings: Record<string, unknown>, time: number, cache?: ReturnType<typeof createHoloCache>) => {
    const out = blank();
    renderHoloDocument(out, W, H, doc, { bindings, time }, cache);
    return out;
  };

  it("draws exactly what an uncached draw does, frame after frame, as bindings change and the sweep turns", () => {
    const cache = createHoloCache();
    const states = [
      [{ v: 0.5, b: [0.2, 0.3, 1], n: 32 }, 0],
      [{ v: 0.5, b: [0.2, 0.3, 1], n: 32 }, 0.01],
      [{ v: 0.75, b: [0.2, 0.3, 1], n: 31 }, 0.5],
      [{ v: 0.75, b: [-0.4, 0.1, 2], n: 31 }, 0.5],
    ] as const;
    for (const [bindings, time] of states) expect(Buffer.from(frame(bindings, time, cache)).equals(Buffer.from(frame(bindings, time)))).toBe(true);
  });

  it("keeps a layer per widget, with the radar's sweep apart, and redraws only a changed one", () => {
    const cache = createHoloCache();
    frame({ v: 0.5, b: [], n: 1 }, 0, cache);
    expect(cache.layers.size).toBe(4); // arc, text, radar and its sweep
    const before = new Map(cache.layers);
    frame({ v: 0.5, b: [], n: 2 }, 0, cache);
    const changed = [...cache.layers].filter(([id, l]) => before.get(id) !== l).map(([id]) => id);
    expect(changed).toEqual(["h/2/0"]);
    // The sweep moves in steps: within one, nothing is redrawn.
    const held = new Map(cache.layers);
    frame({ v: 0.5, b: [], n: 2 }, (RADAR_SWEEP_STEP * 0.5) / RADAR_SWEEP_SPEED, cache);
    expect([...cache.layers].every(([id, l]) => held.get(id) === l)).toBe(true);
  });
});

describe("Lockout's visor", () => {
  const visor = LOCKOUT_UI.find((d) => d.name === "visor")!;

  it("is a curved holo document carrying the shield arc, the tracker and the ammo counter, which the console HUD no longer draws", () => {
    expect(visor).toMatchObject({ style: "holo" });
    expect(visor.curve).toBeGreaterThan(0);
    expect(visor.widgets.find((w) => w.id === "shield")).toMatchObject({ kind: "arc", value: "shieldf" });
    expect(visor.widgets.find((w) => w.id === "tracker")).toMatchObject({ kind: "radar", value: "blips" });
    expect(visor.widgets.find((w) => w.id === "rounds")?.text).toBe("{rounds}");
    const hud = LOCKOUT_UI.find((d) => d.name === "hud")!;
    for (const id of ["shield", "health", "ammo", "weapon"]) expect(hud.widgets.some((w) => w.id === id), id).toBe(false);
  });

  it("is shown and fed by the cart: every key it reads is one the code sets", () => {
    expect(LOCKOUT_CODE).toContain('U.show("visor")');
    for (const k of holoBindingKeys([visor])) expect(LOCKOUT_CODE, k).toContain(`U.set("${k}"`);
  });

  it("lights its shield arc to the shield's share", () => {
    const w = 1280, h = 720;
    const draw = (shieldf: number) => {
      const out = new Uint8ClampedArray(w * h * 4);
      renderHoloDocument(out, w, h, { ...visor, widgets: visor.widgets.filter((x) => x.id === "shield") }, { bindings: { shieldf }, time: 0 });
      return out.filter((v, i) => i % 4 === 2 && v > 160).length;
    };
    expect(draw(1)).toBeGreaterThan(draw(0.5) * 1.5);
    expect(draw(0.5)).toBeGreaterThan(draw(0) + 100);
  });
});
