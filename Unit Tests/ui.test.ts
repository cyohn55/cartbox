/**
 * The UI system (ENGINE_PARITY_ROADMAP.md EP13): anchors laying documents out
 * for any screen, focus navigation by position, bindings in text, reading
 * documents defensively — and the generated cartbox.ui running in the real
 * engine: drawing at the laid-out pixels, hiding by a binding, a bar's fill,
 * a list's selection, focus moving with the d-pad and A pressing.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { fillUiText, layoutUi, newUiWidget, parseUiDocuments, uiNavigation, type UiDocument } from "@cartbox/editor";
import { NET_WORDS, RAM_LAYOUTS, codeChunks, injectSdk, toConsolePixel, uiSdkLua, writePointer } from "@cartbox/player";
import { debugBlockAddress } from "../packages/player/src/debug/debugBlock";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const W = 1280, H = 720;

const MENU: UiDocument = {
  name: "menu",
  widgets: [
    {
      id: "frame", kind: "panel", anchor: [0.5, 0.5], pivot: [0.5, 0.5], offset: [0, 0], size: [400, 300], fill: 1, border: 12,
      children: [
        { id: "title", kind: "text", anchor: [0.5, 0], pivot: [0.5, 0], offset: [0, 10], size: [380, 20], text: "Score {score}", color: 12, scale: 2, align: "center" },
        { id: "modes", kind: "list", anchor: [0.5, 0], pivot: [0.5, 0], offset: [0, 50], size: [360, 120], value: "items", row: 30, color: 13, focusFill: 9, focusColor: 12, scale: 2 },
        { id: "go", kind: "button", anchor: [0.25, 1], pivot: [0.5, 1], offset: [0, -20], size: [150, 32], text: "Go", fill: 5, focusFill: 6, color: 13, focusColor: 12, scale: 2, align: "center" },
        { id: "quit", kind: "button", anchor: [0.75, 1], pivot: [0.5, 1], offset: [0, -20], size: [150, 32], text: "Quit", fill: 5, focusFill: 6, color: 13, focusColor: 12, scale: 2, align: "center" },
      ],
    },
  ],
};

const HUD: UiDocument = {
  name: "hud",
  widgets: [
    { id: "health", kind: "bar", anchor: [0, 0], pivot: [0, 0], offset: [40, 40], size: [204, 20], fill: 5, color: 6, value: "hp" },
    { id: "tag", kind: "text", anchor: [1, 1], pivot: [1, 1], offset: [-20, -20], size: [100, 12], text: "HI", color: 9, visible: "showtag" },
  ],
};

describe("layout and navigation", () => {
  it("places widgets by anchor, pivot and offset, children inside their parent, for any screen", () => {
    const placed = layoutUi(MENU, W, H);
    const at = (id: string) => placed.find((p) => p.widget.id === id)!;
    expect([at("frame").x, at("frame").y]).toEqual([440, 210]); // centred
    expect(at("frame").descendants).toBe(4);
    expect([at("title").x, at("title").y]).toEqual([450, 220]);
    expect([at("go").x, at("go").y]).toEqual([440 + 100 - 75, 210 + 300 - 20 - 32]);
    // The same document on a smaller screen stays centred.
    expect(layoutUi(MENU, 640, 480)[0]!.x).toBe(120);
    // A corner-anchored widget hugs its corner.
    const tag = layoutUi(HUD, W, H)[1]!;
    expect([tag.x + tag.w, tag.y + tag.h]).toEqual([W - 20, H - 20]);
  });

  it("moves focus to the nearest focusable widget in the direction pressed", () => {
    const placed = layoutUi(MENU, W, H);
    const nav = uiNavigation(placed);
    const index = (id: string) => placed.findIndex((p) => p.widget.id === id);
    const [up, down, left, right] = nav.get(index("go"))!;
    expect(up).toBe(index("modes"));
    expect(right).toBe(index("quit"));
    expect(left).toBe(-1);
    expect(down).toBe(-1);
    expect(nav.get(index("modes"))![1]).toBe(index("go")); // down from the list: the nearer button
    expect(nav.has(index("title"))).toBe(false); // text isn't focusable
  });

  it("fills {key} placeholders from bindings", () => {
    expect(fillUiText("Score {score} / {target}{none}", { score: 3, target: 25 })).toBe("Score 3 / 25");
  });

  it("reads documents defensively", () => {
    const docs = parseUiDocuments([
      { name: "a", widgets: [{ kind: "text", id: "t", text: "x", color: 99, scale: 9, anchor: [2, -1] }, { kind: "laser" }, { kind: "text", id: "t" }] },
      { name: "a", widgets: [] },
      { name: "bad name!", widgets: [] },
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.widgets.map((w) => w.id)).toEqual(["t", "t_"]);
    expect(docs[0]!.widgets[0]).toMatchObject({ color: 15, scale: 4, anchor: [1, 0] });
    expect(parseUiDocuments(JSON.parse(JSON.stringify([MENU, HUD])))).toEqual([MENU, HUD]);
    expect(newUiWidget("list", "l").value).toBe("items");
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.ui in the real engine", () => {
  async function run(code: string, inputs: number[]) {
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, uiSdkLua([MENU, HUD], W, H));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const frames: Uint8Array[] = [];
    for (const mask of inputs) {
      mod._cbx_tick(h, mask);
      const sp = mod._cbx_screen_ptr(h);
      frames.push(Uint8Array.from(mod.HEAPU8.subarray(sp, sp + W * H * 4)));
    }
    const pmem = new Int32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, 256);
    const out = Array.from(pmem.slice(100, 110));
    mod._cbx_delete(h);
    return { frames, out };
  }
  const px = (f: Uint8Array, x: number, y: number) => Array.from(f.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)).join(",");

  it("draws documents where they're laid out, hides by a binding, fills a bar", async () => {
    const { frames } = await run(
      `
function TIC()
  cls(0)
  -- swatches of the palette colours the widgets use, to compare against
  rect(0, 0, 4, 4, 1) rect(4, 0, 4, 4, 5) rect(8, 0, 4, 4, 6) rect(12, 0, 4, 4, 9)
  cartbox.ui.set("hp", 0.5)
  cartbox.ui.set("items", {"Slayer", "Oddball", "King"})
  cartbox.ui.show("hud")
  cartbox.ui.show("menu")
  cartbox.ui.update()
  cartbox.ui.draw()
end`,
      [0],
    );
    const f = frames[0]!;
    const sw = (k: number) => px(f, k * 4 + 1, 1);
    expect(px(f, 445, 350)).toBe(sw(0)); // inside the frame panel (fill 1), away from text
    expect(px(f, 464, 210 + 50 + 5)).toBe(sw(3)); // the list's selected row (row 1): its focus fill, 9
    // The bar: half full of colour 6 over its fill 5.
    expect(px(f, 42 + 50, 50)).toBe(sw(2));
    expect(px(f, 42 + 150, 50)).toBe(sw(1));
    // The tag is hidden (its binding is unset): the corner stays clear.
    expect(px(f, W - 30, H - 25)).toBe(px(f, 600, 5));
  });

  it("moves the list's selection, then focus, with the d-pad, and A presses", async () => {
    const DOWN = 2, RIGHT = 8, A = 16;
    const { out } = await run(
      `
local t = 0
function TIC()
  t = t + 1
  cls(0)
  cartbox.ui.set("items", {"Slayer", "Oddball", "King"})
  cartbox.ui.show("menu")
  cartbox.ui.on("quit", function() pmem(103, 77) end)
  local id, v = cartbox.ui.update()
  if id == "modes" then pmem(100, v) end
  if id == "go" then pmem(101, 1) end
  pmem(102, cartbox.ui.selected("modes"))
  local f = cartbox.ui.focused("menu")
  pmem(104, f == "modes" and 1 or f == "go" and 2 or f == "quit" and 3 or 0)
  cartbox.ui.draw()
end`,
      // down, down (to row 3), down (leaves the list for the button), right (quit), A
      [0, DOWN, 0, DOWN, 0, DOWN, 0, RIGHT, 0, A, 0],
    );
    expect(out[2]).toBe(3); // the list's selection reached row 3
    expect(out[4]).toBe(3); // focus ended on Quit
    expect(out[3]).toBe(77); // its handler ran
    expect(out[0]).toBe(0); // the list was never pressed
  });
});

describe("the editor and storage", () => {
  it("adds documents and widgets (inside panels), changes, reorders and removes them, and stores them", async () => {
    const { emptyMeshSidecar, encodeMeshSidecar, decodeMeshSidecar } = await import("../apps/web/src/lib/meshSidecar");
    const ui = await import("../apps/web/src/lib/uiEdit");
    let sc = ui.addUiDocument(emptyMeshSidecar(), "pause").sidecar;
    const second = ui.addUiDocument(sc, "pause");
    expect(second.name).toBe("pause2");
    sc = second.sidecar;
    let doc = ui.uiDocuments(sc)[0]!;
    const panel = ui.addWidget(doc, "panel");
    doc = panel.doc;
    const inside = ui.addWidget(doc, "button", panel.id);
    doc = inside.doc;
    const other = ui.addWidget(doc, "text");
    doc = other.doc;
    expect(ui.flattenWidgets(doc.widgets).map((f) => [f.widget.id, f.depth])).toEqual([["panel1", 0], ["button1", 1], ["text1", 0]]);
    doc = ui.updateWidget(doc, "button1", { text: "Resume", fill: undefined });
    expect(ui.findWidget(doc, "button1")).toMatchObject({ text: "Resume" });
    expect("fill" in ui.findWidget(doc, "button1")!).toBe(false);
    doc = ui.reorderWidget(doc, "text1", -1);
    expect(doc.widgets.map((w) => w.id)).toEqual(["text1", "panel1"]);
    sc = ui.replaceUiDocument(sc, "pause", doc);
    const back = decodeMeshSidecar(encodeMeshSidecar(sc));
    expect(back.ui).toEqual(sc.ui);
    // The player's option reads the same documents from the stored sidecar.
    const { readSidecarUi } = await import("@cartbox/player");
    expect(readSidecarUi(encodeMeshSidecar(sc))).toEqual(sc.ui);
    doc = ui.removeWidget(doc, "panel1");
    expect(ui.findWidget(doc, "button1")).toBeNull(); // its children went with it
    expect(ui.removeUiDocument(ui.removeUiDocument(sc, "pause"), "pause2").ui).toBeUndefined();
  });

  it("reads preview bindings typed in the editor", async () => {
    const { parsePreviewBindings, sampleBindings } = await import("../apps/web/src/lib/uiPreview");
    expect(parsePreviewBindings("score=12; items=A,B,C; live=true; name=Bob; bad key=1")).toEqual({ score: 12, items: ["A", "B", "C"], live: true, name: "Bob" });
    expect(sampleBindings(MENU)).toEqual({ score: "{score}", items: ["First", "Second", "Third"] });
  });
});

describe("Lockout", () => {
  it("ships its HUD and menu as UI documents, and its code drives them", async () => {
    const { LOCKOUT_CODE, LOCKOUT_UI, lockoutMeshSidecar } = await import("@cartbox/editor");
    const { readSidecarUi } = await import("@cartbox/player");
    expect(readSidecarUi(lockoutMeshSidecar())).toEqual(LOCKOUT_UI);
    expect(LOCKOUT_UI.map((d) => d.name)).toEqual(["hud", "menu"]);
    for (const call of ['U.show("hud")', 'U.show("menu")', "U.update()", 'U.set("feed"', 'U.set("modes"']) expect(LOCKOUT_CODE).toContain(call);
    // Every binding the documents read is one the code sets.
    const keys = new Set<string>();
    const visit = (widgets: readonly { text?: string; value?: string; visible?: string; tint?: string; children?: readonly unknown[] }[]) => {
      for (const w of widgets) {
        for (const m of (w.text ?? "").matchAll(/\{(\w+)\}/g)) keys.add(m[1]!);
        for (const k of [w.value, w.visible, w.tint]) if (k) keys.add(k);
      }
    };
    for (const d of LOCKOUT_UI) visit(d.widgets);
    for (const k of keys) expect(LOCKOUT_CODE, k).toContain(`"${k}"`);
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.ui with the pointer (mouse and taps)", () => {
  const LAYOUT = RAM_LAYOUTS.xbox360;
  type Pointer = { x: number; y: number; over?: boolean; down?: boolean; clicks: number };
  async function run(code: string, pointers: Pointer[]) {
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, uiSdkLua([MENU, HUD], W, H, debugBlockAddress(LAYOUT)));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const pmemBase = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const out: number[][] = [];
    for (const p of pointers) {
      const at = pmemBase + debugBlockAddress(LAYOUT) - LAYOUT.pmemAddress;
      writePointer(new DataView(mod.HEAPU8.buffer, at, 64), { over: true, down: false, ...p });
      mod._cbx_tick(h, 0);
      out.push(Array.from(new Int32Array(mod.HEAPU8.buffer, pmemBase, 256).slice(100, 105)));
    }
    mod._cbx_delete(h);
    return out;
  }
  const CART = `
t, presses = 0, 0
IDS = { modes = 1, go = 2, quit = 3 }
function TIC()
  t = t + 1
  cartbox.ui.set("items", {"Slayer", "Oddball", "King"})
  if t >= 5 and t < 9 then cartbox.ui.hide("menu") else cartbox.ui.show("menu") end
  local id, v = cartbox.ui.update()
  if id then presses = presses + 1; pmem(103, IDS[id]); pmem(104, tonumber(v) or 0) end
  pmem(100, presses)
  pmem(101, cartbox.ui.selected("modes"))
  pmem(102, IDS[cartbox.ui.focused("menu") or ""] or 0)
end`;

  it("points at a list row to select it, clicks to press it, and clicks a button", async () => {
    // The menu's list rows are 30 px from y 260; its "Go" button is at (465..615, 458..490).
    const out = await run(CART, [
      { x: 500, y: 330, clicks: 0 }, // over row 3: selects it
      { x: 500, y: 330, clicks: 1 }, // click: presses the list with row 3
      { x: 540, y: 470, clicks: 2 }, // onto "Go" with a click: focuses and presses it
      { x: 540, y: 470, clicks: 2 }, // resting: nothing more
    ]);
    expect(out[0]).toEqual([0, 3, 1, 0, 0]);
    expect(out[1]).toEqual([1, 3, 1, 1, 3]);
    expect(out[2]).toEqual([2, 3, 2, 2, 0]);
    expect(out[3]).toEqual([2, 3, 2, 2, 0]);
  });

  it("ignores clicks made while no document was being updated, and the pointer off the screen", async () => {
    const out = await run(CART, [
      { x: 500, y: 300, clicks: 0 },
      { x: 500, y: 300, clicks: 0 },
      { x: 500, y: 300, clicks: 0 },
      { x: 500, y: 300, clicks: 0 },
      { x: 500, y: 300, clicks: 1 }, // the menu is hidden (ticks 5..8): these clicks aren't for it
      { x: 500, y: 300, clicks: 2 },
      { x: 500, y: 300, clicks: 3 },
      { x: 500, y: 300, clicks: 4 },
      { x: 500, y: 300, clicks: 4 }, // shown again: no phantom press
      { x: 500, y: 330, over: false, clicks: 5 }, // off the screen: ignored
      { x: 500, y: 330, clicks: 6 }, // back over row 3 and clicked
    ]);
    expect(out[8]![0]).toBe(0);
    expect(out[9]![0]).toBe(0);
    expect(out[10]).toEqual([1, 3, 1, 1, 3]);
  });
});

describe("the pointer's console pixel", () => {
  it("maps a point on the page into the scaled screen, and knows when it's off it", () => {
    const rect = { left: 100, top: 50, width: 640, height: 360 }; // a 1280×720 screen shown at half size
    expect(toConsolePixel(100, 50, rect, { width: 1280, height: 720 })).toEqual({ x: 0, y: 0, over: true });
    expect(toConsolePixel(420, 230, rect, { width: 1280, height: 720 })).toEqual({ x: 640, y: 360, over: true });
    expect(toConsolePixel(90, 230, rect, { width: 1280, height: 720 }).over).toBe(false);
    expect(toConsolePixel(740, 230, rect, { width: 1280, height: 720 }).over).toBe(false);
    expect(toConsolePixel(0, 0, { left: 0, top: 0, width: 0, height: 0 }, { width: 1280, height: 720 }).over).toBe(false);
  });
});
