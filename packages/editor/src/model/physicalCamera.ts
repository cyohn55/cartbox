/**
 * The physical camera (AAA_FIDELITY_ROADMAP.md F4c): aperture, shutter speed
 * and ISO, which set the exposure the way a camera's do and drive the AAA
 * tier's depth of field and motion blur.
 *
 * - **Exposure.** EV100 = log2(N² / t · 100 / S) for f-number N, shutter t
 *   seconds and ISO S; physicalLight.ts's calibration makes that exposure
 *   2^(15 − EV100). In "manual" mode it replaces the rig's exposure; in
 *   "auto" mode eye adaptation drives it, metered as the camera says, and the
 *   compensation shifts its key.
 * - **Depth of field.** The thin lens: a point at distance d, with the lens
 *   (focal length f) focused at s, blurs to a circle of confusion
 *   A·f·|d − s| / (d·(s − f)) across on the sensor, with A = f / N the
 *   aperture's diameter. Over the sensor's width, that is a share of the
 *   frame's. Signed: negative in front of the focus (the near field).
 * - **Motion blur.** The shutter is open for t of the 1/60 s a frame lasts: a
 *   share of each pixel's motion over the frame.
 *
 * Post volumes (P6) blend the aperture, the focus and the motion blur's
 * strength as they blend exposure (postVolumes.ts).
 *
 * Pure and DOM-free.
 */

import { ev100ToExposure } from "./physicalLight";

/** How the exposure is set. */
export type ExposureMode = "manual" | "auto";
/** What eye adaptation measures: the whole frame, its centre more, or a spot in the middle. */
export type MeteringMode = "average" | "centre" | "spot";

/** What a rig stores (every field optional; see {@link resolvePhysicalCamera}). */
export interface PhysicalCameraSettings {
  /** The f-number (1.2..22). */
  readonly aperture?: number;
  /** Seconds the shutter is open (1/8000..1). */
  readonly shutter?: number;
  /** The sensor's sensitivity (50..12800). */
  readonly iso?: number;
  readonly exposure?: ExposureMode;
  /** Stops added to the auto exposure's key (−4..4). */
  readonly compensation?: number;
  readonly metering?: MeteringMode;
  /** Bokeh depth of field on the AAA tier. */
  readonly depthOfField?: boolean;
  /** Metres to the plane in focus. */
  readonly focusDistance?: number;
  /** The lens's focal length, mm (8..400). */
  readonly focalLength?: number;
  /** The sensor's width, mm (full frame 36). */
  readonly sensorWidth?: number;
  /** The aperture's blades (5..9), which shape the bokeh; 0 for a round one. */
  readonly blades?: number;
  /** Per-object motion blur on the AAA tier. */
  readonly motionBlur?: boolean;
}

/** The settings with their defaults. */
export interface PhysicalCamera {
  readonly aperture: number;
  readonly shutter: number;
  readonly iso: number;
  readonly exposure: ExposureMode;
  readonly compensation: number;
  readonly metering: MeteringMode;
  readonly depthOfField: boolean;
  readonly focusDistance: number;
  readonly focalLength: number;
  readonly sensorWidth: number;
  readonly blades: number;
  readonly motionBlur: boolean;
}

/** "Sunny 16": f/16 at 1/125 s and ISO 100 is EV100 15, exposure 1. */
export const DEFAULT_PHYSICAL_CAMERA: PhysicalCamera = {
  aperture: 16,
  shutter: 1 / 125,
  iso: 100,
  exposure: "auto",
  compensation: 0,
  metering: "centre",
  depthOfField: false,
  focusDistance: 10,
  focalLength: 35,
  sensorWidth: 36,
  blades: 6,
  motionBlur: false,
};

/** The frame time the shutter is a share of (the players run at 60 Hz). */
export const FRAME_SECONDS = 1 / 60;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Settings as stored, read defensively (values clamped); null when absent. */
export function parsePhysicalCamera(value: unknown): PhysicalCameraSettings | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const out: { -readonly [K in keyof PhysicalCameraSettings]: PhysicalCameraSettings[K] } = {};
  if (finite(r.aperture)) out.aperture = clamp(r.aperture, 1.2, 22);
  if (finite(r.shutter)) out.shutter = clamp(r.shutter, 1 / 8000, 1);
  if (finite(r.iso)) out.iso = clamp(r.iso, 50, 12800);
  if (r.exposure === "manual" || r.exposure === "auto") out.exposure = r.exposure;
  if (finite(r.compensation)) out.compensation = clamp(r.compensation, -4, 4);
  if (r.metering === "average" || r.metering === "centre" || r.metering === "spot") out.metering = r.metering;
  if (typeof r.depthOfField === "boolean") out.depthOfField = r.depthOfField;
  if (finite(r.focusDistance)) out.focusDistance = clamp(r.focusDistance, 0.05, 10000);
  if (finite(r.focalLength)) out.focalLength = clamp(r.focalLength, 8, 400);
  if (finite(r.sensorWidth)) out.sensorWidth = clamp(r.sensorWidth, 4, 70);
  if (finite(r.blades)) out.blades = r.blades < 5 ? 0 : Math.round(clamp(r.blades, 5, 9));
  if (typeof r.motionBlur === "boolean") out.motionBlur = r.motionBlur;
  return out;
}

export function resolvePhysicalCamera(settings: PhysicalCameraSettings | null | undefined): PhysicalCamera {
  return { ...DEFAULT_PHYSICAL_CAMERA, ...(settings ?? {}) };
}

/** EV100 for an f-number, a shutter time (s) and an ISO. */
export function cameraEv100(aperture: number, shutter: number, iso: number): number {
  return Math.log2(((aperture * aperture) / shutter) * (100 / iso));
}

/** The exposure multiplier a camera's settings make (manual mode's), before any compensation. */
export function cameraExposure(camera: Pick<PhysicalCamera, "aperture" | "shutter" | "iso">): number {
  return ev100ToExposure(cameraEv100(camera.aperture, camera.shutter, camera.iso));
}

/**
 * The circle of confusion of a point `distance` metres away, as a share of the
 * frame's width: negative in front of the focus. 0 at the focus, and toward
 * A·f / (s − f) / sensor far beyond it.
 */
export function circleOfConfusion(camera: Pick<PhysicalCamera, "aperture" | "focusDistance" | "focalLength" | "sensorWidth">, distance: number): number {
  const f = camera.focalLength / 1000;
  const s = Math.max(camera.focusDistance, f * 1.001);
  const d = Math.max(distance, 1e-4);
  const a = f / camera.aperture;
  const coc = (a * f * (d - s)) / (d * (s - f));
  return coc / (camera.sensorWidth / 1000);
}

/**
 * The circle of confusion as the shader works it out per pixel: coc = scale ·
 * (1 − focus / distance), with `scale` = A·f / (s − f) / sensor (its limit far
 * beyond the focus).
 */
export function cocTerms(camera: Pick<PhysicalCamera, "aperture" | "focusDistance" | "focalLength" | "sensorWidth">): { scale: number; focus: number } {
  const f = camera.focalLength / 1000;
  const s = Math.max(camera.focusDistance, f * 1.001);
  return { scale: (f / camera.aperture) * f / (s - f) / (camera.sensorWidth / 1000), focus: s };
}

/** The share of a frame's motion the shutter blurs (its open time over the frame's). */
export function shutterFraction(shutter: number): number {
  return Math.min(1, shutter / FRAME_SECONDS);
}
