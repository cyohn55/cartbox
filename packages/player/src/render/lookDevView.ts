/**
 * The look-dev stage on a canvas (AAA_FIDELITY_ROADMAP.md F10c): the stage
 * (lookDev.ts) drawn by the linear-light renderer, or by the path-traced
 * reference (F10b), and presented through the AAA tier's presenter with the
 * rig's exposure and a tone map, so an asset is seen as the game would show it.
 * The turntable turns while the raster is shown; the reference holds still to
 * converge.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MeshAsset } from "@cartbox/editor";

import { getWebgpuDevice } from "../lighting/webgpuDevice.js";
import { GpuPresenter } from "./gpuPresent.js";
import { lookDevStage, type LookDevMaps, type LookDevOptions, type LookDevStage } from "./lookDev.js";
import { checkLookDev, lookDevDraw, type LookDevCheck } from "./lookDevCheck.js";
import { captureReference, type ReferenceCapture } from "./pathTracer.js";
import type { ToneMapper } from "./toneMappers.js";
import { MODELS } from "../models.js";
import { rasterStyleFor } from "./renderCaps.js";
import { WebgpuSceneRenderer } from "./WebgpuSceneRenderer.js";

export interface LookDevViewOptions extends LookDevOptions {
  /** The raster (as the game draws it) or the path-traced reference. */
  readonly mode?: "raster" | "pathTraced";
  /** Stops over or under the rig's exposure. */
  readonly stops?: number;
  /** The turntable's speed, radians a second (0 holds it). */
  readonly spin?: number;
  readonly toneMapper?: ToneMapper;
}

export class LookDevView {
  private options: LookDevViewOptions = { rig: "studio", mode: "raster", spin: 0.4 };
  private asset: MeshAsset | null = null;
  private maps: LookDevMaps = {};
  private stage: LookDevStage | null = null;
  private angle = 0;
  private last = 0;
  private raf = 0;
  private destroyed = false;
  private size: { width: number; height: number };

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: any,
    private readonly context: any,
    private readonly format: string,
    private readonly renderer: WebgpuSceneRenderer,
    private readonly presenter: GpuPresenter,
  ) {
    this.size = { width: canvas.width, height: canvas.height };
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** A view on `canvas`, or null without WebGPU (the stage needs the AAA tier's renderer). */
  static async create(canvas: HTMLCanvasElement): Promise<LookDevView | null> {
    const device = await getWebgpuDevice();
    const gpu = (navigator as any).gpu;
    const context = device ? (canvas.getContext("webgpu") as any) : null;
    if (!device || !gpu || !context) return null;
    const format: string = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    context.configure({ device, format, alphaMode: "opaque" });
    const width = Math.max(1, canvas.width);
    const height = Math.max(1, canvas.height);
    const renderer = await WebgpuSceneRenderer.create(device, width, height, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true });
    if (!renderer) return null;
    return new LookDevView(canvas, device, context, format, renderer, new GpuPresenter(device, width, height, { hdr: true }));
  }

  /** The asset on the stage, with its decoded maps per primitive (or none: the props alone). */
  setAsset(asset: MeshAsset | null, maps: LookDevMaps = {}): void {
    this.asset = asset;
    this.maps = maps;
    this.stage = null;
  }

  setOptions(options: Partial<LookDevViewOptions>): void {
    this.options = { ...this.options, ...options };
    this.stage = null;
  }

  /** The turntable's angle, radians. */
  get turntable(): number {
    return this.angle;
  }

  /** Samples each pixel of the reference holds (0 while the raster is shown). */
  get samples(): number {
    return this.options.mode === "pathTraced" ? this.renderer.referenceSamples : 0;
  }

  private stageNow(): LookDevStage {
    const { width, height } = this.size;
    this.stage ??= lookDevStage(this.asset, { ...this.options, turntable: this.options.turntable ?? this.angle }, width / Math.max(1, height), this.maps);
    return this.stage;
  }

  private frame(time: number): void {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = this.last ? Math.min(0.1, (time - this.last) / 1000) : 0;
    this.last = time;
    const tracing = this.options.mode === "pathTraced";
    // The turntable turns the raster; the reference holds still to converge.
    if (!tracing && this.options.turntable === undefined && (this.options.spin ?? 0) !== 0) {
      this.angle = (this.angle + dt * (this.options.spin ?? 0)) % (2 * Math.PI);
      this.stage = null;
    }
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    if (width !== this.size.width || height !== this.size.height) {
      this.size = { width, height };
      this.renderer.resize(width, height);
      this.presenter.resize(width, height);
      this.stage = null;
    }
    const stage = this.stageNow();
    const draw = { ...lookDevDraw(stage, width, height), ...(tracing ? { viewMode: "pathTraced" as const } : { temporal: true }) };
    const scene = this.renderer.renderToTexture(stage.instances, draw);
    const exposure = stage.exposure * 2 ** (this.options.stops ?? 0);
    this.presenter.present({ base: { kind: "colour", rgba: [12, 12, 14, 255] }, scene, tonemap: { exposure, operator: this.options.toneMapper ?? "aces" } }, this.context.getCurrentTexture(), this.format);
  }

  /** Draw the stage as it stands both ways at a small size and compare them (lookDevCheck.ts). */
  check(width = 192, height = 108, samples = 128): Promise<LookDevCheck> {
    const stage = lookDevStage(this.asset, { ...this.options, turntable: this.options.turntable ?? this.angle }, width / height, this.maps);
    return checkLookDev(this.device, stage, width, height, samples);
  }

  /** The reference of the stage as it stands, `width` across at the canvas's aspect (up to 8K). */
  capture(width: number, samples = 256, progress?: (done: number) => void): Promise<ReferenceCapture> {
    const height = Math.max(1, Math.round((width * this.size.height) / Math.max(1, this.size.width)));
    const stage = lookDevStage(this.asset, { ...this.options, turntable: this.options.turntable ?? this.angle }, width / height, this.maps);
    const exposure = stage.exposure * 2 ** (this.options.stops ?? 0);
    return captureReference(this.device, stage.instances, lookDevDraw(stage, width, height), { width, height, samples, exposure, ...(this.options.toneMapper ? { toneMapper: this.options.toneMapper } : {}), ...(progress ? { progress } : {}) });
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.presenter.dispose();
    this.context.unconfigure?.();
  }
}
