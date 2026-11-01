/**
 * Image decoding off the main thread (AAA_FIDELITY_ROADMAP.md F0e): a small
 * pool of workers turns encoded images (PNG, JPEG, WebP) into RGBA, each with
 * the browser's own decoder (createImageBitmap onto an OffscreenCanvas), and
 * hands the pixels back as a transferred buffer, so a scene's textures decode
 * while the main thread keeps drawing.
 *
 * The workers are made from an inline script (a Blob URL), so the player
 * needs no separate file served. Where workers or OffscreenCanvas don't exist,
 * {@link decodePool} is null and the caller decodes on the main thread.
 */

import type { DecodedTexture } from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any -- the worker globals aren't in this build's libs */

/** The workers' script: decode `{ id, mime, bytes }`, answer `{ id, width, height, data }` or `{ id, error }`. */
export const DECODE_WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { id, mime, bytes } = event.data;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    self.postMessage({ id, width: image.width, height: image.height, data: image.data.buffer }, [image.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
`;

/** What the pool needs of a worker (the browser's Worker, or a stand-in). */
export interface DecodeWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: any }) => void) | null;
  terminate(): void;
}

/** A pool of decode workers: each image to the least busy one. */
export class DecodePool {
  private readonly pending = new Map<number, { resolve: (texture: DecodedTexture | null) => void; worker: number }>();
  private readonly busy: number[];
  private nextId = 1;

  constructor(private readonly workers: readonly DecodeWorker[]) {
    this.busy = workers.map(() => 0);
    workers.forEach((worker, w) => {
      worker.onmessage = (event) => {
        const { id, width, height, data, error } = event.data ?? {};
        const job = this.pending.get(id);
        if (!job) return;
        this.pending.delete(id);
        this.busy[w]! -= 1;
        job.resolve(error || !data ? null : { width, height, data: new Uint8ClampedArray(data) });
      };
    });
  }

  /** Images in flight. */
  get inFlight(): number {
    return this.pending.size;
  }

  /** Decode encoded image bytes to RGBA (null when the image can't be decoded). The bytes are copied, so the caller keeps its own. */
  decode(mime: string, bytes: Uint8Array): Promise<DecodedTexture | null> {
    const w = this.busy.indexOf(Math.min(...this.busy));
    const id = this.nextId++;
    this.busy[w]! += 1;
    const copy = bytes.slice();
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, worker: w });
      this.workers[w]!.postMessage({ id, mime, bytes: copy }, [copy.buffer]);
    });
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    for (const job of this.pending.values()) job.resolve(null);
    this.pending.clear();
  }
}

let shared: DecodePool | null | undefined;

/**
 * The page's shared decode pool (made on first use, half the cores up to
 * four), or null where workers can't decode images.
 */
export function decodePool(): DecodePool | null {
  if (shared !== undefined) return shared;
  const g = globalThis as any;
  if (typeof g.Worker !== "function" || typeof g.OffscreenCanvas !== "function" || typeof g.Blob !== "function" || typeof g.URL?.createObjectURL !== "function") return (shared = null);
  try {
    const url = g.URL.createObjectURL(new g.Blob([DECODE_WORKER_SOURCE], { type: "text/javascript" }));
    const count = Math.max(1, Math.min(4, Math.floor((g.navigator?.hardwareConcurrency ?? 2) / 2)));
    shared = new DecodePool(Array.from({ length: count }, () => new g.Worker(url) as DecodeWorker));
  } catch {
    shared = null;
  }
  return shared;
}
