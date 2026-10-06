/**
 * The dedicated Modern core against the TIC-80–derived HD core it stands in for
 * (ENGINE_PARITY_ROADMAP.md EP20b parts 3 and 4): the same cartridge, ticked
 * with the same buttons on both, must give the same frame, pixel for pixel, and
 * the same RAM, byte for byte, every tick. The carts cover the whole 2D API
 * (shapes, text, sprites, the map, flags, textured triangles, the font, clip,
 * paint), vbanks and the OVR/SCN/BDR callbacks, the palette and its per-line
 * changes, banks and sync, input, sound and music (their registers, every
 * tick), and Lockout itself.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_ACCESSIBILITY, LOCKOUT_STRINGS, lockoutCartridge, lockoutMeshSidecar } from "@cartbox/editor";
import {
  INPUT_BLOCK_BYTES,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  actionsSdkLua,
  appendLuaCode,
  codeChunks,
  commandRingAddress,
  commandRingBytes,
  componentsSdkLua,
  createConsole,
  createDirectConsole,
  getModel,
  hasCommandRing,
  injectSdk,
  inputBlockAddress,
  parseMeshScene,
  physicsBlockAddress,
  playLanguage,
  prependLuaCode,
  readSidecarActions,
  readSidecarUi,
  runtimeSdkLua,
  saveSdkLua,
  sceneObjectsSdkLua,
  seedCartridge,
  stringsSdkLua,
  takePhysicsCommands,
  takeRingCommands,
  uiSdkLua,
  writeInputBlock,
  writeInputSettings,
  type ConsoleInstance,
  type DirectConsole,
} from "@cartbox/player";
import { PHYS_CMDS, PHYS_CMD_BYTES, PHYS_FIX, PHYS_MAX_CMDS, type PhysicsCommand } from "../packages/player/src/physics/protocol";
import { resetCommandRing } from "../packages/player/src/runtime/commandRing";

const HD = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const DIRECT = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");
const LAYOUT = RAM_LAYOUTS.xbox360;
const W = 1280;

/** A command as the HD core's RAM channel carries it: each value floored to 1/1024 and kept to 32 bits (the SDK's _wr). */
const quantize = (c: PhysicsCommand): PhysicsCommand => {
  const word = (v: number) => Math.floor(v) | 0;
  return { op: word(c.op), a: word(c.a), v: c.v.map((v) => word(v * PHYS_FIX) / PHYS_FIX) as unknown as PhysicsCommand["v"] };
};

/** A .tic chunk. */
function chunk(type: number, data: Uint8Array, bank = 0): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out.set([type | (bank << 5), data.length & 0xff, (data.length >> 8) & 0xff, 0], 0);
  out.set(data, 4);
  return out;
}

function cart(code: string, ...chunks: Uint8Array[]): Uint8Array {
  const parts = [...chunks, codeChunks(new TextEncoder().encode(code))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Deterministic bytes. */
function bytes(n: number, seed: number, mod = 256): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: n }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 16) % mod;
  }, 60_000);
}

async function consoles(tic: Uint8Array): Promise<[ConsoleInstance, ConsoleInstance]> {
  const model = getModel("xbox360");
  const hd = createConsole(await (await import(pathToFileURL(HD).href)).default(), model, 44100);
  const direct = createDirectConsole(await (await import(pathToFileURL(DIRECT).href)).default(), model);
  expect(hd.loadCartridge(tic)).toBe(true);
  expect(direct.loadCartridge(tic)).toBe(true);
  return [hd, direct];
}

/** The first differing pixel, as "x,y hd=[...] direct=[...]", or null. */
function frameDiff(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length !== b.length) return `sizes ${a.length} vs ${b.length}`;
  if (Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length))) return null;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      const p = i / 4;
      let count = 0;
      for (let j = i; j < a.length; j += 4) if (a[j] !== b[j] || a[j + 1] !== b[j + 1] || a[j + 2] !== b[j + 2]) count += 1;
      return `${p % W},${Math.floor(p / W)} hd=[${Array.from(a.slice(i, i + 3))}] direct=[${Array.from(b.slice(i, i + 3))}] (${count} pixels differ)`;
    }
  }
  return null; // only alpha differs
}

