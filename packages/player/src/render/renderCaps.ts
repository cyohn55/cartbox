/**
 * Enforcing a model's {@link RenderCaps} on a scene, before anything rasterises it.
 *
 * `RenderCaps` landed as a descriptor nothing read — which is the difference
 * between a field and a seam. This reads two of them.
 *
 * Both are enforced *here*, above the renderer, rather than inside either
 * backend. That is deliberate: a constraint applied to the scene is honoured
 * identically by the software rasteriser and the GPU, so an era model's limits
 * do not depend on whether the viewer's browser has WebGPU. The caps that
 * cannot be lifted out this way — no depth buffer, affine texture mapping,
 * integer vertex snapping, texture filtering — live inside the rasteriser and
 * are not honoured yet; see ERA_MODELS.md §4a for why that ordering matters.
 *
 * Pure and DOM-free, so the limits are testable without a GPU.
 */

import type { DecodedTexture, MeshSceneInstance } from "@cartbox/editor";

import type { RenderCaps } from "../models.js";

/**
 * Memo of downsampled textures, keyed by their source.
 *
 * Identity stability is the point, not just the saved work: the GPU renderer
 * caches its uploads by texture object, so returning a fresh object each frame
 * would re-upload every texture on every frame — strictly worse than no cap at
 * all. Held by the caller so it lives as long as the renderer does.
 */
export type TextureBudgetCache = WeakMap<DecodedTexture, DecodedTexture>;

export function createTextureBudgetCache(): TextureBudgetCache {
  return new WeakMap();
}

/** Triangles across every primitive of an instance. */
function triangleCount(instance: MeshSceneInstance): number {
  let total = 0;
  for (const primitive of instance.mesh.primitives) total += primitive.indices.length / 3;
  return total;
}

/**
 * Drop whole instances once the frame's triangle budget is spent.
 *
 * Granularity is the instance, not the triangle, for two reasons. Slicing index
 * buffers mid-mesh would allocate fresh geometry every frame and miss the
 * renderer's upload cache; and half an object is not a thing any real console
 * drew — it ran out of time and dropped the frame.
 *
 * The first instance always draws even if it alone exceeds the budget: a single
 * over-budget object is a content problem for the editor to flag, not something
 * the runtime should silently blank. So this bounds scene *complexity across
 * objects*, which is what a poly budget is actually for.
 */
export function capTriangles(
  instances: readonly MeshSceneInstance[],
  polyBudget: number,
): readonly MeshSceneInstance[] {
  if (polyBudget <= 0 || instances.length === 0) return instances; // 0 = unbounded
  let used = 0;
  for (let index = 0; index < instances.length; index += 1) {
    used += triangleCount(instances[index]!);
    if (used > polyBudget) {
      // Keep at least one, then cut here.
      return instances.slice(0, Math.max(1, index));
    }
  }
  return instances;
}

/**
 * Halve a texture with a box filter until it fits the budget.
 *
 * This is what a small texture cache actually looked like: the N64's 4KB budget
 * is why its era reads as soft and low-resolution, not because the hardware
 * blurred things for effect. Halving (rather than resampling to an arbitrary
 * size) keeps the filter exact — every output texel is the mean of four inputs —
 * and keeps power-of-two art on its grid.
 */
export function fitTextureToBudget(source: DecodedTexture, budgetBytes: number): DecodedTexture {
  if (budgetBytes <= 0) return source; // 0 = unbounded
  let current = source;
  // Stop at 1x1: a budget below four bytes cannot be met, and returning an
  // empty texture would be worse than returning the smallest real one.
  while (current.width * current.height * 4 > budgetBytes && (current.width > 1 || current.height > 1)) {
    current = halve(current);
  }
  return current;
}

/** One box-filtered halving step, rounding odd dimensions up to keep a row. */
function halve(source: DecodedTexture): DecodedTexture {
  const width = Math.max(1, source.width >> 1);
  const height = Math.max(1, source.height >> 1);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // The four source texels this one averages, clamped at the edges so an
      // odd dimension samples inside the image rather than off the end.
      const x0 = Math.min(source.width - 1, x * 2);
      const x1 = Math.min(source.width - 1, x * 2 + 1);
      const y0 = Math.min(source.height - 1, y * 2);
      const y1 = Math.min(source.height - 1, y * 2 + 1);
      const at = (px: number, py: number): number => (py * source.width + px) * 4;
      const a = at(x0, y0);
      const b = at(x1, y0);
      const c = at(x0, y1);
      const d = at(x1, y1);
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        data[to + channel] =
          (source.data[a + channel]! +
            source.data[b + channel]! +
            source.data[c + channel]! +
            source.data[d + channel]!) /
          4;
      }
    }
  }

  return { width, height, data };
}

/**
 * Fit every instance's textures into the budget, reusing cached results so a
 * texture is downsampled once rather than once per frame.
 *
 * Returns the original array when nothing needed shrinking, so an unbounded
 * model allocates nothing. When something does shrink, only the instance
 * wrapper is rebuilt — `mesh` keeps its identity, so the renderer's geometry
 * cache still hits.
 */
export function capTextures(
  instances: readonly MeshSceneInstance[],
  budgetBytes: number,
  cache: TextureBudgetCache,
): readonly MeshSceneInstance[] {
  if (budgetBytes <= 0) return instances;

  let changed = false;
  const capped = instances.map((instance) => {
    const textures = instance.textures;
    if (!textures) return instance;

    let instanceChanged = false;
    const fitted = textures.map((texture) => {
      if (!texture) return texture;
      const memo = cache.get(texture);
      if (memo) {
        if (memo !== texture) instanceChanged = true;
        return memo;
      }
      const result = fitTextureToBudget(texture, budgetBytes);
      cache.set(texture, result);
      if (result !== texture) instanceChanged = true;
      return result;
    });

    if (!instanceChanged) return instance;
    changed = true;
    return { mesh: instance.mesh, model: instance.model, textures: fitted };
  });

  return changed ? capped : instances;
}

/** Apply every scene-level cap a model declares. */
export function applyRenderCaps(
  instances: readonly MeshSceneInstance[],
  caps: RenderCaps,
  cache: TextureBudgetCache,
): readonly MeshSceneInstance[] {
  return capTextures(capTriangles(instances, caps.polyBudget), caps.textureCacheBytes, cache);
}
