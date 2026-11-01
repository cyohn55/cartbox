/**
 * Encoding an offline render to video in the browser (AAA_FIDELITY_ROADMAP.md
 * F10d): each finished frame (sRGB RGBA bytes) goes to WebCodecs'
 * VideoEncoder — VP9 where the browser has it, else VP8 — with a key frame
 * every two seconds, and the chunks are muxed into a WebM (webmMuxer.ts).
 */

import { muxWebm, type WebmFrame, type WebmTrack } from "./webmMuxer";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebCodecs isn't in every TS lib the app builds with */

const CODECS: readonly { readonly config: string; readonly track: WebmTrack["codec"] }[] = [
  { config: "vp09.00.10.08", track: "V_VP9" },
  { config: "vp8", track: "V_VP8" },
];

/** Whether this browser can encode video (WebCodecs). */
export function canEncodeVideo(): boolean {
  return typeof (globalThis as any).VideoEncoder === "function" && typeof (globalThis as any).VideoFrame === "function";
}

/** Frames in, a WebM out. */
export class WebmRecorder {
  private readonly chunks: WebmFrame[] = [];
  private failure: Error | null = null;
  private count = 0;

  private constructor(
    private readonly encoder: any,
    private readonly track: WebmTrack["codec"],
    readonly width: number,
    readonly height: number,
    readonly fps: number,
  ) {}

  /** A recorder at `width × height` and `fps`, on the first codec the browser supports. */
  static async create(width: number, height: number, fps: number, bitrate = 12_000_000): Promise<WebmRecorder> {
    if (!canEncodeVideo()) throw new Error("This browser can't encode video.");
    const VideoEncoder = (globalThis as any).VideoEncoder;
    // VP8 and VP9 take even sizes.
    const w = width & ~1;
    const h = height & ~1;
    for (const codec of CODECS) {
      const config = { codec: codec.config, width: w, height: h, bitrate, framerate: fps };
      const support = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (!support.supported) continue;
      let recorder: WebmRecorder | null = null;
      const encoder = new VideoEncoder({
        output: (chunk: any) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          recorder!.chunks.push({ data, timestamp: chunk.timestamp / 1000, key: chunk.type === "key" });
        },
        error: (error: Error) => {
          recorder!.failure = error;
        },
      });
      encoder.configure(config);
      recorder = new WebmRecorder(encoder, codec.track, w, h, fps);
      return recorder;
    }
    throw new Error("This browser can't encode VP9 or VP8.");
  }

  /** Add the next frame: RGBA bytes at the size the recorder was made for (or one wider or taller, trimmed). */
  add(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
    if (this.failure) throw this.failure;
    let pixels = rgba;
    if (width !== this.width || height !== this.height) {
      pixels = new Uint8ClampedArray(this.width * this.height * 4);
      for (let y = 0; y < this.height; y += 1) pixels.set(rgba.subarray(y * width * 4, y * width * 4 + this.width * 4), y * this.width * 4);
    }
    const VideoFrame = (globalThis as any).VideoFrame;
    const frame = new VideoFrame(pixels, { format: "RGBA", codedWidth: this.width, codedHeight: this.height, timestamp: Math.round((this.count * 1_000_000) / this.fps), duration: Math.round(1_000_000 / this.fps) });
    this.encoder.encode(frame, { keyFrame: this.count % Math.max(1, Math.round(this.fps * 2)) === 0 });
    frame.close();
    this.count += 1;
  }

  /** Flush the encoder and mux what it made. */
  async finish(): Promise<Blob> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.failure) throw this.failure;
    const frames = [...this.chunks].sort((a, b) => a.timestamp - b.timestamp);
    const bytes = muxWebm({ width: this.width, height: this.height, codec: this.track, duration: (this.count * 1000) / this.fps }, frames);
    return new Blob([bytes.buffer as ArrayBuffer], { type: "video/webm" });
  }
}