/** The first differing RAM byte, as "address hd direct", or null; `skip` ranges aren't compared. */
function ramDiff(a: ConsoleInstance, b: ConsoleInstance, skip: readonly [number, number][] = []): string | null {
  const ra = a.ramView(-LAYOUT.pmemAddress, LAYOUT.ramSize)!;
  const rb = b.ramView(-LAYOUT.pmemAddress, LAYOUT.ramSize)!;
  const buf = (x: Uint8Array, from: number, to: number) => Buffer.from(x.buffer, x.byteOffset + from, to - from);
  const ranges: [number, number][] = [];
  let at = 0;
  for (const [from, to] of [...skip].sort((x, y) => x[0] - y[0])) {
    if (from > at) ranges.push([at, from]);
    at = Math.max(at, to);
  }
  if (at < ra.length) ranges.push([at, ra.length]);
  for (const [from, to] of ranges) {
    if (buf(ra, from, to).equals(buf(rb, from, to))) continue;
    for (let i = from; i < to; i += 1) {
      if (ra[i] !== rb[i]) {
        let count = 0;
        for (let j = i; j < to; j += 1) if (ra[j] !== rb[j]) count += 1;
        return `${i}: hd=${ra[i]} direct=${rb[i]} (${count} bytes differ)`;
      }
    }
  }
  return null;
}

/**
 * The font's spare parameter bytes (params[2..7] after width and height, for
 * each font). TIC-80 writes the font with a C union literal that leaves them
 * unspecified, so after a reset() the HD core's hold stack leftovers.
 */
const FONT = LAYOUT.pmemAddress + 1024 + 512;
const UNSPECIFIED: [number, number][] = [
  [FONT + 1018, FONT + 1024],
  [FONT + 1024 + 1018, FONT + 2048],
];

/** How many colours a frame shows (so a comparison can't pass on two blank screens). */
function colours(frame: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < frame.length; i += 4) seen.add((frame[i]! << 16) | (frame[i + 1]! << 8) | frame[i + 2]!);
  return seen.size;
}

/** Tick both `frames` times (buttons from `input`), comparing frame and RAM after each tick; the last frame's colour count. */
function compare(hd: ConsoleInstance, direct: ConsoleInstance, frames: number, input: (frame: number) => number = () => 0): number {
  for (let f = 0; f < frames; f += 1) {
    hd.tick(input(f));
    direct.tick(input(f));
    expect(direct.readError().message, `frame ${f}`).toBe("");
    expect(hd.readError().message, `frame ${f}`).toBe("");
    expect(frameDiff(hd.readFramebuffer(), direct.readFramebuffer()), `frame ${f}`).toBeNull();
    expect(ramDiff(hd, direct, UNSPECIFIED), `frame ${f}`).toBeNull();
  }
  return colours(hd.readFramebuffer());
}

