/**
 * Enforcing RenderCaps on a scene.
 *
 * `RenderCaps` shipped as a descriptor nothing read. These cover the two limits
 * that are now actually applied — the frame's triangle budget and the texture
 * cache — plus the properties that make applying them safe: identity stability
 * (the renderer caches uploads by object, so a cap that returns fresh objects
 * every frame is worse than no cap), and enforcement above the backend, so the
 * software rasteriser and the GPU obey a model's limits identically.
 */

import { describe, expect, it, vi } from "vitest";

import { composeModelMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import {
  CappedSceneRenderer,
  SOFTWARE_RASTER_CAPS,
  applyRenderCaps,
  capTextures,
  capTriangles,
  capsConstrainScene,
  createTextureBudgetCache,
  fitTextureToBudget,
  type RenderCaps,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";

/** A mesh with `triangles` triangles, so budgets are countable. */
function mesh(triangles: number, textureCount = 0): MeshAsset {
  return {
    name: `mesh-${triangles}`,
    primitives: [
      {
        positions: new Float32Array(triangles * 9),
        normals: new Float32Array(triangles * 9),
        uvs: textureCount > 0 ? new Float32Array(triangles * 6) : null,
        indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

function instance(m: MeshAsset, textures: (DecodedTexture | null)[] | null = null): MeshSceneInstance {
  return { mesh: m, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures };
}

/** A solid texture of a given size, so byte budgets are countable. */
function texture(size: number, value = 200): DecodedTexture {
  return { width: size, height: size, data: new Uint8ClampedArray(size * size * 4).fill(value) };
}

function caps(overrides: Partial<RenderCaps>): RenderCaps {
  return { ...SOFTWARE_RASTER_CAPS, ...overrides };
}

describe("capTriangles", () => {
  it("treats a zero budget as unbounded", () => {
    const scene = [instance(mesh(1000)), instance(mesh(1000))];
    expect(capTriangles(scene, 0)).toBe(scene); // same array: nothing allocated
  });

  it("drops instances once the budget is spent", () => {
    const scene = [instance(mesh(10)), instance(mesh(10)), instance(mesh(10))];
    expect(capTriangles(scene, 25)).toHaveLength(2);
    expect(capTriangles(scene, 30)).toHaveLength(3);
    expect(capTriangles(scene, 20)).toHaveLength(2);
  });

  it("always draws the first instance, even when it alone busts the budget", () => {
    // A single over-budget object is a content problem for the editor to flag,
    // not something the runtime should silently blank.
    const scene = [instance(mesh(5000)), instance(mesh(1))];
    const capped = capTriangles(scene, 10);
    expect(capped).toHaveLength(1);
    expect(capped[0]).toBe(scene[0]);
  });

  it("preserves instance identity so the renderer's upload cache still hits", () => {
    // Slicing index buffers mid-mesh would allocate fresh geometry every frame
    // and miss the cache — strictly worse than not capping at all.
    const scene = [instance(mesh(10)), instance(mesh(10))];
    const capped = capTriangles(scene, 10);
    expect(capped[0]).toBe(scene[0]);
  });

  it("handles an empty scene", () => {
    expect(capTriangles([], 100)).toEqual([]);
  });
});

describe("fitTextureToBudget", () => {
  it("treats a zero budget as unbounded", () => {
    const source = texture(64);
    expect(fitTextureToBudget(source, 0)).toBe(source);
  });

  it("leaves a texture that already fits untouched", () => {
    const source = texture(8); // 8*8*4 = 256 bytes
    expect(fitTextureToBudget(source, 4096)).toBe(source);
  });

  it("halves until the texture fits, which is the N64 look", () => {
    // 64x64 = 16384 bytes against a 4KB cache: one halving reaches 32x32 =
    // 4096, exactly the budget. Small textures are *why* that era reads soft.
    const fitted = fitTextureToBudget(texture(64), 4096);
    expect(fitted.width).toBe(32);
    expect(fitted.height).toBe(32);
    expect(fitted.data.length).toBe(32 * 32 * 4);
  });

  it("box-filters rather than dropping texels", () => {
    // A 2x1 checker averages to the midpoint; point-sampling would keep one.
    const source: DecodedTexture = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        0, 0, 0, 255, 100, 100, 100, 255,
        200, 200, 200, 255, 0, 0, 0, 255,
      ]),
    };
    const fitted = fitTextureToBudget(source, 4);
    expect(fitted.width).toBe(1);
    expect(fitted.data[0]).toBe(75); // (0 + 100 + 200 + 0) / 4
  });

  it("stops at 1x1 rather than producing an empty texture", () => {
    const fitted = fitTextureToBudget(texture(16), 1);
    expect(fitted.width).toBe(1);
    expect(fitted.height).toBe(1);
    expect(fitted.data.length).toBe(4);
  });
});

describe("capTextures", () => {
  it("returns the original scene when nothing needs shrinking", () => {
    const scene = [instance(mesh(1, 1), [texture(4)])];
    expect(capTextures(scene, 4096, createTextureBudgetCache())).toBe(scene);
  });

  it("downsamples to the same object across frames", () => {
    // Identity stability is the point: the GPU renderer caches uploads by
    // texture object, so a fresh object per frame re-uploads every frame.
    const cache = createTextureBudgetCache();
    const source = texture(64);
    const scene = [instance(mesh(1, 1), [source])];

    const first = capTextures(scene, 4096, cache);
    const second = capTextures(scene, 4096, cache);
    expect(first[0]!.textures![0]).toBe(second[0]!.textures![0]);
    expect(first[0]!.textures![0]).not.toBe(source);
  });

  it("keeps the mesh identity when only textures change", () => {
    // The geometry cache is keyed on the mesh; rebuilding that would re-upload
    // every vertex buffer for a texture-only change.
    const cache = createTextureBudgetCache();
    const geometry = mesh(1, 1);
    const scene = [instance(geometry, [texture(64)])];
    expect(capTextures(scene, 4096, cache)[0]!.mesh).toBe(geometry);
  });

  it("leaves untextured instances alone", () => {
    const scene = [instance(mesh(1)), instance(mesh(1), [null])];
    const capped = capTextures(scene, 16, createTextureBudgetCache());
    expect(capped[0]).toBe(scene[0]);
    expect(capped[1]).toBe(scene[1]);
  });
});

describe("capsConstrainScene", () => {
  it("is false for the unbounded models that ship today", () => {
    expect(capsConstrainScene(SOFTWARE_RASTER_CAPS)).toBe(false);
  });

  it("is true once an era model sets a budget", () => {
    expect(capsConstrainScene(caps({ polyBudget: 1000 }))).toBe(true);
    expect(capsConstrainScene(caps({ textureCacheBytes: 4096 }))).toBe(true);
  });
});

describe("CappedSceneRenderer", () => {
  function spy(): SceneRenderer & { seen: readonly MeshSceneInstance[][] } {
    const seen: readonly MeshSceneInstance[][] = [];
    return {
      backend: "software",
      seen,
      render: (instances) => void (seen as MeshSceneInstance[][]).push([...instances]),
      dispose: vi.fn(),
    };
  }

  const draw = {} as SceneDraw;

  it("caps the scene before the backend ever sees it", () => {
    // Enforcing above the backend is what makes a model's limits identical on
    // the software rasteriser and the GPU.
    const inner = spy();
    const renderer = new CappedSceneRenderer(inner, caps({ polyBudget: 15 }));
    renderer.render([instance(mesh(10)), instance(mesh(10))], draw);
    expect(inner.seen[0]).toHaveLength(1);
  });

  it("reports the backend it wraps, not itself", () => {
    // Diagnostics and tests ask which backend is live; the wrapper is not one.
    expect(new CappedSceneRenderer(spy(), caps({ polyBudget: 1 })).backend).toBe("software");
  });

  it("disposes the renderer it wraps", () => {
    const inner = spy();
    new CappedSceneRenderer(inner, caps({ polyBudget: 1 })).dispose();
    expect(inner.dispose).toHaveBeenCalledTimes(1);
  });

  it("holds one texture cache for its lifetime, not per frame", () => {
    const inner = spy();
    const renderer = new CappedSceneRenderer(inner, caps({ textureCacheBytes: 4096 }));
    const scene = [instance(mesh(1, 1), [texture(64)])];
    renderer.render(scene, draw);
    renderer.render(scene, draw);
    expect(inner.seen[0]![0]!.textures![0]).toBe(inner.seen[1]![0]!.textures![0]);
  });
});

describe("applyRenderCaps", () => {
  it("applies the triangle budget before the texture budget", () => {
    // Dropped instances should not pay for texture downsampling they will never
    // use — the cheap cut first is the only ordering that makes sense.
    const cache = createTextureBudgetCache();
    const kept = texture(64);
    const dropped = texture(64);
    const scene = [instance(mesh(10), [kept]), instance(mesh(10), [dropped])];

    applyRenderCaps(scene, caps({ polyBudget: 10, textureCacheBytes: 4096 }), cache);
    expect(cache.has(kept)).toBe(true);
    expect(cache.has(dropped)).toBe(false);
  });

  it("is a no-op for an unbounded model", () => {
    const scene = [instance(mesh(9999), [texture(256)])];
    expect(applyRenderCaps(scene, SOFTWARE_RASTER_CAPS, createTextureBudgetCache())).toBe(scene);
  });
});
