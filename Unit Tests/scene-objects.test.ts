/**
 * Scene objects (ENGINE_ROADMAP.md, Phase 1): parents, tags and custom properties
 * on placed meshes. Covers the shared hierarchy maths (cycles and dangling parents
 * become roots; world = parent world · local), the editor's sidecar operations
 * (round trip, refusing cycles, removing a parent keeps its children), the
 * runtime scene (children placed under parents), poses carrying children along,
 * and the Lua API (cartbox.find / prop / tagged ...) running in the real engine.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  localDirection,
  multiplyMat4,
  parentIndices,
  serializeMeshAsset,
  worldMatrices,
  type MeshAsset,
} from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  codeChunks,
  injectSdk,
  parseMeshScene,
  sceneObjectsSdkLua,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import {
  addMesh,
  decodeMeshSidecar,
  emptyMeshSidecar,
  encodeMeshSidecar,
  hierarchyRows,
  parentCandidates,
  removeMesh,
  setMeshParent,
  setMeshProp,
  setMeshTags,
  setMeshTransform,
  type MeshSidecar,
} from "../apps/web/src/lib/meshSidecar";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function quad(): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 0, 0, 1], baseColorImage: null },
      },
    ],
  };
}

/** Translation column of a column-major matrix. */
const at = (m: ArrayLike<number>) => [m[12], m[13], m[14]];

/** A tower with a turret on top, a lamp on the turret, and a loose crate. */
function scene(): { sidecar: MeshSidecar; ids: Record<string, string> } {
  let sc = emptyMeshSidecar();
  const ids: Record<string, string> = {};
  for (const name of ["tower", "turret", "lamp", "crate"]) {
    const added = addMesh(sc, quad(), name);
    sc = added.sidecar;
    ids[name] = added.id;
  }
  const move = (id: string, position: [number, number, number]) =>
    (sc = setMeshTransform(sc, id, { position, rotation: [0, 0, 0], scale: [1, 1, 1] }));
  move(ids.tower!, [10, 0, 0]);
  move(ids.turret!, [0, 5, 0]);
  move(ids.lamp!, [0, 1, 0]);
  move(ids.crate!, [-3, 0, 2]);
  // The offsets above are authored relative to each parent.
  sc = setMeshParent(sc, ids.turret!, ids.tower!, { keepWorld: false });
  sc = setMeshParent(sc, ids.lamp!, ids.turret!, { keepWorld: false });
  sc = setMeshTags(sc, ids.turret!, ["enemy", "enemy", "bad tag", "armed"]);
  sc = setMeshTags(sc, ids.crate!, ["pickup"]);
  sc = setMeshProp(sc, ids.turret!, "hp", 40);
  sc = setMeshProp(sc, ids.turret!, "team", "red");
  sc = setMeshProp(sc, ids.turret!, "active", true);
  return { sidecar: sc, ids };
}

describe("hierarchy maths", () => {
  it("turns unknown parents, self-parents and cycles into roots", () => {
    const parents = parentIndices([
      { id: "a" },
      { id: "b", parent: "a" },
      { id: "c", parent: "nope" },
      { id: "d", parent: "d" },
      { id: "e", parent: "f" },
      { id: "f", parent: "e" },
    ]);
    expect(parents.slice(0, 4)).toEqual([-1, 0, -1, -1]);
    // e ↔ f: one of the two is cut loose, leaving a forest.
    expect(parents[4] === -1 || parents[5] === -1).toBe(true);
    expect(parents[4] === 5 && parents[5] === 4).toBe(false);
  });

  it("places a child relative to its parent", () => {
    const locals = [composeModelMatrix([10, 0, 0], [0, 90, 0], [2, 2, 2]), composeModelMatrix([1, 0, 0], [0, 0, 0], [1, 1, 1])];
    const [root, child] = worldMatrices(locals, [-1, 0]);
    expect(root).toBe(locals[0]); // roots reuse their matrix
    // Rotated 90° about Y and scaled 2: the child's +x offset lands at -z, doubled.
    const [x, y, z] = at(child!);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(-2);
  });
});

