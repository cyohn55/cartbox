/**
 * Components (ENGINE_PARITY_ROADMAP.md EP14): Lua behaviours written once and
 * attached to objects in the inspector, each copy with that object's field
 * values. Covers reading scripts' declared fields and callbacks, the scene and
 * editor sidecar (attach, rename follows, delete detaches, prefabs carry them),
 * and the runtime in the real engine — start then update per copy, fields,
 * object fields resolved, collision and trigger dispatch, spawned copies
 * starting when they come alive, and a broken script (or a callback that
 * errors) skipped without stopping the cart.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_COMPONENTS,
  componentCallbacks,
  componentFields,
  componentValues,
  lockoutCartridge,
  lockoutMeshSidecar,
  parseAttached,
  parseComponentDefs,
  serializeMeshAsset,
  type MeshAsset,
} from "@cartbox/editor";
import {
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  componentsSdkLua,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  readSidecarUi,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  uiSdkLua,
} from "@cartbox/player";
import { appendLuaCode, prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { addComponent, attachComponent, attachedTo, detachComponent, removeComponent, setComponentField, updateComponent } from "../apps/web/src/lib/componentEdit";
import { createPrefab, placePrefab } from "../apps/web/src/lib/meshPrefabs";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): MeshAsset {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v) => v / 2);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
}

const SPIN = `-- Spin: counts its ticks and remembers what it touched.
-- @field speed number 1
-- @field label text hi
-- @field target object
-- @field armed bool true
starts = 0
function start(self)
  starts = starts + 1
  self.n = 0
  self.begun = (self.begun or 0) + 1
end
function update(self, dt)
  self.n = self.n + 1
  self.dt = dt
end
function collision(self, other, started)
  self.hit = other
  self.hitStarted = started
end
function trigger(self, other, entered)
  self.trig = other
  self.entered = entered
end
`;

describe("component scripts", () => {
  it("reads declared fields (types, defaults, first wins, obj reserved) and defined callbacks", () => {
    const code = `${SPIN}-- @field speed number 9\n-- @field obj number 3\n-- @field odd vector 1\n`;
    expect(componentFields(code)).toEqual([
      { name: "speed", type: "number", default: 1 },
      { name: "label", type: "text", default: "hi" },
      { name: "target", type: "object", default: "" },
      { name: "armed", type: "bool", default: true },
    ]);
    expect(componentCallbacks(SPIN)).toEqual(["start", "update", "collision", "trigger"]);
    expect(componentCallbacks("function update(self) end\nfunction late(self) end")).toEqual(["update", "late"]);
  });

  it("fills an object's values: what it sets, else the defaults (wrong types fall back)", () => {
    const def = { name: "Spin", code: SPIN };
    expect(componentValues(def, { name: "Spin", fields: { speed: 3, label: 7, armed: false } })).toEqual({ speed: 3, label: "hi", target: "", armed: false });
  });

  it("reads stored scripts and attachments defensively", () => {
    const defs = parseComponentDefs([{ name: "Spin", code: SPIN }, { name: "Spin", code: "" }, { name: "9bad", code: "" }, { name: "Big", code: "x".repeat(20000) }, null]);
    expect(defs.map((d) => d.name)).toEqual(["Spin", "Big"]);
    expect(defs[1]!.code.length).toBe(16000);
    const attached = parseAttached(
      [{ name: "Spin", fields: { speed: 2, bad: {}, label: "x".repeat(300), "1no": 1 } }, { name: "Spin", fields: {} }, { name: "Gone", fields: {} }],
      new Set(["Spin"]),
    );
    expect(attached).toEqual([{ name: "Spin", fields: { speed: 2 } }]);
  });
});

describe("editor sidecar", () => {
  it("adds scripts, attaches with field values, renames through, detaches, and round-trips", () => {
    let sc = addMesh(emptyMeshSidecar(), cube(), "door").sidecar;
    const id = sc.meshes[0]!.id;
    const made = addComponent(sc)!;
    expect(made.name).toBe("Behaviour");
    expect(addComponent(made.sidecar)!.name).toBe("Behaviour2");
    sc = attachComponent(made.sidecar, id, "Behaviour");
    sc = setComponentField(sc, id, "Behaviour", "speed", 4);
    expect(attachedTo(sc, id)).toEqual([{ name: "Behaviour", fields: { speed: 4 } }]);
    // Back to the default stops storing it.
    expect(attachedTo(setComponentField(sc, id, "Behaviour", "speed", 1), id)[0]!.fields).toEqual({});

    const renamed = updateComponent(sc, "Behaviour", { name: "Door" })!;
    expect(renamed.components!.map((d) => d.name)).toEqual(["Door"]);
    expect(attachedTo(renamed, id)[0]!.name).toBe("Door");
    expect(updateComponent(renamed, "Door", { name: "bad name" })).toBeNull();

    const back = decodeMeshSidecar(encodeMeshSidecar(renamed)!);
    expect(back.components).toEqual(renamed.components);
    expect(back.meshes[0]!.components).toEqual([{ name: "Door", fields: { speed: 4 } }]);

    expect(attachedTo(detachComponent(renamed, id, "Door"), id)).toEqual([]);
    const removed = removeComponent(renamed, "Door");
    expect("components" in removed).toBe(false);
    expect(removed.meshes[0]!.components).toBeUndefined();
  });

  it("keeps a scripts-only sidecar, and prefabs carry their objects' components", () => {
    const only = addComponent(emptyMeshSidecar())!.sidecar;
    expect(decodeMeshSidecar(encodeMeshSidecar(only)!).components).toHaveLength(1);

    let sc = addMesh(emptyMeshSidecar(), cube(), "bot").sidecar;
    const id = sc.meshes[0]!.id;
    sc = attachComponent(addComponent(sc)!.sidecar, id, "Behaviour");
    const prefab = createPrefab(sc, id, "Bot");
    expect(prefab).not.toBeNull();
    const nodes = prefab!.sidecar.prefabs![0]!.nodes;
    expect(nodes[0]!.components).toEqual([{ name: "Behaviour", fields: {} }]);
    const placed = placePrefab(prefab!.sidecar, prefab!.sidecar.prefabs![0]!.id);
    expect(placed!.sidecar.meshes.at(-1)!.components).toEqual([{ name: "Behaviour", fields: {} }]);
    const back = decodeMeshSidecar(encodeMeshSidecar(placed!.sidecar)!);
    expect(back.prefabs![0]!.nodes[0]!.components).toEqual([{ name: "Behaviour", fields: {} }]);
  });
});

const tf = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
function sidecar(extra: Record<string, unknown> = {}) {
  const mesh = serializeMeshAsset(cube());
  return JSON.stringify({
    version: 2,
    meshes: [
      { id: "door", name: "door", mesh, transform: tf, components: [{ name: "Spin", fields: { speed: 3, label: "Door", target: "crate" } }, { name: "Broken", fields: {} }, { name: "Faulty", fields: {} }, { name: "After", fields: {} }] },
      { id: "crate", name: "crate", mesh, transform: { ...tf, position: [4, 5, 6] }, components: [{ name: "Spin", fields: {} }, { name: "Nope", fields: {} }] },
      { id: "plain", name: "plain", mesh, transform: tf },
    ],
    prefabs: [{ id: "p", name: "bot", pool: 2, nodes: [{ key: "root", name: "bot", mesh, transform: tf, components: [{ name: "Spin", fields: { speed: 7 } }] }] }],
    components: [
      { name: "Spin", code: SPIN },
      { name: "Broken", code: "function start(self) oops( end" },
      { name: "Faulty", code: "function update(self) self.k = (self.k or 0) + 1; if self.k == 3 then error('boom') end end" },
      // late runs after the cart's TIC: it sees the cart's tick count already advanced.
      { name: "After", code: "function update(self) self.before = t end\nfunction late(self) self.after = t end" },
    ],
    lighting: null,
    ...extra,
  });
}

describe("scene", () => {
  it("parses scripts and attachments (unknown scripts dropped), and builds no Lua without them", () => {
    const sc = parseMeshScene(sidecar())!;
    expect(sc.components!.map((d) => d.name)).toEqual(["Spin", "Broken", "Faulty", "After"]);
    expect(sc.instances[1]!.components).toEqual([{ name: "Spin", fields: {} }]);
    expect(sc.instances[2]!.components).toBeUndefined();
    expect(sc.instances.filter((i) => i.pooled).every((i) => i.components?.[0]?.fields.speed === 7)).toBe(true);
    expect(componentsSdkLua(sc)!.prelude).toContain("cartbox.component =");
    expect(componentsSdkLua(parseMeshScene(sidecar({ components: [] })))).toBeNull();
  });
});

describe.skipIf(!existsSync(ENGINE))("components at run time (real engine)", () => {
  it("starts then updates each copy with its fields, dispatches contacts, starts spawned copies, and skips broken ones", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(sidecar())!;
    const bot = sc.pools![0]!.roots[0]!;
    const code = `
t = 0
cartbox.contacts = function()
  if t == 4 then return {{a = 0, b = 1, started = true, trigger = false}} end
  if t == 5 then return {{a = 2, b = 1, started = false, trigger = true}} end
  return {}
end
function TIC()
  t = t + 1
  local d, c = cartbox.component("door", "Spin"), cartbox.component(1, "Spin")
  local b = cartbox.component(${bot}, "Spin")
  pmem(0, d.n) pmem(1, c.n) pmem(2, d.speed * 10) pmem(3, c.speed * 10)
  pmem(4, d.target or -1) pmem(5, c.target == nil and 1 or 0)
  pmem(6, d.hit or -1) pmem(7, c.hit or -1) pmem(8, (d.hitStarted and 1 or 0))
  pmem(9, c.trig or -1) pmem(10, c.entered == false and 1 or 0)
  pmem(11, d.label == "Door" and 1 or 0) pmem(12, d.armed and 1 or 0)
  pmem(13, b.n or -1) pmem(14, b.speed)
  pmem(15, cartbox.component("door", "Broken") == nil and 1 or 0)
  pmem(16, cartbox.component("plain", "Spin") == nil and 1 or 0)
  pmem(17, cartbox.component("door", "Faulty").k)
  pmem(18, math.floor(d.dt * 600 + 0.5))
  pmem(19, d.begun)
  local a = cartbox.component("door", "After")
  pmem(20, a.before) pmem(21, a.after or -1)
  pmem(22, c.origin.x * 100 + c.origin.y * 10 + c.origin.z)
  if t == 2 then pmem(23, cartbox.place("plain", 1, 2, 3, 0, 0, 0, 2) and 1 or 0) end
  if t == 4 then cartbox.place(2) end
  if t == 3 then cartbox.spawn("bot", 0, 0, 0) end
end`;
    const comp = componentsSdkLua(sc)!;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, comp.prelude);
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false }));
    tic = appendLuaCode(injectSdk(tic), comp.postlude);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const mem = () => Array.from(new Int32Array(mod.HEAPU8.buffer, base, 24));
    const ticks: number[][] = [];
    const placed: (number[] | null)[] = [];
    for (let i = 1; i <= 8; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      ticks.push(mem());
      const m = channel.placements().get(2);
      placed.push(m ? [m[0]!, m[12]!, m[13]!, m[14]!].map((v) => +v.toFixed(3)) : null);
    }
    channel.destroy();
    const last = ticks.at(-1)!;
    // start once, then update every tick (the cart's TIC reads after the components' step).
    expect(ticks.map((m) => m[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(last[1]).toBe(8);
    expect(last[19]).toBe(1);
    expect(last[18]).toBe(10); // dt = 1/60
    // Fields: the door's own values, the crate's defaults; the object field names the crate.
    expect([last[2], last[3], last[4], last[5], last[11], last[12]]).toEqual([30, 10, 1, 1, 1, 1]);
    // Collision (door hit crate) reaches both sides; the trigger (bot left crate) reaches the crate.
    expect([last[6], last[7], last[8]]).toEqual([1, 0, 1]);
    expect([last[9], last[10]]).toEqual([2, 1]);
    // The pooled bot starts on the tick after it's spawned (spawned in tick 3's TIC).
    expect(ticks.map((m) => m[13])).toEqual([-1, -1, -1, 1, 2, 3, 4, 5]);
    expect(last[14]).toBe(7);
    // update ran before this tick's TIC (t one behind), late after the last one (read here, a tick later).
    expect([last[20], last[21]]).toEqual([7, 7]);
    expect(ticks[0]![21]).toBe(-1);
    // self.origin: where the scene put the object (the crate at 4, 5, 6).
    expect(last[22]).toBe(456);
    // cartbox.place puts an object somewhere (world space, scaled) and leaves it there until sent home.
    expect(ticks[1]![23]).toBe(1);
    expect(placed).toEqual([null, [2, 1, 2, 3], [2, 1, 2, 3], null, null, null, null, null]);
    // A script that doesn't compile is skipped; one whose update errors stops (at k = 3) while the rest run on.
    expect([last[15], last[16], last[17]]).toEqual([1, 1, 3]);
  });
});

describe("Lockout", () => {
  it("floats a weapon over each spawn pad, each with a Pickup component for its slot, without hands", () => {
    const sc = parseMeshScene(lockoutMeshSidecar())!;
    expect(sc.components).toEqual(LOCKOUT_COMPONENTS);
    expect(componentCallbacks(LOCKOUT_COMPONENTS[0]!.code)).toEqual(["start", "update"]);
    const pickups = sc.instances.slice(14, 19);
    expect(pickups.map((i) => i.name)).toEqual(["pickup sniper", "pickup br", "pickup shotgun", "pickup sword", "pickup smg"]);
    pickups.forEach((p, k) => {
      expect(p.components).toEqual([{ name: "Pickup", fields: { slot: k + 1 } }]);
      expect(p.mesh.primitives.some((q) => q.material.name === "glove" || q.material.name === "sleeve")).toBe(false);
    });
    expect(LOCKOUT_CODE).toContain("function pickup_ready(i)");
  });
});

describe.skipIf(!existsSync(ENGINE))("Lockout pickups (real engine)", () => {
  it("hides the pickups on the title screen and turns them over their pads in a match", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(lockoutMeshSidecar())!;
    const comp = componentsSdkLua(sc)!;
    // As the player builds it: the components nearest the cart, then the UI, scene objects and runtime.
    let tic = prependLuaCode(lockoutCartridge(), comp.prelude);
    tic = prependLuaCode(tic, uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false }));
    tic = appendLuaCode(injectSdk(tic), comp.postlude);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const tick = (buttons = 0) => {
      channel.beforeTick(block());
      mod._cbx_tick(h, buttons);
      channel.afterTick(block());
    };
    const pickups = () => [14, 15, 16, 17, 18].map((i) => channel.placements().get(i) ?? null);
    const scaleOf = (m: ArrayLike<number>) => Math.hypot(m[0]!, m[1]!, m[2]!);
    for (let i = 0; i < 3; i += 1) tick();
    expect(pickups().every((m) => m !== null && scaleOf(m) === 0)).toBe(true);
    // Free for All (the first game type), past its intro.
    tick(1 << 4);
    for (let i = 0; i < 40; i += 1) tick(i % 2 ? 1 << 4 : 0);
    // Each weapon is up (turning over its pad) unless someone has just taken it (gone, recharging).
    const a = pickups().map((m) => Array.from(m!));
    const up = a.flatMap((m, k) => (scaleOf(m) > 0.5 ? [k] : []));
    expect(up.length).toBeGreaterThanOrEqual(2);
    a.forEach((m, k) => {
      if (!up.includes(k)) return expect(scaleOf(m)).toBe(0);
      expect(scaleOf(m)).toBeCloseTo(1, 2);
      // Over its pad: where the scene put it, give or take the bob.
      const home = sc.instances[14 + k]!.model;
      expect(m[12]!).toBeCloseTo(home[12]!, 2);
      expect(m[14]!).toBeCloseTo(home[14]!, 2);
      expect(Math.abs(m[13]! - home[13]!)).toBeLessThanOrEqual(0.062);
    });
    for (let i = 0; i < 10; i += 1) tick();
    // Turning: its heading changed.
    const b = pickups();
    for (const k of up) if (scaleOf(b[k]!) > 0.5) expect(Math.atan2(b[k]![8]!, b[k]![10]!)).not.toBeCloseTo(Math.atan2(a[k]![8]!, a[k]![10]!), 2);
    channel.destroy();
  });
});
