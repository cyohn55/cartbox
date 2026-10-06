/**
 * The dedicated Modern core (ENGINE_PARITY_ROADMAP.md EP20b): a Lua 5.4 VM
 * with a direct scripting API, compiled to WebAssembly. Covers running a cart
 * (its top level, TIC, errors with their line), the 2D layer's pixels and
 * printed text, input, the direct API (commands reaching the host as they're
 * made, in order, with no cap; queries answered in the same call), the
 * sandbox, determinism, and speed.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { RuntimeChannel, parseMeshScene } from "@cartbox/player";
import { createModernCore, type ModernCoreFactory, type ModernCoreHost } from "../packages/modern-core/src/index";
import { PHYS_OP_PLACE, type PhysicsCommand } from "../packages/player/src/physics/protocol";

const CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

async function core(code: string, host: Partial<ModernCoreHost> = {}, size = { width: 320, height: 180 }, seed = 7) {
  const factory = (await import(pathToFileURL(CORE).href)).default as ModernCoreFactory;
  const c = await createModernCore(factory, { ...size, seed, host: { command: () => {}, query: () => null, ...host } });
  const ok = c.load(code);
  return { c, ok };
}

/** The RGBA of a pixel. */
const px = (frame: Uint8ClampedArray, width: number, x: number, y: number) => Array.from(frame.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
const SWEETIE = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];

