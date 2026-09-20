/**
 * The N64 courtyard and Xbox 360 foundry starters.
 *
 * Unlike the PS1 starter — which shares the PS1 test scene's geometry so the two
 * carts differ only in rasterisation — these two carts exist to *look like* their
 * eras: a cart a creator opens on and builds from. Whether they read as N64 or
 * 360 is a judgement no test can make; what these guard is that each ships real,
 * distinct, drawable geometry sized for its model, so the cart is never quietly
 * empty, a PS1 clone, or over its budget.
 */

import { describe, expect, it } from "vitest";

import {
  MaterialMap,
  N64_CODE,
  N64_MESH_SIDECAR,
  N64_SCENE_TRIANGLES,
  NormalMap,
  PS1_MESH_SIDECAR,
  SpriteSheet,
  StubCartEngine,
  XBOX360_ASSETS_SIDECAR,
  XBOX360_CODE,
  XBOX360_MESH_SIDECAR,
  XBOX360_SCENE_TRIANGLES,
  deserializeMeshAsset,
  resolveStarter,
  seedXbox360Cart,
} from "@cartbox/editor";
import { MODELS, parseMeshScene } from "@cartbox/player";

import { isSpriteBlockAsset } from "../apps/web/src/lib/cartAssets";
import { rebakeMeshSidecar } from "../apps/web/src/lib/meshTextureBake";
import { defaultStarterForModel } from "../apps/web/src/lib/starter";
import { decodeVoxelSidecar } from "../apps/web/src/lib/voxelSidecar";

/** Read a PNG's [width, height] from its IHDR. */
function pngSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes.subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
  return [view.getUint32(16), view.getUint32(20)];
}

describe("the N64 courtyard starter", () => {
  const n64 = MODELS.n64;

  it("is registered, reachable, and opens by default for the model", () => {
    expect(resolveStarter("n64").id).toBe("n64");
    expect(defaultStarterForModel("n64")).toBe("n64");
  });

  it("ships its own geometry — not the PS1 scene's", () => {
    expect(resolveStarter("n64").mesh).toBe(N64_MESH_SIDECAR);
    expect(N64_MESH_SIDECAR).not.toBe(PS1_MESH_SIDECAR);
  });

  it("parses into a scene the runtime can actually draw", () => {
    const scene = parseMeshScene(N64_MESH_SIDECAR)!;
    expect(scene).not.toBeNull();
    expect(scene.instances).toHaveLength(1);
    expect(scene.bounds.radius).toBeGreaterThan(0);
    // Distinct materials (grass, hills, trunks, canopy, gem) are what make it
    // read as a scene rather than one tiled block.
    expect(scene.instances[0]!.mesh.primitives.length).toBeGreaterThanOrEqual(4);
  });

  it("fits the N64 poly budget with room to spare", () => {
    expect(N64_SCENE_TRIANGLES).toBeGreaterThan(200);
    expect(N64_SCENE_TRIANGLES).toBeLessThan(n64.renderCaps.polyBudget / 2);
  });

  it("carries a ground texture the 4KB cache must downsample", () => {
    // The N64 look is a texture too big for the cache, box-filtered down to fit.
    // A source that already fit would never blur, so this asserts it does not.
    const scene = parseMeshScene(N64_MESH_SIDECAR)!;
    const textured = scene.instances[0]!.mesh.primitives.find((p) => p.material.baseColorImage);
    const image = textured!.material.baseColorImage!;
    expect(image.mime).toBe("image/png");
    const [w, h] = pngSize(image.bytes);
    expect([w, h]).toEqual([64, 64]);
    expect(w * h * 4).toBeGreaterThan(n64.renderCaps.textureCacheBytes);
  });

  it("drives its own camera", () => {
    expect(N64_CODE).toContain("cartbox.meshcam");
  });
});

