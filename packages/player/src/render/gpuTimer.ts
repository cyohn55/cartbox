/**
 * GPU time of the 3D scene pass, for the playtest profiler (see
 * debug/profiler.ts). Each backend has an optional browser feature for it —
 * WebGPU's `timestamp-query`, WebGL2's `EXT_disjoint_timer_query_webgl2` — and
 * without it the time stays null. Results land a frame or two late (the GPU
 * runs behind), so `lastMs` is the newest one read back.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Timestamps around a WebGPU render pass. */
export class WebgpuPassTimer {
  lastMs: number | null = null;
  private readonly querySet: any;
  private readonly resolveBuffer: any;
  private readonly readBuffer: any;
  private reading = false;
  private copied = false;

  private constructor(device: any) {
    this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolveBuffer = device.createBuffer({ size: 16, usage: 0x200 | 0x04 }); // QUERY_RESOLVE | COPY_SRC
    this.readBuffer = device.createBuffer({ size: 16, usage: 0x08 | 0x01 }); // COPY_DST | MAP_READ
  }

  /** A timer, when the device was created with `timestamp-query`. */
  static create(device: any): WebgpuPassTimer | null {
    try {
      return device?.features?.has?.("timestamp-query") ? new WebgpuPassTimer(device) : null;
    } catch {
      return null;
    }
  }

  /** The render pass descriptor's `timestampWrites`. */
  writes(): object {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /** After the pass ends: resolve its timestamps (and copy them out unless the last copy is still being read). */
  resolve(encoder: any): void {
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    if (this.reading) return;
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, 16);
    this.copied = true;
  }

  /** After submitting: read the copied timestamps back. */
  read(): void {
    if (!this.copied) return;
    this.copied = false;
    this.reading = true;
    this.readBuffer
      .mapAsync(0x01)
      .then(() => {
        const t = new BigUint64Array(this.readBuffer.getMappedRange().slice(0));
        this.readBuffer.unmap();
        const ns = Number(t[1]! - t[0]!);
        if (ns > 0 && ns < 1e10) this.lastMs = ns / 1e6;
      })
      .catch(() => {})
      .finally(() => {
        this.reading = false;
      });
  }

  destroy(): void {
    this.querySet?.destroy?.();
    this.resolveBuffer?.destroy?.();
    this.readBuffer?.destroy?.();
  }
}

/** A WebGL2 elapsed-time query around the scene's draws. */
export class WebglPassTimer {
  lastMs: number | null = null;
  private readonly pending: any[] = [];
  private readonly free: any[] = [];

  private constructor(
    private readonly gl: any,
    private readonly ext: any,
  ) {}

  static create(gl: any): WebglPassTimer | null {
    try {
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      return ext ? new WebglPassTimer(gl, ext) : null;
    } catch {
      return null;
    }
  }

  begin(): void {
    this.poll();
    if (this.pending.length >= 4) return; // results are backed up: skip timing this frame
    const query = this.free.pop() ?? this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.pending.push(query);
    this.active = true;
  }

  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }

  private active = false;

  /** Take finished results, oldest first. */
  private poll(): void {
    const gl = this.gl;
    // A disjoint event (clock change, GPU reset) spoils every result in flight.
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      if (!disjoint && ns > 0) this.lastMs = ns / 1e6;
      this.free.push(this.pending.shift());
    }
  }

  destroy(): void {
    for (const query of [...this.pending, ...this.free]) this.gl.deleteQuery(query);
  }
}
