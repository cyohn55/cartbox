/**
 * The AAA tier's photoreal reference scene (AAA_FIDELITY_ROADMAP.md F11b):
 * built through the pipeline, as the "ruin" starter.
 */

import { describe, expect, it } from "vitest";

import { deserializeMeshAsset, parseSceneLighting, resolveStarter, ruinLighting, ruinSidecar, ruinTerrain } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

describe("the ruin reference scene", { timeout: 120_000 }, () => {
  const json = ruinSidecar();
  const raw = JSON.parse(json) as { meshes: { id: string; mesh: string }[]; library: Record<string, string>; terrains: unknown[]; foliage: unknown[]; splines: unknown[]; lighting: unknown };
  const mesh = (id: string) => {
    const entry = raw.meshes.find((m) => m.id === id)!;
    // A mesh used more than once is stored once in the library, referenced as "@lib:<key>".
    const key = entry.mesh.startsWith("@lib:") ? entry.mesh.slice(5) : null;
    return deserializeMeshAsset(key ? raw.library[key]! : entry.mesh);
  };

  it("is a starter on the AAA tier, its sidecar a scene the player loads", () => {
    expect(resolveStarter("ruin").id).toBe("ruin");
    const scene = parseMeshScene(json);
    expect(scene).not.toBeNull();
    expect(scene!.instances.length).toBeGreaterThanOrEqual(7);
    expect(raw.terrains).toHaveLength(1);
    expect(raw.foliage.length).toBeGreaterThanOrEqual(4);
    expect(raw.splines).toHaveLength(1);
  });

  it("carves an eroded gorge: walls high over a floor with the creek's channel", () => {
    const t = ruinTerrain();
    let lo = Infinity, hi = -Infinity;
    for (const h of t.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(hi - lo).toBeGreaterThan(15);
    // The creek's bed below its water (−1.2 m).
    expect(lo).toBeLessThan(-1.6);
  });

  it("holds a cluster-rendered cliff, a scanned boulder and a pylon baked from high-poly", () => {
    const cliff = mesh("cliff");
    const tris = cliff.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(tris).toBeGreaterThan(30_000);
    expect(cliff.primitives[0]!.clusterLod).toBeTruthy();
    const boulder = mesh("boulder-1");
    expect(boulder.primitives[0]!.material.baseColorImage).toBeTruthy();
    expect(boulder.primitives.reduce((n, p) => n + p.indices.length / 3, 0)).toBeLessThanOrEqual(4200);
    const pylon = mesh("pylon");
    expect(pylon.primitives[0]!.material.normalImage).toBeTruthy();
    expect(pylon.primitives[0]!.tangents).toBeTruthy();
    const ruin = mesh("ruin");
    expect(ruin.primitives.some((p) => (p.material.emissiveFactor?.[2] ?? 0) > 1)).toBe(true);
    expect(mesh("creek").primitives[0]!.material.water?.absorption).toBeTruthy();
  });

  it("is lit at dusk: a physical sky with clouds, mist, damp ground", () => {
    const lighting = parseSceneLighting(JSON.parse(JSON.stringify(ruinLighting())))!;
    const sun = lighting.lights.find((l) => l.kind === "directional")!.direction!;
    expect((Math.asin(sun[1]) * 180) / Math.PI).toBeCloseTo(6, 1);
    expect(lighting.sky?.atmosphere?.clouds?.coverage).toBe(0.55);
    expect(lighting.fog?.volumetric).toBeTruthy();
    expect(lighting.weather?.wetness).toBe(0.4);
  });
});