describe.skipIf(!existsSync(HD) || !existsSync(DIRECT))("the dedicated core matches the HD core", () => {
  it("shapes, text, clip and paint", async () => {
    const [hd, direct] = await consoles(
      cart(`
t = 0
function TIC()
  t = t + 1
  cls(t % 16)
  rect(10.7, 20.2, 100, 50, 3) rect(-5, -5, 20, 20, 4) rect(1270, 700, 50, 50, 5)
  rectb(200, 20, 80, 40, 12) rectb(-3.5, 300, 10, 10, 6)
  line(0, 0, 1279, 719, 7) line(400.5, 10.25, 300.75, 200.5, 8) line(10, 400, 900, 401, 9) line(50, 600, 50, 650, 10)
  line(-100, -50, 2000, 900, 11) line(600, 100, 600 + t * 3, 100 - t, 14)
  circ(500, 300, 40 + t % 10, 2) circb(640, 360, 100, 12) circ(1280, 0, 30, 13) circb(-10, 720, 60, 1)
  elli(800, 200, 60, 20, 5) ellib(800, 300, 20, 60, 6) elli(900, 500, 0, 10, 7)
  tri(100, 500, 300.5, 450.25, 200, 700.75, 11) tri(1000, 100, 1100, 100, 1050, 100, 4) trib(700, 500, 800, 650, 650, 690, 15)
  pix(3, 3, 12) pix(1279, 719, 9) pix(-1, 5, 9) cartbox_p = pix(3, 3)
  print("HELLO, WORLD! 0123456789", 20, 650, 12)
  print("small font\\nsecond line", 20, 670, 3, false, 1, true)
  print("Fixed width", 300, 650, 4, true) print("BIG", 300, 670, 5, false, 3) print(12345.5, 500, 650, 6, true, 2, true)
  print(nil, 600, 650) print("colour 255 is clear", 700, 650, 255) print("neg", 800, 650, -3)
  clip(900, 400, 200, 150)
  cls(1) circ(1000, 450, 80, 3) print("CLIPPED TEXT GOES HERE", 880, 420, 12, false, 2)
  clip()
  rectb(1150, 400, 100, 100, 12) rectb(1170, 420, 60, 60, 12) paint(1160, 410, 8) paint(1200, 450, 9, 12)
  poke(0x3FF8 + 0, 0) -- harmless low RAM write
  rect(0, 710, peek(10) % 50, 5, peek4(3) + 1)
end`),
    );
    expect(compare(hd, direct, 6)).toBeGreaterThanOrEqual(14);
  }, 60_000);

  it("sprites, the map, flags, textured triangles and the font, from the cartridge's banks", async () => {
    const tiles = bytes(16384, 1, 20); // colours 0..19, some 0 (clear by default key)
    const sprites = bytes(16384, 2, 20);
    const map = bytes(1280 * 40, 3, 256);
    const flags = bytes(512, 4, 256);
    const palette = bytes(768, 5, 256);
    const [hd, direct] = await consoles(
      cart(
        `
t = 0
function remap(tile, x, y) if tile % 7 == 0 then return tile + 1, 1, 0 end return tile, (x + y) % 4, (x * y) % 4 end
function TIC()
  t = t + 1
  cls(0)
  for i = 0, 63 do spr(i * 5, (i % 16) * 20, (i // 16) * 20) end
  spr(300, 340, 0, 0, 2, 1, 1, 2, 2) spr(17, 400, 0, {0, 3, 5}, 3, 2, 2, 3, 1) spr(40, 500, 10, -1, 1, 3, 3, 4, 3) spr(260, 600, 10, 1, 4)
  spr(-1, 0, 0) spr(511, 700, 20, 0, 1, 0, 0, 2, 2)
  map(0, 0, 40, 20, 0, 100) map(t, 5, 30, 15, 330, 100, 0, 2) map(10, 10, 20, 10, 0, 300, {0, 1, 2}, 1, remap)
  map(-5, -3, 10, 10, -7, 500, -1, 3)
  mset(3, 4, 99) mset(-1, 0, 5) mset(5000, 0, 5)
  rect(0, 700, mget(3, 4), 5, 12) rect(200, 700, mget(1279, 719) % 100, 5, 11)
  fset(10, 3, true) fset(11, 7, false) fset(600, 2, true) fset(12, 9, true)
  if fget(10, 3) then rect(400, 700, 10, 10, 6) end if fget(600, 2) then rect(420, 700, 10, 10, 7) end
  if fget(12, 9) then rect(440, 700, 10, 10, 8) end if fget(13, 1) then rect(460, 700, 10, 10, 9) end
  ttri(700, 300, 900, 320, 750, 500, 0, 0, 64, 0, 0, 64)
  ttri(950, 300, 1150, 300, 950, 500, 0, 0, 128, 0, 0, 128, true, 0)
  ttri(700, 520, 900, 520, 700, 700, 0, 0, 32, 0, 0, 32, 0, {0, 1}, 1, 2, 3)
  ttri(800, 520, 1000, 540, 820, 710, 0, 0, 32, 0, 0, 32, 0, -1, 2, 1, 1.5)
  ttri(1000, 520, 1270, 520, 1100, 710, 0, 0, 300, 10, 20, 200, 2)
  textri(400, 400, 600, 420, 450, 600, 0, 0, 64, 0, 0, 64, false, 0)
  textri(450, 420, 650, 450, 500, 620, 0, 0, 64, 0, 0, 64, true)
  font("FONT", 1000, 10, 0, 8, 8, false, 1) font("Tiles", 1000, 30, {0}, 6, 6, true, 2) font("alt", 1000, 60, 0, 8, 8, false, 1, true)
  poke(0x0F0000 + t, t) -- inside the vram's spare space
end`,
        chunk(1, tiles),
        chunk(2, sprites),
        chunk(4, map),
        chunk(6, flags),
        chunk(12, palette),
      ),
    );
    expect(compare(hd, direct, 4)).toBeGreaterThanOrEqual(18); // the tiles' 20 colours
  }, 60_000);

  it("vbanks with OVR, SCN and BDR, screen offsets, the palette and its mapping", async () => {
    const [hd, direct] = await consoles(
      cart(`
t = 0
function TIC()
  t = t + 1
  cls(1)
  for i = 0, 15 do rect(i * 80, 0, 80, 720, i) end
  vbank(1)
  cls(0) circ(640, 360, 200, 12) print("OVERLAY", 600, 350, 2, false, 2)
  poke(0x0E1004 - 0x0E1004 + 922624, 0) -- vbank 1 clear colour
  vbank(0)
  poke(922625, t % 7) poke(922626, t % 5) -- screen offset x, y
  poke(922368 + 3, 5) poke(922368 + 5, 3) -- mapping: colour 3 draws as 5, 5 as 3
  rect(10, 600, 100, 50, 3) rect(120, 600, 100, 50, 5)
  pal = vbank(1) vbank(pal)
end
function OVR() rectb(5, 5, 200, 100, 7) end
function SCN(row) if row % 100 < 50 then poke(921600 + 3 * 2, row % 256) else poke(921600 + 3 * 2, 0) end end
function BDR(row) poke(921600 + 3 * 3 + 1, row % 256) end`),
    );
    expect(compare(hd, direct, 4)).toBeGreaterThan(20);
  }, 60_000);

  it("banks and sync, a cartridge screen, input (buttons held, pressed, with repeat; mouse; keys), BOOT and the clock", async () => {
    const screen = bytes(65535, 6, 16); // a chunk's most: the screen's top rows
    const [hd, direct] = await consoles(
      cart(
        `
t = 0
function BOOT() booted = (booted or 0) + 1 end
function TIC()
  t = t + 1
  if t == 2 then sync(1, 1) end -- tiles from bank 1
  if t == 3 then sync(4, 0, true) end -- map to the cartridge
  if t == 4 then sync(0, 0) end
  for i = 0, 7 do if btn(i) then rect(i * 30, 10, 20, 20, 12) end if btnp(i) then rect(i * 30, 40, 20, 20, 6) end if btnp(i, 2, 3) then rect(i * 30, 70, 20, 20, 7) end end
  rect(0, 100, btn() * 3, 10, 4) rect(0, 120, btnp() * 3, 10, 5) rect(0, 140, booted * 10, 10, 9)
  spr(1, 300, 300, -1, 4)
  local x, y, l, m, r, sx, sy = mouse()
  rect(0, 160, (x + 1000) // 10, 10, 3) rect(0, 180, (y + 1000) // 10, 10, 3)
  if key(1) or keyp() then rect(0, 200, 10, 10, 1) end
  print(string.format("%.3f", time()), 400, 10)
end`,
        chunk(18, screen),
        chunk(1, bytes(16384, 7, 16), 1),
        chunk(1, bytes(16384, 8, 16), 0),
      ),
    );
    const held = [0, 1, 1, 3, 16, 16, 16, 16, 0, 255, 128];
    expect(compare(hd, direct, held.length, (f) => held[f]!)).toBeGreaterThan(5);
  }, 60_000);

  it("reset() runs the cart again from the top (bank 0 back in RAM), with trace and exit harmless", async () => {
    const [hd, direct] = await consoles(
      cart(
        `
runs = (pmem(7) or 0) + 1
pmem(7, runs)
t = 0
function TIC()
  t = t + 1
  cls(runs % 16)
  trace("tick " .. t) exit()
  print("run " .. runs .. " tick " .. t, 10, 10, 12)
  spr(3, 100, 100, -1, 8)
  if t == 3 then poke(0x200000, 99) memset(${0x200000 + 1}, 7, 100) reset() end
end`,
        chunk(1, bytes(16384, 11, 32)),
      ),
    );
    expect(compare(hd, direct, 10)).toBeGreaterThan(5);
    expect(hd.netWords()![7]).toBe(direct.netWords()![7]);
  }, 60_000);

  it("sound and music: every register, channel position and the music state, every tick; and it sounds", async () => {
    // Sample 0: wave 2, loud, a chord and pitch ramp; sample 1: noise (wave 0 of all-zero ⇒ noise), quieter.
    const samples = new Uint8Array(64 * 66);
    for (let t = 0; t < 30; t += 1) {
      samples[t * 2] = (2 << 4) | (t % 4); // wave 2, volume 15 - t % 4
      samples[t * 2 + 1] = ((t % 3) << 4) | (t % 5); // pitch, chord
      samples[66 + t * 2] = (0 << 4) | 4;
      samples[66 + t * 2 + 1] = 0;
    }
    samples[60] = 4 | (1 << 4); // octave 4, speed 1
    samples[61] = 9; // note A
    samples[62] = 0x42; // wave loop: start 2, size 4
    samples[66 + 60] = 3;
    samples[66 + 61] = 0;
    const waves = new Uint8Array(256);
    waves.set(bytes(16, 9), 32); // wave 2
    for (let w = 3; w < 16; w += 1) waves.set(bytes(16, 10 + w), w * 16);
    // Pattern 1: a note every 4 rows on sample 0, with commands; pattern 2: sample 1.
    const patterns = new Uint8Array(60 * 192);
    for (let r = 0; r < 64; r += 4) {
      const at = r * 3;
      patterns[at] = 4 + (r % 12); // note
      patterns[at + 1] = r === 8 ? (2 << 4) | 3 : r === 16 ? (6 << 4) | 2 : r === 24 ? (1 << 4) | 9 : 0; // chord, vibrato, volume
      patterns[at] |= (r === 8 ? 4 : r === 24 ? 8 : 0) << 4;
      patterns[at + 2] = 0 | (4 << 5); // sfx 0, octave 4
      const b = 192 + at;
      patterns[b] = 4 + ((r / 4) % 12);
      patterns[b + 1] = r === 32 ? (5 << 4) | 4 : 0; // finepitch
      patterns[b + 2] = 1 | (3 << 5);
    }
    patterns[60 * 3 + 1] = (3 << 4) | 0; // row 60: jump to frame 1? (param1 is in byte 0's high nibble, 0)
    const tracks = new Uint8Array(8 * 99);
    // Track 0, frames 0 and 1: channel 0 plays pattern 1, channel 1 pattern 2.
    const ids = 1 | (2 << 6);
    for (const f of [0, 1]) {
      tracks[f * 6] = ids & 0xff;
      tracks[f * 6 + 1] = (ids >> 8) & 0xff;
    }
    tracks[96] = 0; // tempo 150
    tracks[97] = 0; // 64 rows
    tracks[98] = 0; // speed 6
    const [hd, direct] = await consoles(
      cart(
        `
t = 0
function TIC()
  t = t + 1
  if t == 1 then music(0, 0, 0, true) end
  if t == 20 then sfx(0, "C#5", 40, 3, 12, 2) end
  if t == 30 then sfx(1, 30, -1, 4, {15, 4}) end
  if t == 50 then sfx(0, 50, 20, 5, 9, -3) end
  if t == 70 then music() end
  if t == 75 then music(0, 1, 10, false, true, 200, 4) end
  cls(0)
  print(peek(${LAYOUT.pmemAddress - 4}) .. " " .. peek(${LAYOUT.pmemAddress - 3}), 10, 10)
end`,
        chunk(9, samples),
        chunk(10, waves),
        chunk(15, patterns),
        chunk(14, tracks),
      ),
    );
    let loud = 0;
    for (let f = 0; f < 100; f += 1) {
      hd.tick(0);
      direct.tick(0);
      expect(direct.readError().message, `frame ${f}`).toBe("");
      expect(ramDiff(hd, direct), `frame ${f}`).toBeNull();
      expect(frameDiff(hd.readFramebuffer(), direct.readFramebuffer()), `frame ${f}`).toBeNull();
      const a = hd.readAudioSamples();
      const b = direct.readAudioSamples();
      expect(b.length).toBe(a.length);
      const energy = (s: Int16Array) => s.reduce((n, v) => n + Math.abs(v), 0) / s.length;
      const ea = energy(a);
      const eb = energy(b);
      if (ea > 200) loud += 1;
      // Same notes at the same times: the loudness tracks the HD core's within a band.
      if (ea > 200) expect(eb / ea, `frame ${f} loudness`).toBeGreaterThan(0.6);
      if (ea > 200) expect(eb / ea, `frame ${f} loudness`).toBeLessThan(1.6);
      if (ea < 5) expect(eb, `frame ${f} silence`).toBeLessThan(60);
    }
    expect(loud).toBeGreaterThan(30);
  }, 60_000);

  it("Lockout as the player runs it (its scene, runtime, UI, actions, strings and save preludes): 600 frames from the menu into a match, identical, with the same commands to the 3D runtime", async () => {
    const sidecar = lockoutMeshSidecar();
    const mesh = parseMeshScene(sidecar)!;
    const actions = readSidecarActions(sidecar);
    // The player's preparation (player.ts start()), in its order, for Lockout's options.
    let prepared = seedCartridge(lockoutCartridge(), 12345);
    const components = componentsSdkLua(mesh);
    if (components) prepared = appendLuaCode(prependLuaCode(prepared, components.prelude), components.postlude);
    prepared = prependLuaCode(prepared, saveSdkLua(LAYOUT, null));
    prepared = prependLuaCode(prepared, actionsSdkLua(actions, LAYOUT));
    prepared = prependLuaCode(prepared, stringsSdkLua(LOCKOUT_STRINGS, playLanguage(LOCKOUT_STRINGS, ["en"]), DEFAULT_ACCESSIBILITY, inputBlockAddress(LAYOUT)));
    prepared = prependLuaCode(prepared, uiSdkLua(readSidecarUi(sidecar), 1280, 720));
    prepared = prependLuaCode(prepared, sceneObjectsSdkLua(mesh));
    prepared = prependLuaCode(prepared, runtimeSdkLua(mesh, LAYOUT, { physics: false }));
    const [hd, direct] = await consoles(injectSdk(prepared));
    const hosts = [hd, direct].map((console) => {
      const view = (offset: number, length: number) => {
        const b = console.ramView(offset - LAYOUT.pmemAddress, length)!;
        return new DataView(b.buffer, b.byteOffset, b.byteLength);
      };
      const ring = hasCommandRing(LAYOUT) ? () => view(commandRingAddress(LAYOUT)!, commandRingBytes(LAYOUT)) : () => null;
      const r = ring();
      if (r) resetCommandRing(r);
      return { console, view, ring, channel: new RuntimeChannel(mesh, null), last: 0 };
    });
    // Idle on the menu, then A (start the first game type), then move, turn and fire through the intro and the match.
    const input = (f: number) => (f >= 60 && f < 66 ? 16 : f >= 120 ? (f % 40 < 20 ? 8 : 4) | (f % 12 < 6 ? 16 : 0) | (f % 90 < 30 ? 1 : 0) : 0);
    const held = (f: number) => (f >= 150 ? (f % 20 < 10 ? 1 : 0) | (f % 50 < 25 ? 2 : 0) : 0);
    // The command slots and the overflow ring are the channel the HD core's commands travel through, which the
    // dedicated core's calls bypass: everything else in RAM must match.
    const slots = physicsBlockAddress(LAYOUT) + PHYS_CMDS;
    const channelBytes: [number, number][] = [...UNSPECIFIED, [slots, slots + 4 + PHYS_MAX_CMDS * PHYS_CMD_BYTES]];
    if (hasCommandRing(LAYOUT)) channelBytes.push([commandRingAddress(LAYOUT)!, commandRingAddress(LAYOUT)! + commandRingBytes(LAYOUT)]);
    let commandCount = 0;
    for (let f = 0; f < 600; f += 1) {
      const commands: PhysicsCommand[][] = [];
      for (const h of hosts) {
        const block = h.view(inputBlockAddress(LAYOUT), INPUT_BLOCK_BYTES);
        writeInputBlock(block, held(f), h.last);
        writeInputSettings(block, DEFAULT_ACCESSIBILITY, 1, 1);
        h.last = held(f);
        h.channel.beforeTick(h.view(physicsBlockAddress(LAYOUT), PHYS_BLOCK_BYTES));
        h.console.tick(input(f));
        const tick = takePhysicsCommands(h.view(physicsBlockAddress(LAYOUT), PHYS_BLOCK_BYTES));
        const ring = h.ring();
        if (ring) tick.push(...takeRingCommands(ring));
        if ("direct" in h.console) tick.push(...(h.console as DirectConsole).takeCommands().map(quantize));
        commands.push(tick);
        h.channel.applyCommands(tick);
      }
      expect(direct.readError().message, `frame ${f}`).toBe("");
      expect(hd.readError().message, `frame ${f}`).toBe("");
      // The same commands, in the same order (the direct ones at the HD core's 1/1024 precision).
      expect(commands[1], `frame ${f} commands`).toEqual(commands[0]);
      commandCount += commands[0]!.length;
      expect(frameDiff(hd.readFramebuffer(), direct.readFramebuffer()), `frame ${f}`).toBeNull();
      expect(ramDiff(hd, direct, channelBytes), `frame ${f}`).toBeNull();
    }
    // It reached the match: the runtime was busy.
    expect(commandCount).toBeGreaterThan(1000);
    hosts.forEach((h) => h.channel.destroy());
  }, 300_000);
});