describe("the Xbox 360 foundry starter", () => {
  const xbox360 = MODELS.xbox360;

  it("is registered, reachable, and opens by default for the model", () => {
    expect(resolveStarter("xbox360").id).toBe("xbox360");
    expect(defaultStarterForModel("xbox360")).toBe("xbox360");
  });

  it("ships its own geometry, distinct from the PS1 and N64 scenes", () => {
    expect(resolveStarter("xbox360").mesh).toBe(XBOX360_MESH_SIDECAR);
    expect(XBOX360_MESH_SIDECAR).not.toBe(PS1_MESH_SIDECAR);
    expect(XBOX360_MESH_SIDECAR).not.toBe(N64_MESH_SIDECAR);
  });

  it("parses into a scene the runtime can actually draw", () => {
    const scene = parseMeshScene(XBOX360_MESH_SIDECAR)!;
    expect(scene).not.toBeNull();
    expect(scene.instances).toHaveLength(1);
    expect(scene.bounds.radius).toBeGreaterThan(0);
  });

  it("spends the tier's unbounded budget on a dense scene", () => {
    // The 360's whole point is no poly ceiling (polyBudget 0 = unbounded), so the
    // foundry is far denser than the PS1/N64 scenes rather than a few crates.
    expect(xbox360.renderCaps.polyBudget).toBe(0);
    expect(XBOX360_SCENE_TRIANGLES).toBeGreaterThan(1000);
    expect(XBOX360_SCENE_TRIANGLES).toBeGreaterThan(N64_SCENE_TRIANGLES);
  });

  it("carries a full-detail texture the tier does not downsample", () => {
    // 128x128 — four times the PS1/N64 page — kept sharp because the 360 has no
    // small texture cache to blur it.
    const scene = parseMeshScene(XBOX360_MESH_SIDECAR)!;
    const textured = scene.instances[0]!.mesh.primitives.find((p) => p.material.baseColorImage);
    const image = textured!.material.baseColorImage!;
    expect(image.mime).toBe("image/png");
    expect(pngSize(image.bytes)).toEqual([128, 128]);
  });

  it("drives its own camera at HD framing", () => {
    expect(XBOX360_CODE).toContain("cartbox.meshcam");
    expect(XBOX360_CODE).toContain("1280x720");
  });

  it("emits lights and draws the relit badge each frame", () => {
    // Option 1: a fresh 360 cart shows material reacting to light out of the box.
    expect(XBOX360_CODE).toContain("cartbox.clearlights()");
    expect(XBOX360_CODE).toContain("cartbox.sun(");
    expect(XBOX360_CODE).toContain("cartbox.light(");
    // Draws sprite 256 (page 1, tile 0) — the badge the engine relights.
    expect(XBOX360_CODE).toMatch(/spr\(\s*(BADGE|256)/);
  });

  it("ships the Lit badge as an editable named asset", () => {
    const list = decodeVoxelSidecar(XBOX360_ASSETS_SIDECAR).assets;
    const badge = list.find((asset) => isSpriteBlockAsset(asset) && asset.name === "Lit badge");
    expect(badge, "a \"Lit badge\" sprite block").toBeTruthy();
    if (badge && isSpriteBlockAsset(badge)) {
      expect(badge.page).toBe(1);
      expect(badge.tilesPerSide).toBe(4); // 32px / 8px tiles
    }
  });

  it("ships the foundry with a lit surface baked in (normal + material maps)", () => {
    // Option 2, slice 5: the 3D foundry itself catches light out of the box, not
    // just the 2D badge — the grunge primitive carries both a normal map and a
    // packed material map (specular/roughness/emissive).
    const grunge = deserializeMeshAsset(
      (JSON.parse(XBOX360_MESH_SIDECAR) as { meshes: { mesh: string }[] }).meshes[0]!.mesh,
    ).primitives.find((p) => p.material.textureSprite)!;
    expect(grunge.material.normalImage?.mime).toBe("image/png");
    expect(grunge.material.materialImage?.mime).toBe("image/png");
    expect(pngSize(grunge.material.normalImage!.bytes)).toEqual([128, 128]);
    expect(pngSize(grunge.material.materialImage!.bytes)).toEqual([128, 128]);
  });

  it("reproduces the baked normal + material maps from the seeded banks — no phantom dirty", async () => {
    // The phantom-dirty guard for slice 5: the seeded Normal/Material banks must
    // rebake to the exact bytes the mesh already ships, or opening and running
    // the starter would mark it dirty with no edit. Seed a real engine and rebake
    // through the same path the workbench uses on Run, then compare the two maps
    // the seed introduced. (baseColor round-trips through the real 256-colour
    // palette, an invariant older than this change; StubCartEngine's palette is
    // too small to hold the era CLUT, so it is not asserted here.)
    const engine = new StubCartEngine();
    seedXbox360Cart(engine);
    const sheet = new SpriteSheet(engine);
    const normals = new NormalMap(engine);
    const material = {
      height: new MaterialMap(engine, "height"),
      specular: new MaterialMap(engine, "specular"),
      roughness: new MaterialMap(engine, "roughness"),
      emissive: new MaterialMap(engine, "emissive"),
    };
    const rebaked = (await rebakeMeshSidecar(XBOX360_MESH_SIDECAR, sheet, engine.getPalette(), normals, material))!;
    const grungeOf = (sidecar: string) =>
      deserializeMeshAsset((JSON.parse(sidecar) as { meshes: { mesh: string }[] }).meshes[0]!.mesh).primitives.find(
        (p) => p.material.textureSprite,
      )!;
    const seeded = grungeOf(XBOX360_MESH_SIDECAR);
    const round = grungeOf(rebaked);
    expect(round.material.normalImage!.bytes).toEqual(seeded.material.normalImage!.bytes);
    expect(round.material.materialImage!.bytes).toEqual(seeded.material.materialImage!.bytes);
  });
});