describe("dragging a child", () => {
  it("converts a world move into the parent's local space", () => {
    const parent = composeModelMatrix([5, 0, 0], [0, 90, 30], [2, 0.5, 3]);
    const worldDelta: [number, number, number] = [1, 2, -0.5];
    const local = localDirection(parent, worldDelta);
    // Moving the child by `local` in parent space moves it by worldDelta in the world.
    const before = multiplyMat4(parent, composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]));
    const after = multiplyMat4(parent, composeModelMatrix(local, [0, 0, 0], [1, 1, 1]));
    for (let k = 0; k < 3; k += 1) expect(after[12 + k]! - before[12 + k]!).toBeCloseTo(worldDelta[k]!);
  });
});

describe("mesh sidecar scene objects", () => {
  it("round-trips parents, tags and properties, and leaves old carts unchanged", () => {
    const { sidecar, ids } = scene();
    const back = decodeMeshSidecar(encodeMeshSidecar(sidecar));
    const turret = back.meshes.find((m) => m.id === ids.turret)!;
    expect(turret.parent).toBe(ids.tower);
    expect(turret.tags).toEqual(["enemy", "armed"]); // duplicate and invalid dropped
    expect(turret.props).toEqual({ hp: 40, team: "red", active: true });
    const tower = back.meshes.find((m) => m.id === ids.tower)!;
    expect("parent" in tower || "tags" in tower || "props" in tower).toBe(false);

    // A sidecar written before scene objects existed decodes with none of the new fields.
    const legacy = JSON.stringify({ version: 2, meshes: [{ id: "x", name: "X", mesh: serializeMeshAsset(quad()), transform: {} }] });
    expect(Object.keys(decodeMeshSidecar(legacy).meshes[0]!).sort()).toEqual(["id", "mesh", "name", "transform"]);
  });

  it("lists the Hierarchy depth-first, children under parents", () => {
    const { sidecar } = scene();
    expect(hierarchyRows(sidecar).map((r) => `${"  ".repeat(r.depth)}${r.entry.name}${r.hasChildren ? "/" : ""}`)).toEqual([
      "tower/",
      "  turret/",
      "    lamp",
      "crate",
    ]);
  });

  it("refuses a parent that would make a cycle", () => {
    const { sidecar, ids } = scene();
    expect(setMeshParent(sidecar, ids.tower!, ids.lamp!)).toBe(sidecar); // lamp is under tower
    expect(setMeshParent(sidecar, ids.tower!, ids.tower!)).toBe(sidecar);
    expect(setMeshParent(sidecar, ids.tower!, "missing")).toBe(sidecar);
    expect(parentCandidates(sidecar, ids.tower!).map((m) => m.name)).toEqual(["crate"]);
    const unparented = setMeshParent(sidecar, ids.turret!, null);
    expect(unparented.meshes.find((m) => m.id === ids.turret)!.parent).toBeUndefined();
  });

  it("re-parents in place by default: the object stays where it is in the world", () => {
    let sc = emptyMeshSidecar();
    const a = addMesh(sc, quad(), "base");
    sc = a.sidecar;
    const b = addMesh(sc, quad(), "flag");
    sc = b.sidecar;
    sc = setMeshTransform(sc, a.id, { position: [4, 1, -2], rotation: [0, 90, 0], scale: [2, 2, 2] });
    sc = setMeshTransform(sc, b.id, { position: [1, 3, 5], rotation: [10, 20, 30], scale: [1, 1, 1] });
    const worldOf = (s: MeshSidecar, id: string) => {
      const inst = parseMeshScene(encodeMeshSidecar(s))!.instances.find((x) => x.id === id)!;
      return Array.from(inst.model);
    };
    const before = worldOf(sc, b.id);
    const parented = setMeshParent(sc, b.id, a.id);
    const after = worldOf(parented, b.id);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 5));
    // Local now: halved scale, offset measured in the base's turned frame.
    const local = parented.meshes.find((m) => m.id === b.id)!.transform;
    expect(local.scale[0]).toBeCloseTo(0.5, 5);
    // And back to the top level, still in place.
    const unparented = setMeshParent(parented, b.id, null);
    worldOf(unparented, b.id).forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 5));
    expect(unparented.meshes.find((m) => m.id === b.id)!.transform.position).toEqual([1, 3, 5]);
  });

  it("keeps a removed parent's children, moving them up a level", () => {
    const { sidecar, ids } = scene();
    const next = removeMesh(sidecar, ids.turret!);
    expect(next.meshes.find((m) => m.id === ids.lamp)!.parent).toBe(ids.tower);
    const again = removeMesh(next, ids.tower!);
    expect(again.meshes.find((m) => m.id === ids.lamp)!.parent).toBeUndefined();
  });

  it("validates property keys and values, and removes a property with null", () => {
    const { sidecar, ids } = scene();
    expect(setMeshProp(sidecar, ids.crate!, "not valid", 1)).toBe(sidecar);
    expect(setMeshProp(sidecar, ids.crate!, "x", Number.NaN)).toBe(sidecar);
    const removed = setMeshProp(sidecar, ids.turret!, "hp", null);
    expect(removed.meshes.find((m) => m.id === ids.turret)!.props).toEqual({ team: "red", active: true });
  });
});