describe.skipIf(!existsSync(CORE))("the Modern core", () => {
  it("runs a cart: its top level once, TIC every tick, with the HD core's clock (0 on the first frame, then frames × 1/60 s)", async () => {
    const seen: number[][] = [];
    const { c, ok } = await core(
      `
n = 0
cartbox.command(1, 100)
function TIC() n = n + 1 cartbox.command(2, n, time()) end`,
      { command: (op, a, v1) => seen.push([op, a, Math.round(v1)]) },
    );
    expect(ok).toBe(true);
    for (let i = 0; i < 3; i += 1) expect(c.tick()).toBe(true);
    expect(seen).toEqual([
      [1, 100, 0],
      [2, 1, 0],
      [2, 2, 33],
      [2, 3, 50],
    ]);
  });

  it("reports errors with the cart's line and a traceback, and keeps running", async () => {
    const bad = await core(`x = = 1`);
    expect(bad.ok).toBe(false);
    expect(bad.c.error()).toMatch(/^cart:1:/);
    const { c } = await core(`
t = 0
function TIC()
  t = t + 1
  if t == 2 then error("boom") end
end`);
    expect(c.tick()).toBe(true);
    expect(c.tick()).toBe(false);
    expect(c.error()).toMatch(/cart:5: boom/);
    expect(c.error()).toContain("traceback");
    expect(c.tick()).toBe(true);
  });

  it("draws the 2D layer in palette colours: cls, rect, rectb, line, circ, tri, pix", async () => {
    const { c } = await core(`
function TIC()
  cls(2)
  rect(10, 10, 20, 10, 5)
  rectb(40, 10, 20, 10, 12)
  line(0, 100, 99, 100, 9)
  circ(150, 50, 10, 4)
  tri(200, 10, 260, 10, 200, 70, 11)
  pix(300, 170, 3)
  cartbox.command(1, pix(300, 170), pix(15, 15))
  _cbx_palette(200, 1, 2, 3)
  pix(301, 170, 200)
end`, { command: (op, a, v1) => reads.push(a, v1) });
    const reads: number[] = [];
    c.tick();
    const f = c.frame();
    const w = c.width;
    expect(px(f, w, 0, 0)).toEqual(SWEETIE(0xb13e53));
    expect(px(f, w, 15, 15)).toEqual(SWEETIE(0xa7f070));
    expect(px(f, w, 9, 15)).toEqual(SWEETIE(0xb13e53)); // just outside the rect
    expect(px(f, w, 40, 15)).toEqual(SWEETIE(0xf4f4f4)); // rectb's edge
    expect(px(f, w, 50, 15)).toEqual(SWEETIE(0xb13e53)); // its hollow middle
    expect(px(f, w, 0, 100)).toEqual(SWEETIE(0x3b5dc9));
    expect(px(f, w, 99, 100)).toEqual(SWEETIE(0x3b5dc9));
    expect(px(f, w, 150, 50)).toEqual(SWEETIE(0xffcd75));
    expect(px(f, w, 159, 50)).toEqual(SWEETIE(0xffcd75));
    expect(px(f, w, 150, 61)).toEqual(SWEETIE(0xb13e53));
    expect(px(f, w, 205, 15)).toEqual(SWEETIE(0x73eff7)); // inside the triangle
    expect(px(f, w, 255, 60)).toEqual(SWEETIE(0xb13e53)); // outside its hypotenuse
    expect(px(f, w, 300, 170)).toEqual(SWEETIE(0xef7d57));
    expect(px(f, w, 301, 170)).toEqual([1, 2, 3, 255]);
    expect(reads).toEqual([3, 5]);
  });

  it("prints in TIC-80's own font, measured exactly as TIC-80 measures it", async () => {
    const widths: number[] = [];
    const { c } = await core(
      `function TIC() cls(0) cartbox.command(1, print("A", 10, 20, 12), print("SCORE 10", 0, 100, 4, false, 2), print("small", 0, 150, 3, false, 1, true), print("Hi there", 0, 160, 5)) end`,
      { command: (_op, a, v1, v2, v3) => widths.push(a, v1, v2, v3) },
    );
    c.tick();
    expect(widths).toEqual([6, 90, 20, 43]);
    // TIC-80's "A": a three-pixel top bar, two-pixel left legs.
    const f = c.frame();
    const ink = SWEETIE(0xf4f4f4);
    expect(px(f, c.width, 10, 20)).not.toEqual(ink);
    expect(px(f, c.width, 11, 20)).toEqual(ink);
    expect(px(f, c.width, 13, 20)).toEqual(ink);
    expect(px(f, c.width, 10, 21)).toEqual(ink);
    expect(px(f, c.width, 11, 21)).toEqual(ink);
    expect(px(f, c.width, 12, 21)).not.toEqual(ink);
    // Scale 2 doubles every pixel.
    expect(px(f, c.width, 0, 100)).toEqual(px(f, c.width, 1, 101));
  });

  it("emulates TIC-80's RAM: peek, poke (and in bits), pmem in its place, memcpy, memset", async () => {
    const out: number[] = [];
    const { c } = await core(
      `
function TIC()
  poke(1000, 300)
  poke(20001, 7, 4)
  pmem(5, 0x12345678)
  memcpy(4000, 1000, 1)
  memset(5000, 9, 3)
  cartbox.command(1, peek(1000), peek(20001, 4), peek4(20001))
  cartbox.command(2, pmem(5), peek(4000), peek(5002))
end`,
      { command: (op, a, v1, v2) => out.push(op, a, v1, v2) },
    );
    c.tick();
    expect(out).toEqual([1, 44, 7, 7, 2, 0x12345678, 44, 9]);
    // pmem word 5 sits at the HD core's pmem address in the RAM the host sees.
    const ram = c.ram();
    const at = 3068512 + 5 * 4;
    expect(ram[at]! | (ram[at + 1]! << 8) | (ram[at + 2]! << 16) | (ram[at + 3]! << 24)).toBe(0x12345678);
    expect(ram[10000]).toBe(7 << 4); // nibble 20001 is byte 10000's high half
  });

  it("reads the console buttons: held, and pressed this tick", async () => {
    const out: number[] = [];
    const { c } = await core(`function TIC() cartbox.command(1, btn(4) and 1 or 0, btnp(4) and 1 or 0, btn()) end`, { command: (_op, a, v1, v2) => out.push(a, v1, v2) });
    c.tick(0);
    c.tick(1 << 4);
    c.tick(1 << 4);
    c.tick(0);
    expect(out).toEqual([0, 0, 0, 1, 1, 16, 1, 0, 16, 0, 0, 0]);
  });

  it("calls the host directly: 100,000 commands in one tick arrive in order, and a query answers in the same call", async () => {
    let count = 0;
    let inOrder = true;
    const { c } = await core(
      `
function TIC()
  for i = 1, 100000 do cartbox.command(34, i, i * 0.5, 0, 0, 0, 0, 1) end
  local a, b, s = cartbox.query(7, 3, 4)
  cartbox.command(99, a + b + s)
  cartbox.command(98, cartbox.query(8) == nil and 1 or 0)
end`,
      {
        command: (op, a, v1) => {
          if (op === 34) {
            count += 1;
            if (a !== count || v1 !== count * 0.5) inOrder = false;
          } else last.push([op, a]);
        },
        query: (op, a, v1) => (op === 7 ? [a, v1, a * v1] : null),
      },
    );
    const last: number[][] = [];
    expect(c.tick()).toBe(true);
    expect(count).toBe(100000);
    expect(inOrder).toBe(true);
    expect(last).toEqual([
      [99, 19],
      [98, 1],
    ]);
  });

  it("drives the same 3D runtime the other cores use: 5,000 placements in a tick, applied in order", async () => {
    const box: MeshAsset = { name: "b", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
    const scene = parseMeshScene(
      JSON.stringify({ version: 2, meshes: [{ id: "a", name: "crate", mesh: serializeMeshAsset(box), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], timelines: [{ name: "t", duration: 1, tracks: [] }] }),
    )!;
    const channel = new RuntimeChannel(scene, null);
    const tick: PhysicsCommand[] = [];
    const { c } = await core(`function TIC() for i = 1, 5000 do cartbox.command(${PHYS_OP_PLACE}, 0 | (256 << 16), i, 2, 3, 0, 0, 0) end end`, {
      command: (op, a, v1, v2, v3, v4, v5, v6) => tick.push({ op, a, v: [v1, v2, v3, v4, v5, v6] }),
    });
    c.tick();
    expect(tick.length).toBe(5000);
    channel.applyCommands(tick);
    const m = channel.placements().get(0)!;
    expect([m[12], m[13], m[14]]).toEqual([5000, 2, 3]);
    channel.destroy();
  });

  it("is sandboxed: no io, os, package, require, dofile or loadfile", async () => {
    const out: number[] = [];
    const { c } = await core(`function TIC() cartbox.command(1, (io == nil and os == nil and package == nil and require == nil and dofile == nil and loadfile == nil) and 1 or 0, load("return 2")()) end`, {
      command: (_op, a, v1) => out.push(a, v1),
    });
    c.tick();
    expect(out).toEqual([1, 2]);
  });

  it("is deterministic: the same seed gives the same random numbers", async () => {
    const draw = async (seed: number) => {
      const out: number[] = [];
      const { c } = await core(`function TIC() for i = 1, 5 do cartbox.command(1, math.random(1000000)) end end`, { command: (_op, a) => out.push(a) }, { width: 8, height: 8 }, seed);
      c.tick();
      return out;
    };
    expect(await draw(42)).toEqual(await draw(42));
    expect(await draw(42)).not.toEqual(await draw(43));
  });

  it("runs Lua fast and grows its memory as a cart needs", async () => {
    const out: number[] = [];
    const { c } = await core(
      `
function TIC()
  local s = 0
  for i = 1, 5000000 do s = s + i % 7 end
  local t = {}
  for i = 1, 200000 do t[i] = { i, tostring(i) } end
  cartbox.command(1, s, #t)
end`,
      { command: (_op, a, v1) => out.push(a, v1) },
      { width: 1280, height: 720 },
    );
    const start = performance.now();
    expect(c.tick()).toBe(true);
    const ms = performance.now() - start;
    expect(out).toEqual([15000000, 200000]);
    expect(c.memoryKb()).toBeGreaterThan(10_000);
    expect(ms).toBeLessThan(4000);
  });
});
