/**
 * Every map's stored bakes still fit it (BEAVER_CREEK_ROADMAP.md B1). A map
 * whose geometry changed without a re-bake fails here, by name, instead of
 * shipping unlit: run `npm run bake:map <id>`.
 */

import { describe, expect, it } from "vitest";

import { MAP_BAKES, layoutFingerprint, mapBakeStatus } from "@cartbox/editor";

describe("every map's bakes", () => {
  for (const id of Object.keys(MAP_BAKES)) {
    it(`${id}: the light map, the probes, the kit maps and the compressed textures are current`, () => {
      expect(mapBakeStatus(id), `stale bake: run \`npm run bake:map ${id}\``).toEqual({ lightmap: true, probes: true, kit: true, textures: true });
    });
  }

  it("notices a change of geometry: a moved vertex changes the fingerprint", () => {
    const layout = MAP_BAKES.lockout!.layout();
    const prim = layout.mesh.primitives[0]!;
    const positions = Float32Array.from(prim.positions);
    positions[0]! += 0.5;
    const moved = { ...layout, mesh: { ...layout.mesh, primitives: [{ ...prim, positions }, ...layout.mesh.primitives.slice(1)] } };
    expect(layoutFingerprint(moved)).not.toBe(layoutFingerprint(layout));
  });

  it("refuses a map it doesn't know", () => {
    expect(() => mapBakeStatus("nowhere")).toThrow(/known: lockout/);
  });
});
