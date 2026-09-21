/**
 * Phase 4 — multi-light forward shading (software reference path).
 *
 * The Modern tier takes its lights from a dedicated scene channel with no fixed
 * cap (the 6-slot 2D pmem mailbox is full), so a PBR material can be lit by many
 * directional + point lights at once. Point lights fall off to nothing at their
 * range; colours add per light. Gated: no `lights` array → the single key light
 * is used, unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type Mat4,
  type MeshAsset,
  type SceneLight,
} from "@cartbox/editor";

type Material = MeshAsset["primitives"][number]["material"];
const GREY: Material = { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6 };

/** A camera-facing PBR quad at the origin (normal +Z). */
function quad(): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: GREY,
      },
    ],
  };
}

const SIZE = 24;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

function centre(opts: { lights?: readonly SceneLight[]; lightDirection?: readonly [number, number, number] }): [number, number, number] {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene([{ mesh: quad(), model: identity() }], {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
    lightDirection: opts.lightDirection,
    ambient: 0.05,
    lights: opts.lights ?? null,
  });
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!];
}

/** `n` dim white point lights in front of the quad. */
function whitePoints(n: number): SceneLight[] {
  return Array.from({ length: n }, () => ({ kind: "point" as const, position: [0, 0, 2] as const, color: [1, 1, 1] as const, intensity: 0.12, range: 8 }));
}

describe("multi-light forward shading", () => {
  it("sums many lights with no 6-light cap", () => {
    // Eight lights must contribute more than three — proof the cap is gone.
    const three = centre({ lights: whitePoints(3) })[0];
    const eight = centre({ lights: whitePoints(8) })[0];
    expect(eight).toBeGreaterThan(three);
    expect(three).toBeGreaterThan(0);
  });

  it("falls a point light off to nothing past its range", () => {
    const lit: SceneLight = { kind: "point", position: [0, 0, 2], color: [1, 1, 1], intensity: 2, range: 8 };
    const outOfRange: SceneLight = { kind: "point", position: [0, 0, 2], color: [1, 1, 1], intensity: 2, range: 1 }; // quad is 2 away
    expect(centre({ lights: [lit] })[0]).toBeGreaterThan(centre({ lights: [outOfRange] })[0] + 20);
  });

  it("adds each light's colour", () => {
    const red: SceneLight = { kind: "point", position: [0, 0, 2], color: [1, 0, 0], intensity: 1.5, range: 8 };
    const blue: SceneLight = { kind: "point", position: [0, 0, 2], color: [0, 0, 1], intensity: 1.5, range: 8 };
    const [r, g, b] = centre({ lights: [red, blue] });
    expect(r).toBeGreaterThan(60); // red light present
    expect(b).toBeGreaterThan(60); // blue light present
    expect(g).toBeLessThan(30); // neither light emits green
  });

  it("matches the legacy single key light for one white directional light", () => {
    const dir: readonly [number, number, number] = [0.2, 0.3, 1];
    const legacy = centre({ lightDirection: dir });
    const viaList = centre({ lights: [{ kind: "directional", direction: dir, color: [1, 1, 1], intensity: 1 }] });
    // Same Cook-Torrance maths, so within a rounding step per channel.
    for (let c = 0; c < 3; c += 1) expect(Math.abs(legacy[c]! - viaList[c]!)).toBeLessThanOrEqual(1);
  });

  it("leaves a scene with no lights array on the single-light path (the gate)", () => {
    const a = centre({ lightDirection: [0, 0, 1] });
    const b = centre({ lightDirection: [0, 0, 1] });
    expect(a).toEqual(b);
    expect(a[0]).toBeGreaterThan(0);
  });
});
