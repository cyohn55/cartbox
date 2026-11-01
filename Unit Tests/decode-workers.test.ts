/**
 * Decoding off the main thread (AAA_FIDELITY_ROADMAP.md F0e): the image
 * decode pool's protocol and its worker script (against stand-in browser
 * globals), and the KTX2 worker decoder's, falling back to the main thread
 * when the worker fails.
 */

import { describe, expect, it } from "vitest";

import { DECODE_WORKER_SOURCE, DecodePool, type DecodeWorker } from "../packages/player/src/render/decodeWorkers";
import { ktx2Transfers, workerKtx2Decoder, type Ktx2WorkerLike } from "../apps/web/src/lib/ktx2Decoder";

/** A worker that runs `handle` on each message, answering a tick later. */
function fakeWorker(handle: (data: any) => { reply: any; transfer?: ArrayBuffer[] } | null): DecodeWorker & { posted: any[]; transferred: Transferable[][] } {
  const worker = {
    onmessage: null as ((event: { data: any }) => void) | null,
    posted: [] as any[],
    transferred: [] as Transferable[][],
    postMessage(message: any, transfer: Transferable[] = []) {
      worker.posted.push(message);
      worker.transferred.push(transfer);
      const answer = handle(message);
      if (answer) setTimeout(() => worker.onmessage?.({ data: answer.reply }), 0);
    },
    terminate() {},
  };
  return worker;
}

describe("the image decode pool", () => {
  it("sends each image to the least busy worker, transferring a copy of its bytes, and answers in RGBA", async () => {
    const replies = (data: any) => ({ reply: { id: data.id, width: 2, height: 1, data: new Uint8ClampedArray([data.bytes[0], 0, 0, 255, 0, 0, 0, 255]).buffer } });
    const workers = [fakeWorker(replies), fakeWorker(replies)];
    const pool = new DecodePool(workers);
    const bytes = Uint8Array.from([7, 8, 9]);
    const [a, b] = await Promise.all([pool.decode("image/png", bytes), pool.decode("image/png", Uint8Array.from([5]))]);
    expect(workers[0]!.posted).toHaveLength(1);
    expect(workers[1]!.posted).toHaveLength(1);
    // The caller's bytes stay its own: the pool transferred a copy.
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
    expect(workers[0]!.transferred[0]![0]).not.toBe(bytes.buffer);
    expect(a).toMatchObject({ width: 2, height: 1 });
    expect(a!.data[0]).toBe(7);
    expect(b!.data[0]).toBe(5);
    expect(pool.inFlight).toBe(0);
  });

  it("answers null for an image the worker couldn't decode", async () => {
    const pool = new DecodePool([fakeWorker((data) => ({ reply: { id: data.id, error: "bad image" } }))]);
    expect(await pool.decode("image/png", Uint8Array.from([1]))).toBeNull();
  });

  it("runs its worker script: decode through an offscreen canvas, transfer the pixels back", async () => {
    const posted: { message: any; transfer: any[] }[] = [];
    const self: any = { postMessage: (message: any, transfer: any[] = []) => posted.push({ message, transfer }) };
    const pixels = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const createImageBitmap = async (blob: Blob) => ({ width: 2, height: 1, type: blob.type, close() {} });
    class OffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: pixels }) };
      }
    }
    new Function("self", "createImageBitmap", "OffscreenCanvas", "Blob", DECODE_WORKER_SOURCE)(self, createImageBitmap, OffscreenCanvas, Blob);
    await self.onmessage({ data: { id: 3, mime: "image/png", bytes: new Uint8Array([0]) } });
    expect(posted[0]!.message).toMatchObject({ id: 3, width: 2, height: 1 });
    expect(posted[0]!.transfer[0]).toBe(pixels.buffer);
    // A failing decode answers with the error, not silence.
    await self.onmessage({ data: { id: 4, mime: "image/png", bytes: new Uint8Array([0]) } });
    const failing = async () => {
      throw new Error("corrupt");
    };
    new Function("self", "createImageBitmap", "OffscreenCanvas", "Blob", DECODE_WORKER_SOURCE)(self, failing, OffscreenCanvas, Blob);
    await self.onmessage({ data: { id: 5, mime: "image/png", bytes: new Uint8Array([0]) } });
    expect(posted.at(-1)!.message).toMatchObject({ id: 5 });
    expect(posted.at(-1)!.message.error).toContain("corrupt");
  });
});

describe("the KTX2 worker decoder", () => {
  const texture = { width: 1, height: 1, data: new Uint8ClampedArray([9, 9, 9, 255]) };
  const mainThread = async () => () => ({ ...texture, data: new Uint8ClampedArray([1, 1, 1, 255]) });

  function ktx2Worker(answer: (data: any) => any): Ktx2WorkerLike & { posted: any[] } {
    const worker = {
      onmessage: null as ((event: { data: any }) => void) | null,
      onerror: null as ((event: unknown) => void) | null,
      posted: [] as any[],
      postMessage(message: any) {
        worker.posted.push(message);
        const reply = answer(message);
        if (reply) setTimeout(() => worker.onmessage?.({ data: reply }), 0);
      },
    };
    return worker;
  }

  it("transcodes on the worker, with the formats asked for", async () => {
    const worker = ktx2Worker((data) => ({ id: data.id, texture }));
    const decode = workerKtx2Decoder(worker, mainThread);
    const out = await decode(Uint8Array.from([1]), { gpuFormats: ["bc7-rgba-unorm"] });
    expect(out!.data[0]).toBe(9);
    expect(worker.posted[0].options.gpuFormats).toEqual(["bc7-rgba-unorm"]);
  });

  it("falls back to the main thread for a file the worker failed, and for everything once the worker breaks", async () => {
    const worker = ktx2Worker((data) => (data.id === 1 ? { id: 1, texture: null, error: "no transcoder" } : null));
    const decode = workerKtx2Decoder(worker, mainThread);
    expect((await decode(Uint8Array.from([1])))!.data[0]).toBe(1);
    const waiting = decode(Uint8Array.from([2]));
    worker.onerror!(new Error("worker died"));
    expect((await waiting)!.data[0]).toBe(1);
    expect((await decode(Uint8Array.from([3])))!.data[0]).toBe(1);
    expect(worker.posted).toHaveLength(2);
  });

  it("hands over a texture's pixels and its compressed levels rather than copying them", () => {
    const level = { width: 4, height: 4, data: new Uint8Array(16) };
    const buffers = ktx2Transfers({ ...texture, gpu: { format: "bc7-rgba-unorm", levels: [level, level] } } as any);
    expect(buffers).toEqual([texture.data.buffer, level.data.buffer]);
  });
});
