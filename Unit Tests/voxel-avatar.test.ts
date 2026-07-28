/**
 * Unit tests for the voxel avatar: spec normalization/randomization, the
 * procedural voxel builder (parts layer and override correctly), and the
 * renderer's pure projection/painter math.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  ACCESSORIES,
  DEFAULT_VOXEL_AVATAR,
  HAIR_STYLES,
  HEADGEAR,
  OUTFITS,
  buildAvatarVoxels,
  normalizeVoxelAvatar,
  randomVoxelAvatar,
} from "../apps/web/src/lib/voxelAvatar";
import { projectVoxel, projectVoxels, shadeHex } from "../apps/web/src/lib/voxelRender";

describe("normalizeVoxelAvatar", () => {
  it("returns the default for garbage", () => {
    expect(normalizeVoxelAvatar(null)).toEqual(DEFAULT_VOXEL_AVATAR);
    expect(normalizeVoxelAvatar("junk")).toEqual(DEFAULT_VOXEL_AVATAR);
  });

  it("clamps out-of-range parts and palette picks", () => {
    const spec = normalizeVoxelAvatar({ hair: 999, outfit: -5, skin: 42, accessory: 2.7 });
    expect(spec.hair).toBe(HAIR_STYLES.length - 1);
    expect(spec.outfit).toBe(0);
    expect(spec.skin).toBeLessThan(6);
    expect(spec.accessory).toBe(0); // non-integer falls back
  });

  it("keeps a valid spec intact", () => {
    const valid = { ...DEFAULT_VOXEL_AVATAR, outfit: 2, headgear: 3, accessory: 1 };
    expect(normalizeVoxelAvatar(valid)).toEqual(valid);
  });
});

describe("randomVoxelAvatar", () => {
  it("is deterministic under an injected RNG and always valid", () => {
    let seed = 0.1;
    const rng = () => {
      seed = (seed * 9301 + 0.2113) % 1;
      return seed;
    };
    const first = randomVoxelAvatar(rng);
    expect(normalizeVoxelAvatar(first)).toEqual(first);

    let seed2 = 0.1;
    const rng2 = () => {
      seed2 = (seed2 * 9301 + 0.2113) % 1;
      return seed2;
    };
    expect(randomVoxelAvatar(rng2)).toEqual(first);
  });
});

describe("buildAvatarVoxels", () => {
  it("builds a substantial body for every part combination", () => {
    for (let outfit = 0; outfit < OUTFITS.length; outfit += 1) {
      for (let headgear = 0; headgear < HEADGEAR.length; headgear += 1) {
        const voxels = buildAvatarVoxels({
          ...DEFAULT_VOXEL_AVATAR,
          outfit,
          headgear,
          hair: outfit % HAIR_STYLES.length,
          accessory: headgear % ACCESSORIES.length,
        });
        expect(voxels.length).toBeGreaterThan(150);
      }
    }
  });

  it("never emits two voxels at the same cell (later parts override)", () => {
    const voxels = buildAvatarVoxels({ ...DEFAULT_VOXEL_AVATAR, hair: 4, headgear: 5, accessory: 5 });
    const keys = voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("always gives the character front-facing eyes", () => {
    const voxels = buildAvatarVoxels(DEFAULT_VOXEL_AVATAR);
    const eyes = voxels.filter((voxel) => voxel.y === 16 && voxel.z === 2 && voxel.color === "#17141f");
    expect(eyes.length).toBe(2);
  });

  it("headgear overrides hair on shared cells (a hood replaces the buzz cut)", () => {
    const hooded = buildAvatarVoxels({ ...DEFAULT_VOXEL_AVATAR, hair: 0, headgear: 5, outfitColor: 3 });
    const crownCell = hooded.find((voxel) => voxel.x === 0 && voxel.y === 19 && voxel.z === 0);
    expect(crownCell?.color).toBe("#5aa9ff"); // outfit color, not hair color
  });
});

describe("voxel projection", () => {
  it("projects the origin voxel to the screen center at angle 0", () => {
    const projected = projectVoxel({ x: -1, y: 0, z: 0, color: "#ffffff" }, 0);
    // x=-1 → dx=-0.5 → screenX = -0.5, screenY = -0.25.
    expect(projected.screenX).toBeCloseTo(-0.5);
    expect(projected.screenY).toBeCloseTo(-0.25);
  });

  it("half a turn mirrors a side voxel", () => {
    const front = projectVoxel({ x: 4, y: 0, z: 0, color: "#ffffff" }, 0);
    const back = projectVoxel({ x: 4, y: 0, z: 0, color: "#ffffff" }, Math.PI);
    expect(back.screenX).toBeCloseTo(-front.screenX);
  });

  it("painter-sorts back-to-front (nearer voxels draw later)", () => {
    const sorted = projectVoxels(
      [
        { x: 0, y: 0, z: 3, color: "near" },
        { x: 0, y: 0, z: -3, color: "far" },
      ],
      0,
    );
    expect(sorted[0]!.color).toBe("far");
    expect(sorted[1]!.color).toBe("near");
  });

  it("stacks draw upward (higher voxel after lower at the same column)", () => {
    const sorted = projectVoxels(
      [
        { x: 0, y: 5, z: 0, color: "top" },
        { x: 0, y: 0, z: 0, color: "bottom" },
      ],
      0.3,
    );
    expect(sorted[0]!.color).toBe("bottom");
  });
});

describe("shadeHex", () => {
  it("lightens toward white and darkens toward black", () => {
    expect(shadeHex("#808080", 1)).toBe("#ffffff");
    expect(shadeHex("#808080", -1)).toBe("#000000");
    expect(shadeHex("#804020", 0)).toBe("#804020");
  });
});
