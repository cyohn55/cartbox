/**
 * Draws recorded once (AAA_FIDELITY_ROADMAP.md F0e): with GPU culling, a
 * frame's scene passes issue the same commands every frame (the copies drawn
 * and their counts live in GPU buffers, the uniforms' values change but not
 * where they sit), so each pass's draws are recorded into a render bundle and
 * replayed with one call. A bundle is recorded again only when what its
 * commands name changes: a pipeline, a bind group, a buffer, an offset.
 *
 * The key is the list of those things, compared one by one (object identity
 * for GPU objects), so walking it costs a few hundred comparisons rather than
 * a few thousand calls into the GPU API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

/** The formats a bundle is recorded for: they must match the pass it plays in. */
export interface BundleTarget {
  readonly colorFormats: readonly string[];
  readonly depthStencilFormat: string;
  readonly sampleCount: number;
  readonly depthReadOnly: boolean;
}

export class BundleCache {
  private readonly slots = new Map<string, { key: unknown[]; target: string; bundle: any }>();
  /** Bundles recorded since made (for tests and stats). */
  recorded = 0;

  constructor(private readonly device: any) {}

  /** The bundle for `slot`, recorded with `record` when `key` (or the target) differs from the last one's. */
  get(slot: string, target: BundleTarget, key: readonly unknown[], record: (encoder: any) => void): any {
    const targetKey = `${target.colorFormats.join(",")}|${target.depthStencilFormat}|${target.sampleCount}|${target.depthReadOnly ? 1 : 0}`;
    const cached = this.slots.get(slot);
    if (cached && cached.target === targetKey && sameKey(cached.key, key)) return cached.bundle;
    const encoder = this.device.createRenderBundleEncoder({
      colorFormats: [...target.colorFormats],
      depthStencilFormat: target.depthStencilFormat,
      sampleCount: target.sampleCount,
      depthReadOnly: target.depthReadOnly,
      stencilReadOnly: true,
    });
    record(encoder);
    const bundle = encoder.finish();
    this.slots.set(slot, { key: [...key], target: targetKey, bundle });
    this.recorded += 1;
    return bundle;
  }

  /** Forget every bundle (a resource they name went away). */
  clear(): void {
    this.slots.clear();
  }
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
