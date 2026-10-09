/**
 * Holo UI documents at runtime (HALO_INFINITE_STYLE_ROADMAP.md I12): the
 * cart's Lua sends which holo documents are shown and what their bindings hold
 * — once a frame, only what changed — and the host decodes it; the console's
 * own drawing leaves holo documents to the host.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { holoBindingKeys, holoDocuments, type UiDocument } from "@cartbox/editor";
import { NET_WORDS, codeChunks, injectSdk, uiSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { PHYS_OP_UI_LIST, PHYS_OP_UI_NUM, PHYS_OP_UI_SHOW, PHYS_OP_UI_TEXT, type PhysicsCommand } from "../packages/player/src/physics/protocol";
import { RuntimeChannel } from "../packages/player/src/runtime/runtimeChannel";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const W = 1280, H = 720;

const CONSOLE: UiDocument = { name: "menu", widgets: [{ id: "t", kind: "text", anchor: [0, 0], pivot: [0, 0], offset: [0, 0], size: [100, 10], text: "{title}", color: 12 }] };
const HOLO: UiDocument = {
  name: "visor",
  style: "holo",
  widgets: [
    { id: "shield", kind: "arc", anchor: [0.5, 0], pivot: [0.5, 0], offset: [0, 10], size: [200, 200], value: "sh" },
    { id: "ammo", kind: "text", anchor: [1, 1], pivot: [1, 1], offset: [-10, -10], size: [200, 30], text: "{ammo} / {reserve}", textSize: 30, visible: "armed" },
    { id: "tracker", kind: "radar", anchor: [0, 1], pivot: [0, 1], offset: [10, -10], size: [150, 150], value: "blips" },
  ],
};

describe("holo bindings", () => {
  it("are listed alike by the cart and the host: every key a holo document reads, sorted, and none of a console one's", () => {
    expect(holoDocuments([CONSOLE, HOLO]).map((d) => d.name)).toEqual(["visor"]);
    expect(holoBindingKeys([CONSOLE, HOLO])).toEqual(["ammo", "armed", "blips", "reserve", "sh"]);
  });
});

describe("the host", () => {
  const channel = () => new RuntimeChannel({ instances: [], bounds: { center: [0, 0, 0], radius: 1 }, lighting: null } as never, null);
  const cmd = (op: number, a: number, ...v: number[]): PhysicsCommand => ({ op, a, v: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0, v[4] ?? 0, v[5] ?? 0] });
  const pack = (s: string) => Array.from({ length: Math.ceil(s.length / 2) }, (_, i) => s.charCodeAt(i * 2) * 256 + (s.charCodeAt(i * 2 + 1) || 0));

  it("shows and hides documents, and takes numbers, texts in chunks and lists in chunks", () => {
    const c = channel();
    const text = "32 / 96 and a long tail";
    const codes = pack(text);
    c.applyCommands([
      cmd(PHYS_OP_UI_SHOW, 0, 1),
      cmd(PHYS_OP_UI_NUM, 4, 0.75),
      cmd(PHYS_OP_UI_TEXT, 0, text.length, ...codes.slice(0, 5)),
      cmd(PHYS_OP_UI_TEXT, 0 | (1 << 16), ...codes.slice(5, 11)),
      cmd(PHYS_OP_UI_TEXT, 0 | (2 << 16), ...codes.slice(11, 17)),
      cmd(PHYS_OP_UI_LIST, 2, 7, 0.5, -0.25, 1, 0.1, 0.2),
      cmd(PHYS_OP_UI_LIST, 2 | (1 << 16), 2, 0.3, 0, 0, 0, 0),
    ]);
    expect([...c.holo.shown]).toEqual([0]);
    expect(c.holo.values.get(4)).toBe(0.75);
    expect(c.holo.values.get(0)).toBe(text);
    expect(c.holo.values.get(2)).toEqual([0.5, -0.25, 1, 0.1, 0.2, 2, 0.3]);
    c.applyCommands([cmd(PHYS_OP_UI_SHOW, 0, 0)]);
    expect(c.holo.shown.size).toBe(0);
  });

  it("waits for a string's last chunk, and drops a stray chunk", () => {
    const c = channel();
    c.applyCommands([cmd(PHYS_OP_UI_TEXT, 1, 14, ...pack("0123456789"))]);
    expect(c.holo.values.has(1)).toBe(false);
    c.applyCommands([cmd(PHYS_OP_UI_TEXT, 1 | (1 << 16), ...pack("ABCD"))]);
    expect(c.holo.values.get(1)).toBe("0123456789ABCD");
    c.applyCommands([cmd(PHYS_OP_UI_TEXT, 3 | (1 << 16), ...pack("x"))]);
    expect(c.holo.values.has(3)).toBe(false);
  });
});

describe.skipIf(!existsSync(ENGINE))("the cart's Lua, in the real engine", () => {
  /** Run `code` for `ticks` frames with a stand-in for the runtime's command writer that logs to pmem. */
  async function run(code: string, ticks: number) {
    const harness = `
local LOG = {}
cartbox._cmd = function(op, a, v1, v2, v3, v4, v5, v6)
  LOG[#LOG + 1] = {op, a, v1 or 0, v2 or 0, v3 or 0, v4 or 0, v5 or 0, v6 or 0}
  return true
end
local function dump()
  pmem(100, #LOG)
  for i, c in ipairs(LOG) do for k = 1, 8 do pmem(100 + (i - 1) * 8 + k, math.floor(c[k] * 1024)) end end
end
${code}`;
    let tic = codeChunks(new TextEncoder().encode(harness));
    tic = prependLuaCode(tic, uiSdkLua([CONSOLE, HOLO], W, H));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    for (let i = 0; i < ticks; i += 1) mod._cbx_tick(h, 0);
    const pmem = new Int32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, 256);
    const n = pmem[100]!;
    const log = Array.from({ length: n }, (_, i) => Array.from(pmem.slice(101 + i * 8, 109 + i * 8)).map((v, k) => (k === 1 ? v / 1024 : v / 1024)));
    mod._cbx_delete(h);
    return log.map(([op, a, ...v]) => ({ op: Math.round(op!), a: Math.round(a!), v: v.map((x) => Math.round(x! * 1024) / 1024) }));
  }

  it("sends a shown holo document and its bindings once, then only what changes", async () => {
    const log = await run(
      `
local t = 0
function TIC()
  t = t + 1
  cls(0)
  cartbox.ui.set("sh", 0.5)
  cartbox.ui.set("ammo", t < 2 and 32 or 31)
  cartbox.ui.set("reserve", 96)
  cartbox.ui.set("armed", true)
  cartbox.ui.set("blips", {0.5, -0.5, 1})
  cartbox.ui.set("title", "plain")
  cartbox.ui.show("visor")
  cartbox.ui.draw()
  if t == 3 then dump() end
end`,
      3,
    );
    const keys = holoBindingKeys([CONSOLE, HOLO]);
    const key = (k: string) => keys.indexOf(k);
    expect(log.filter((c) => c.op === PHYS_OP_UI_SHOW)).toEqual([{ op: PHYS_OP_UI_SHOW, a: 0, v: [1, 0, 0, 0, 0, 0] }]);
    const nums = log.filter((c) => c.op === PHYS_OP_UI_NUM);
    // sh, ammo (32 then 31), reserve and armed: each sent when it changed, and only then.
    expect(nums.map((c) => [keys[c.a], c.v[0]]).sort()).toEqual([["ammo", 31], ["ammo", 32], ["armed", 1], ["reserve", 96], ["sh", 0.5]]);
    expect(log.filter((c) => c.op === PHYS_OP_UI_LIST)).toEqual([{ op: PHYS_OP_UI_LIST, a: key("blips"), v: [3, 0.5, -0.5, 1, 0, 0] }]);
    // The console document's binding never goes to the host.
    expect(log.some((c) => c.op === PHYS_OP_UI_TEXT)).toBe(false);
  });
});
