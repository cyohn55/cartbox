/**
 * GPU time of the 3D scene pass on WebGL2, for the playtest profiler (see
 * debug/profiler.ts), through the optional `EXT_disjoint_timer_query_webgl2`;
 * without it the time stays null. Results land a frame or two late (the GPU
 * runs behind), so `lastMs` is the newest one read back. WebGPU times each
 * pass of its frame graph instead (GraphTimer, frameGraph.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
