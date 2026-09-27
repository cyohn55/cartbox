/**
 * The per-cart download budget (ENGINE_ROADMAP.md, Phase 4): the size constants
 * match the real builds, a cart's pieces are itemized as they travel (gzipped),
 * the 3D scene is broken down by kind, physics is counted only when bodies need
 * it (the deterministic build when asked), and heavy carts get useful tips.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { MeshAsset } from "@cartbox/editor";
import {
  BUDGET_LIGHT_BYTES,
  ENGINE_TRANSFER_BYTES,
  PHYSICS_TRANSFER_BYTES,
  loadSeconds,
  measureDownload,
  sceneBreakdown,
} from "../apps/web/src/lib/downloadBudget";
import { addMesh, emptyMeshSidecar, encodeMeshSidecar, setMeshPhysics, setMeshPhysicsWorld } from "../apps/web/src/lib/meshSidecar";

const root = path.resolve(__dirname, "..");
const gz = (file: string) => gzipSync(readFileSync(file), { level: 9 }).length;

describe("size constants", () => {
  const cores: [keyof typeof ENGINE_TRANSFER_BYTES, string][] = [
    ["classic", "tic80"],
    ["pro", "pro/engine"],
    ["portrait", "portrait/engine"],
    ["ps1", "ps1/engine"],
    ["n64", "n64/engine"],
    ["xbox360", "xbox360/engine"],
  ];
  for (const [model, file] of cores) {
    const base = path.join(root, "packages/engine/dist", file);
    it.skipIf(!existsSync(`${base}.wasm`))(`${model}'s engine core is within 5% of its build`, () => {
      const actual = gz(`${base}.js`) + gz(`${base}.wasm`);
      expect(Math.abs(ENGINE_TRANSFER_BYTES[model] - actual) / actual).toBeLessThan(0.05);
    });
  }
  it("the physics builds are within 5% of the installed Rapier", () => {
    const regular = gz(path.join(root, "node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs"));
    const deterministic = gz(path.join(root, "node_modules/@dimforge/rapier3d-deterministic-compat/dist/rapier.mjs"));
    expect(Math.abs(PHYSICS_TRANSFER_BYTES.regular - regular) / regular).toBeLessThan(0.05);
    expect(Math.abs(PHYSICS_TRANSFER_BYTES.deterministic - deterministic) / deterministic).toBeLessThan(0.05);
  });
});

/** A textured quad mesh with `textureBytes` of incompressible image data. */
function texturedMesh(textureBytes: number): MeshAsset {
  const image = new Uint8Array(textureBytes);
  let seed = 7;
  for (let i = 0; i < image.length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    image[i] = seed >>> 24;
  }
  return {
    name: "crate",
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
        normals: null,
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: { mime: "image/png", bytes: image } },
      },
    ],
  };
}

describe("measuring a cart", () => {
  it("counts the engine and the gzipped cartridge for a plain cart", async () => {
    const cartridge = new TextEncoder().encode("function TIC() cls(0) end\n".repeat(200));
    const budget = await measureDownload({ modelId: "classic", cartridge, meshSidecar: null, otherData: [], uploadedBytes: 0 });
    expect(budget.items.map((i) => i.key)).toEqual(["engine", "cartridge"]);
    expect(budget.items[1]!.bytes).toBeLessThan(cartridge.length / 5); // repetitive code compresses well
    expect(budget.rating).toBe("light");
    expect(budget.tips).toEqual([]);
  });

  it("breaks a 3D scene down, adds physics only for bodies, and tips on the heavy part", async () => {
    const { sidecar, id } = addMesh(emptyMeshSidecar(), texturedMesh(900 * 1024), "crate");
    const plain = encodeMeshSidecar(sidecar)!;
    const breakdown = sceneBreakdown(plain)!;
    expect(breakdown.textures).toBeGreaterThan(breakdown.geometry * 100);
    expect(breakdown.heaviest[0]!.name).toBe("crate");

    const noBodies = await measureDownload({ modelId: "xbox360", cartridge: null, meshSidecar: plain, otherData: [{ a: 1 }], uploadedBytes: 0 });
    expect(noBodies.items.map((i) => i.key)).toEqual(["engine", "cartridge", "scene", "data"]);
    expect(noBodies.tips.some((t) => t.startsWith("Textures are most"))).toBe(true);
    expect(noBodies.tips.some((t) => t.includes("“crate”"))).toBe(true);

    const withBody = setMeshPhysics(sidecar, id, { body: "dynamic", shape: "box", mass: 1, friction: 0.5, bounce: 0 });
    const physics = await measureDownload({ modelId: "xbox360", cartridge: null, meshSidecar: encodeMeshSidecar(withBody), otherData: [], uploadedBytes: 0 });
    expect(physics.items.find((i) => i.key === "physics")!.bytes).toBe(PHYSICS_TRANSFER_BYTES.regular);
    const deterministic = await measureDownload({
      modelId: "xbox360",
      cartridge: null,
      meshSidecar: encodeMeshSidecar(setMeshPhysicsWorld(withBody, { deterministic: true })),
      otherData: [],
      uploadedBytes: 0,
    });
    expect(deterministic.items.find((i) => i.key === "physics")!.bytes).toBe(PHYSICS_TRANSFER_BYTES.deterministic);
    expect(deterministic.total).toBeGreaterThan(BUDGET_LIGHT_BYTES * 0.5);
  });

  it("rates big carts heavy and estimates load times that grow with size and fall with speed", async () => {
    const heavy = await measureDownload({ modelId: "classic", cartridge: null, meshSidecar: null, otherData: [], uploadedBytes: 20 * 1024 * 1024 });
    expect(heavy.rating).toBe("heavy");
    expect(heavy.tips.some((t) => t.startsWith("Uploaded files are large"))).toBe(true);
    const [slow, mid, fast] = heavy.loadSeconds.map((l) => l.seconds);
    expect(slow).toBeGreaterThan(mid!);
    expect(mid).toBeGreaterThan(fast!);
    // 20 MB on "Slow 4G" (1.6 Mb/s) is well over a minute and a half.
    expect(slow).toBeGreaterThan(100);
    expect(loadSeconds(0, { mbps: 10, rttMs: 100 }, 2)).toBeCloseTo(0.2);
  });
});