describe("runtime scene", () => {
  it("places children under their parents and keeps the authored data", () => {
    const { sidecar } = scene();
    const runtime = parseMeshScene(encodeMeshSidecar(sidecar))!;
    const byName = Object.fromEntries(runtime.instances.map((inst, i) => [inst.name, { inst, i }]));
    expect(at(byName.turret!.inst.model)).toEqual([10, 5, 0]);
    expect(at(byName.lamp!.inst.model)).toEqual([10, 6, 0]);
    expect(at(byName.crate!.inst.model)).toEqual([-3, 0, 2]);
    expect(byName.lamp!.inst.parent).toBe(byName.turret!.i);
    expect(byName.turret!.inst.tags).toEqual(["enemy", "armed"]);
    expect(runtime.bounds.max[0]).toBeCloseTo(11);
  });

  it("moves a posed parent's children with it, and hides them with it", async () => {
    const { sidecar } = scene();
    const runtime = parseMeshScene(encodeMeshSidecar(sidecar))!;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, runtime);
    const posed = () => (surface as unknown as { posedInstances(): { main: { model: ArrayLike<number> }[]; moved: unknown[] } }).posedInstances();
    const pose = { position: [0, 0, 4] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1, hidden: false };
    surface.setPoseOverrides([{ index: 0, ...pose }]); // move the tower 4 along z
    const { main, moved } = posed();
    expect(main.map((m) => at(m.model))).toEqual([
      [10, 0, 4],
      [10, 5, 4],
      [10, 6, 4],
      [-3, 0, 2],
    ]);
    expect(moved.length).toBe(3); // the tower and everything on it
    surface.setPoseOverrides([{ index: 1, ...pose, hidden: true }]); // hide the turret
    expect(posed().main.map((m) => at(m.model))).toEqual([
      [10, 0, 0],
      [-3, 0, 2],
    ]);
  });
});

describe.skipIf(!existsSync(ENGINE))("Lua scene-object API (real engine)", () => {
  async function run(code: string, sidecarJson: string | null): Promise<Uint32Array> {
    let tic = codeChunks(new TextEncoder().encode(code));
    const lua = sceneObjectsSdkLua(parseMeshScene(sidecarJson));
    if (lua) tic = prependLuaCode(tic, lua);
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    mod._cbx_tick(h, 0);
    return new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS).slice();
  }

  // Each answer lands in a free netplay word (100..109) as a small integer.
  const PROBE = `
function TIC()
  cls(0)
  local t = cartbox.find("turret")
  pmem(100, (t or -1) + 1)
  pmem(101, cartbox.prop("turret", "hp", 0))
  pmem(102, cartbox.prop(t, "team") == "red" and 1 or 0)
  pmem(103, cartbox.prop("crate", "hp", 7))
  pmem(104, #cartbox.tagged("enemy") * 10 + #cartbox.tagged("pickup"))
  pmem(105, cartbox.hastag("turret", "armed") and 1 or 0)
  pmem(106, (cartbox.parent("lamp") or -1) + 1)
  pmem(107, #cartbox.children("tower"))
  pmem(108, cartbox.objects())
  pmem(109, cartbox.objname(3) == "crate" and 1 or 0)
end`;

  it("finds objects by name and reads their tags, properties and parents", async () => {
    const words = await run(PROBE, encodeMeshSidecar(scene().sidecar));
    expect(Array.from(words.slice(100, 110))).toEqual([2, 40, 1, 7, 11, 1, 2, 1, 4, 1]);
  }, 60_000);

  it("is safe to call in a cart with no meshes", async () => {
    const words = await run(PROBE, null);
    expect(Array.from(words.slice(100, 110))).toEqual([0, 0, 0, 7, 0, 0, 0, 0, 0, 0]);
  }, 60_000);
});
