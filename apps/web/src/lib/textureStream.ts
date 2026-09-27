/**
 * Streaming a cart's textures after it starts (ENGINE_ROADMAP.md, Phase 4).
 *
 * A published 3D scene keeps its textures in the cart asset store (see
 * meshTextureAssets.ts), so the scene the page hands the player carries only
 * placeholders: the cart starts on geometry alone, with flat colours. This
 * fetches each texture from its immutable, cacheable URL — a few at a time,
 * reporting bytes as they arrive — and hands each one over as it lands, for
 * the player to swap in.
 */

import type { EncodedImage } from "@cartbox/editor";

/** One texture to stream: its content hash (the placeholder's ref), URL, size and type. */
export interface StreamedTexture {
  readonly hash: string;
  readonly url: string;
  /** Size in bytes, if known (for progress before the response says). */
  readonly bytes: number;
  readonly mime: string;
  /** The levels that need it (see meshTextureLevels); absent = needed at start. */
  readonly levels?: readonly string[];
}

export interface StreamOptions {
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly onTexture: (hash: string, image: EncodedImage) => void;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Fetch every texture, calling `onTexture` for each as it completes. A texture
 * that fails to download is skipped (its surface keeps its flat colour).
 * Resolves with how many arrived.
 */
export async function streamTextures(textures: readonly StreamedTexture[], options: StreamOptions): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const total = textures.reduce((sum, t) => sum + Math.max(0, t.bytes), 0);
  let loaded = 0;
  let arrived = 0;
  let next = 0;
  const report = () => options.onProgress?.(Math.min(loaded, total), total);
  const one = async (texture: StreamedTexture) => {
    let counted = 0;
    try {
      const response = await fetchImpl(texture.url, { signal: options.signal });
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        counted += value.byteLength;
        loaded += value.byteLength;
        report();
      }
      const bytes = new Uint8Array(counted);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      arrived += 1;
      options.onTexture(texture.hash, { mime: texture.mime, bytes });
    } catch {
      if (options.signal?.aborted) return;
    } finally {
      // Settle this texture's share of the total, however it ended.
      loaded += Math.max(0, texture.bytes - counted);
      report();
    }
  };
  const worker = async () => {
    while (next < textures.length && !options.signal?.aborted) await one(textures[next++]!);
  };
  report();
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, textures.length) }, worker));
  return arrived;
}
