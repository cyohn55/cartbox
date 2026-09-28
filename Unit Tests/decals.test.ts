/**
 * Decals (HALO2_STYLE_ROADMAP.md, H6): definitions and permanent marks on the
 * sidecar, the decal system's quads (on the surface, turned, fading, recycled),
 * cartbox.decal through the runtime block (in the real engine), the overlay,
 * the editor's sidecar round trip, and Lockout's decals.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DECAL_FRAMES,
  DECAL_OFFSET,
  DECAL_PRESETS,
  DecalSystem,
  LOCKOUT_CODE,
  LOCKOUT_DECALS,
  LOCKOUT_DECAL_MARKS,
  MAX_MARKS_PER_DECAL,
  composeModelMatrix,
  decalAtlas,
  decalPreset,
  lockoutMeshSidecar,
  parseDecalDefs,
  parseDecalMarks,
  projectionMatrix,
  renderMeshScene,
  serializeMeshAsset,
  viewMatrix,
  type MeshAsset,
} from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneNeedsRuntime,
  sceneObjectsSdkLua,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshDecals } from "../apps/web/src/lib/meshSidecar";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {
    name: "cube",
    primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null } }],
  };
}

function sidecar(extra: Record<string, unknown> = { decals: [decalPreset("pock"), decalPreset("glyph")] }) {
  return JSON.stringify({
    version: 2,
    meshes: [{ id: "box", name: "box", mesh: serializeMeshAsset(cube()), transform: { position: [0, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    ...extra,
  });
}

describe("decal model", () => {
  it("has presets, reads definitions defensively and keeps only marks naming a known decal", () => {
    for (const p of DECAL_PRESETS) expect(decalPreset(p).pattern).toBe(p);
    const defs = parseDecalDefs([{ name: "mark", pattern: "nope", size: 999, life: -3, color: [2, 0, 0] }, { name: "mark" }, 7]);
    expect(defs[0]).toMatchObject({ name: "mark", pattern: "pock", size: 20, life: 0, color: [1, 0, 0] });
    expect(defs[1]!.name).toBe("mark_");
    const marks = parseDecalMarks(
      [
        { decal: "mark", position: [1, 2, 3], normal: [0, 0, 5], spin: 370 },
        { decal: "ghost", position: [0, 0, 0], normal: [0, 1, 0] },
        { decal: "mark", position: [0, 0, 0], normal: [0, 0, 0] },
      ],
      defs,
    );
    expect(marks).toEqual([{ decal: "mark", position: [1, 2, 3], normal: [0, 0, 1], size: 0, spin: 10 }]);
  });

  it("bakes an atlas whose later frames dissolve", () => {
    const atlas = decalAtlas(decalPreset("burn"));
    const frame = atlas.width / DECAL_FRAMES;
    const opaque = (f: number) => {
      let n = 0;
      for (let y = 0; y < atlas.height; y += 1) for (let x = 0; x < frame; x += 1) if (atlas.data[(y * atlas.width + f * frame + x) * 4 + 3] === 255) n += 1;
      return n;
    };
    expect(opaque(0)).toBeGreaterThan(opaque(DECAL_FRAMES - 1) * 3);
  });
});

describe("decal system", () => {
  it("lays a quad on the surface, a hair off it, facing out", () => {
    const sys = new DecalSystem([decalPreset("pock")]);
    expect(sys.sceneInstance()).toBeNull();
    sys.lay(0, [0, 1, 0], [0, 0, 2]);
    const prim = sys.sceneInstance()!.mesh.primitives[0]!;
    for (let k = 0; k < 4; k += 1) expect(prim.positions[k * 3 + 2]).toBeCloseTo(DECAL_OFFSET, 6);
    expect(Array.from(prim.normals!.subarray(0, 3))).toEqual([0, 0, 1]);
    const xs = [0, 1, 2, 3].map((k) => prim.positions[k * 3]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.05); // it has extent on the surface
  });

  it("fades cart-laid marks over their life; permanent ones stay", () => {
    const def = { ...decalPreset("pock"), life: 1 };
    const sys = new DecalSystem([def], [{ decal: "pock", position: [0, 0, 0], normal: [0, 1, 0], size: 0, spin: 0 }]);
    sys.lay(0, [1, 0, 0], [0, 1, 0]);
    expect(sys.count).toBe(2);
    sys.sceneInstance();
    const rev = sys.sceneInstance()!.mesh.primitives[0]!.dynamic!.revision;
    sys.step(0.8); // into the fade: the frame changes
    expect(sys.sceneInstance()!.mesh.primitives[0]!.dynamic!.revision).toBeGreaterThan(rev);
    sys.step(0.3);
    expect(sys.count).toBe(1); // only the placed mark is left
  });

  it("recycles the oldest cart-laid mark past the cap, never a placed one", () => {
    const sys = new DecalSystem([decalPreset("pock")], [{ decal: "pock", position: [9, 9, 9], normal: [0, 1, 0], size: 0, spin: 0 }]);
    for (let i = 0; i < MAX_MARKS_PER_DECAL + 20; i += 1) {
      sys.step(0.01);
      sys.lay(0, [i, 0, 0], [0, 1, 0]);
    }
    expect(sys.count).toBe(MAX_MARKS_PER_DECAL + 1);
  });

  it("draws in the rasteriser on a wall, darker where the pock is", () => {
    const wall: MeshAsset = {
      name: "wall",
      primitives: [
        {
          positions: Float32Array.from([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "w", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
    };
    const render = (withMark: boolean) => {
      const sys = new DecalSystem([{ ...decalPreset("pock"), size: 1.5 }]);
      if (withMark) sys.lay(0, [0, 0, 0], [0, 0, 1]);
      const marks = sys.sceneInstance();
      const out = new Uint8ClampedArray(32 * 32 * 4);
      renderMeshScene([{ mesh: wall, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }, ...(marks ? [marks] : [])], {
        width: 32,
        height: 32,
        out,
        depth: new Float32Array(32 * 32),
        view: viewMatrix([0, 0, 3], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
        lightDirection: [0, 0, 1],
      });
      const o = (16 * 32 + 16) * 4;
      return out[o]!;
    };
    expect(render(true)).toBeLessThan(render(false) - 60);
  });
});

describe("runtime", () => {
  it("gives a scene with decals the runtime block and cartbox.decal; placed marks show without a cart", async () => {
    const sc = parseMeshScene(sidecar({ decals: [decalPreset("glyph")], decalMarks: [{ decal: "glyph", position: [0, 0, -2.49], normal: [0, 0, 1], size: 0, spin: 0 }] }))!;
    expect(sceneNeedsRuntime(sc, { physics: false })).toBe(true);
    expect(runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false })).toContain("cartbox.decal");
    const names: string[][] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void names.push(instances.map((i) => i.mesh.name)), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, sc, renderer);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(names.at(-1)).toContain("decals");
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.decal from Lua (real engine)", () => {
  it("queues marks with their decal, place, normal and scale", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(sidecar())!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.decal("pock", 1, 2, 3, 0, 0, 1) end
  if t == 3 then cartbox.decal(2, 0, 1, 0, 1, 0, 0, 2) cartbox.decal("nope", 0, 0, 0, 0, 1, 0) end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false }));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const seen: ReturnType<RuntimeChannel["takeDecals"]>[] = [];
    for (let i = 1; i <= 4; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push(channel.takeDecals());
    }
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toHaveLength(1);
    expect(seen[1]![0]).toMatchObject({ decal: 0, scale: 1 });
    expect(seen[1]![0]!.at.map((v) => +v.toFixed(3))).toEqual([1, 2, 3]);
    expect(seen[1]![0]!.normal.map((v) => +v.toFixed(3))).toEqual([0, 0, 1]);
    expect(seen[2]).toHaveLength(1);
    expect(seen[2]![0]).toMatchObject({ decal: 1, scale: 2 });
    channel.destroy();
  });
});

describe("editor sidecar", () => {
  it("stores decals and marks, drops marks whose decal goes", () => {
    let sc = addMesh(emptyMeshSidecar(), cube(), "box").sidecar;
    sc = setMeshDecals(sc, [decalPreset("glyph"), decalPreset("frost")], [
      { decal: "glyph", position: [0, 1, 0], normal: [0, 0, 1], size: 0, spin: 0 },
      { decal: "frost", position: [0, 2, 0], normal: [0, 0, 1], size: 1, spin: 0 },
    ]);
    const back = decodeMeshSidecar(encodeMeshSidecar(sc)!);
    expect(back.decals).toEqual(sc.decals);
    expect(back.decalMarks).toEqual(sc.decalMarks);
    const fewer = setMeshDecals(sc, [decalPreset("glyph")]);
    expect(fewer.decalMarks!.map((m) => m.decal)).toEqual(["glyph"]);
    expect("decals" in setMeshDecals(sc, [])).toBe(false);
  });
});

describe("Lockout", () => {
  it("lays pocks and burns from the cart and ships glyphs and frost", () => {
    expect(LOCKOUT_DECALS.map((d) => d.name)).toEqual(["pock", "burn", "glyph", "frost"]);
    const sc = parseMeshScene(lockoutMeshSidecar())!;
    expect(sc.decals!.length).toBe(4);
    expect(sc.decalMarks!.length).toBe(LOCKOUT_DECAL_MARKS.length);
    expect(LOCKOUT_CODE).toContain('cartbox.decal("pock"');
    expect(LOCKOUT_CODE).toContain('cartbox.decal("burn"');
  });
});
