// Validates the HD-2D layered-parallax character compositor against its own real
// outputs (no hard-coded pixel values): the projection matches the orthographic
// yaw/pitch camera renderScene uses, depth-layered parts parallax as the camera
// yaws (and align head-on), nearer layers read nearer in the z-buffer, and the
// shared z-buffer occludes the character when world geometry sits in front.

import { describe, it, expect } from "vitest";
import {
  projectWorld,
  compositeCharacter,
  rigToLayers,
  type Camera,
  type CharacterLayer,
} from "../apps/web/src/lib/hd2d/character";
import { buildHeroRig } from "../apps/web/src/lib/hd2d/heroRig";

const baseCamera = (yaw: number): Camera => ({ yaw, pitch: 0.5, cell: 13, size: 360, origin: [0, 2, 0] });

describe("projectWorld", () => {
  it("gives depth-layers zero horizontal parallax head-on (yaw 0)", () => {
    const cam = baseCamera(0);
    const near = projectWorld(0, 0, 0.7, cam);
    const far = projectWorld(0, 0, -0.7, cam);
    // Same world x, only z differs — head-on the two layers share a screen column.
    expect(Math.abs(near.sx - far.sx)).toBeLessThan(1e-6);
    // ...but the +z layer is genuinely nearer the viewer in the z-buffer.
    expect(near.camZ).toBeGreaterThan(far.camZ);
  });

  it("separates depth-layers horizontally under yaw, in proportion to their depth gap", () => {
    const yaw = 0.6;
    const cam = baseCamera(yaw);
    const near = projectWorld(0, 0, 0.7, cam);
    const far = projectWorld(0, 0, -0.7, cam);
    const separation = Math.abs(near.sx - far.sx);
    // Under yaw the layers slide apart (parallax swing).
    expect(separation).toBeGreaterThan(1);
    // Matches the camera's own math: Δsx = Δz * sin(yaw) * cell.
    const expected = Math.abs(0.7 - -0.7) * Math.sin(yaw) * cam.cell;
    expect(separation).toBeCloseTo(expected, 5);
  });

  it("matches renderScene's projection form (origin translate → yaw → pitch → cell)", () => {
    const cam = baseCamera(0.3);
    const p = projectWorld(2, 5, 1, cam);
    const [ox, oy, oz] = cam.origin;
    const wx = 2 - ox, wy = 5 - oy, wz = 1 - oz;
    const yawX = wx * Math.cos(cam.yaw) + wz * Math.sin(cam.yaw);
    const yawZ = -wx * Math.sin(cam.yaw) + wz * Math.cos(cam.yaw);
    const camY = wy * Math.cos(cam.pitch) - yawZ * Math.sin(cam.pitch);
    expect(p.sx).toBeCloseTo(cam.size / 2 + yawX * cam.cell, 6);
    expect(p.sy).toBeCloseTo(cam.size / 2 - camY * cam.cell, 6);
  });
});

describe("compositeCharacter", () => {
  const layers: CharacterLayer[] = rigToLayers(buildHeroRig());

  it("adapts the hero rig into depth-ordered, non-empty layers", () => {
    expect(layers.length).toBe(buildHeroRig().parts.length);
    for (const layer of layers) {
      const painted = layer.sprite.data.some((_, i) => i % 4 === 3 && layer.sprite.data[i]! > 0);
      expect(painted).toBe(true);
    }
    // Ordered back (most negative dz) to front (most positive) so painter order is correct.
    for (let i = 1; i < layers.length; i += 1) expect(layers[i]!.dz).toBeGreaterThan(layers[i - 1]!.dz);
  });

  it("draws the character over an empty world", () => {
    const cam = baseCamera(0);
    const data = new Uint8ClampedArray(cam.size * cam.size * 4);
    const depth = new Float32Array(cam.size * cam.size).fill(-Infinity);
    compositeCharacter(data, depth, cam, layers, [0, 0, 0], 2);
    const wrote = data.some((_, i) => i % 4 === 3 && data[i]! > 0);
    expect(wrote).toBe(true);
  });

  it("is fully occluded when world geometry sits in front (shared z-buffer)", () => {
    const cam = baseCamera(0);
    const data = new Uint8ClampedArray(cam.size * cam.size * 4);
    // Every world pixel is nearer than anything the character can reach.
    const depth = new Float32Array(cam.size * cam.size).fill(Infinity);
    compositeCharacter(data, depth, cam, layers, [0, 0, 0], 2);
    const wrote = data.some((value) => value > 0);
    expect(wrote).toBe(false);
  });

  it("grounds the character: its lowest drawn row sits near the projected foot", () => {
    const cam = baseCamera(0);
    const data = new Uint8ClampedArray(cam.size * cam.size * 4);
    const depth = new Float32Array(cam.size * cam.size).fill(-Infinity);
    const scale = 2;
    compositeCharacter(data, depth, cam, layers, [0, 0, 0], scale);
    let lowest = -1;
    for (let y = 0; y < cam.size; y += 1)
      for (let x = 0; x < cam.size; x += 1)
        if (data[(y * cam.size + x) * 4 + 3]! > 0) lowest = Math.max(lowest, y);
    const foot = projectWorld(0, 0, 0, cam);
    // The feet (bottom of the sprite) land at the projected foot, within a texel.
    expect(Math.abs(lowest - Math.round(foot.sy))).toBeLessThanOrEqual(scale);
  });
});
