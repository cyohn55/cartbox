/**
 * Swing trails (HALO_INFINITE_STYLE_ROADMAP.md I10): a ribbon of light swept
 * by a segment of a mesh — a sword's blade from hilt to tip, a grenade's core
 * — over the last fraction of a second, fading with age and brightest at the
 * segment's far end. It appears only while the segment moves fast enough, so
 * a blade swung leaves an arc of light and a blade held still leaves nothing.
 *
 * A mesh declares its trails ({@link MeshTrail}); the runtime records where
 * each segment is every frame (riding its joint on a skinned mesh) and draws
 * the ribbons as one more additive, glowing instance — the same path
 * particles take, so every renderer draws them alike.
 *
 * Pure and DOM-free.
 */

import type { DecodedTexture, Mat4, MeshSceneInstance } from "./meshRasterizer";
import type { MeshAsset, MeshMaterial, MeshPrimitive } from "../model/MeshAsset";

type V3 = [number, number, number];

/** One trail a mesh leaves. */
export interface MeshTrail {
  /** The segment's ends in the mesh's own (bind) space: the ribbon is what it sweeps. */
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** The joint the segment rides on a skinned mesh; absent = the mesh as placed. */
  readonly joint?: number;
  /** Seconds a swept stretch lasts before it has faded out. */
  readonly life: number;
  /** The light's colour (0..1) and its strength (an emissive multiplier). */
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  /** World units per second the `to` end must move to leave a trail at all; twice that for a full one. */
  readonly minSpeed: number;
}

export const MAX_MESH_TRAILS = 4;
/** The most stretches a trail keeps (enough for a quarter second at 60 fps, and more). */
export const TRAIL_SAMPLES = 24;
const MAX_TRAIL_LIFE = 2;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A mesh's stored trails, validated (malformed ones dropped; at most {@link MAX_MESH_TRAILS}). */
export function readMeshTrails(value: unknown, jointCount = 0): MeshTrail[] {
  if (!Array.isArray(value)) return [];
  const out: MeshTrail[] = [];
  for (const raw of value.slice(0, MAX_MESH_TRAILS)) {
    const t = (raw ?? {}) as Record<string, unknown>;
    if (!triple(t.from) || !triple(t.to) || !finite(t.life) || t.life <= 0) continue;
    const joint = finite(t.joint) && Number.isInteger(t.joint) && t.joint >= 0 && t.joint < jointCount ? t.joint : undefined;
    out.push({
      from: [t.from[0], t.from[1], t.from[2]],
      to: [t.to[0], t.to[1], t.to[2]],
      ...(joint !== undefined ? { joint } : {}),
      life: Math.min(MAX_TRAIL_LIFE, t.life),
      color: triple(t.color) ? [clamp(t.color[0], 0, 1), clamp(t.color[1], 0, 1), clamp(t.color[2], 0, 1)] : [1, 1, 1],
      intensity: finite(t.intensity) ? clamp(t.intensity, 0, 16) : 1,
      minSpeed: finite(t.minSpeed) ? Math.max(0, t.minSpeed) : 0,
    });
  }
  return out;
}

/** Where a point in a mesh's bind space lands: by the joint's skinning matrix (if any), then the placement. */
function place(p: readonly number[], model: Mat4, skin: Float32Array | null, joint: number | undefined): V3 {
  let x = p[0]!, y = p[1]!, z = p[2]!;
  if (skin && joint !== undefined && (joint + 1) * 16 <= skin.length) {
    const m = joint * 16;
    [x, y, z] = [
      skin[m]! * x + skin[m + 4]! * y + skin[m + 8]! * z + skin[m + 12]!,
      skin[m + 1]! * x + skin[m + 5]! * y + skin[m + 9]! * z + skin[m + 13]!,
      skin[m + 2]! * x + skin[m + 6]! * y + skin[m + 10]! * z + skin[m + 14]!,
    ];
  }
  return [
    model[0]! * x + model[4]! * y + model[8]! * z + model[12]!,
    model[1]! * x + model[5]! * y + model[9]! * z + model[13]!,
    model[2]! * x + model[6]! * y + model[10]! * z + model[14]!,
  ];
}

/** `m` applied to a point (an affine matrix, column-major). */
function apply(m: Mat4, p: readonly number[]): V3 {
  return [
    m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
    m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
    m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
  ];
}

/** A view matrix's inverse (it is rigid: the transposed rotation, the eye as translation). */
function invertView(v: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out[c * 4 + r] = v[r * 4 + c]!;
  out[12] = -(v[0]! * v[12]! + v[1]! * v[13]! + v[2]! * v[14]!);
  out[13] = -(v[4]! * v[12]! + v[5]! * v[13]! + v[6]! * v[14]!);
  out[14] = -(v[8]! * v[12]! + v[9]! * v[13]! + v[10]! * v[14]!);
  out[15] = 1;
  return out;
}

/** How bright a trail is for its `to` end moving at `speed`: none below the threshold, full at twice it. */
export function trailStrength(speed: number, minSpeed: number): number {
  if (minSpeed <= 0) return 1;
  return clamp((speed - minSpeed) / minSpeed, 0, 1);
}

/** The ribbon's light across its length (u: 0 new → 1 old) and width (v: 0 at `from` → 1 at `to`). */
export function trailFade(u: number, v: number): number {
  return (1 - u) * (1 - u) * (0.25 + 0.75 * v);
}

const FADE_W = 32;
const FADE_H = 8;
let fadeTexture: DecodedTexture | null = null;
/** {@link trailFade} as a small greyscale texture the glow reads. */
function fade(): DecodedTexture {
  if (fadeTexture) return fadeTexture;
  const data = new Uint8ClampedArray(FADE_W * FADE_H * 4);
  for (let y = 0; y < FADE_H; y += 1) {
    for (let x = 0; x < FADE_W; x += 1) {
      const g = Math.round(trailFade(x / (FADE_W - 1), y / (FADE_H - 1)) * 255);
      data.set([g, g, g, 255], (y * FADE_W + x) * 4);
    }
  }
  fadeTexture = { width: FADE_W, height: FADE_H, data };
  return fadeTexture;
}

interface Sample {
  readonly a: V3;
  readonly b: V3;
  readonly t: number;
}

interface Track {
  readonly trail: MeshTrail;
  readonly front: boolean;
  samples: Sample[];
  /** The `to` end last frame and when (for speed). */
  last: { at: V3; t: number } | null;
}

/**
 * The trails in a scene: fed each frame where every trailing object is, it
 * keeps each segment's recent sweep and builds the ribbons to draw.
 */
export class TrailSystem {
  private readonly tracks = new Map<string, Track>();
  private readonly primitives = new Map<string, MeshPrimitive>();
  private readonly identity: Mat4 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /**
   * Record where an object's trails are at `time` (seconds): `model` its
   * placement, `skin` its skinning matrices (or null), `front` whether it
   * draws on the front layer. A front-layer object (a held weapon) moves with
   * the camera, so its trails are kept in the camera's space (`view`): turning
   * or running sweeps nothing, only the swing does. A hidden object is
   * {@link cut} instead.
   */
  record(key: number, trails: readonly MeshTrail[], model: Mat4, skin: Float32Array | null, time: number, front: boolean, view: Mat4 | null = null): void {
    trails.forEach((trail, k) => {
      const id = `${key}:${k}`;
      let track = this.tracks.get(id);
      if (!track || track.front !== front) {
        track = { trail, front, samples: [], last: null };
        this.tracks.set(id, track);
      }
      let a = place(trail.from, model, skin, trail.joint);
      let b = place(trail.to, model, skin, trail.joint);
      if (front && view) [a, b] = [apply(view, a), apply(view, b)];
      const dt = track.last ? time - track.last.t : 0;
      const speed = track.last && dt > 0 ? Math.hypot(b[0] - track.last.at[0], b[1] - track.last.at[1], b[2] - track.last.at[2]) / dt : 0;
      track.last = { at: b, t: time };
      // Slow, the stretch shrinks to its `from` end: no light where nothing swept.
      const s = trailStrength(speed, trail.minSpeed);
      track.samples.push({ a, b: [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s], t: time });
      track.samples = track.samples.filter((p) => time - p.t <= trail.life).slice(-TRAIL_SAMPLES);
    });
  }

  /** An object went out of sight: its trails stop where they are (and fade out). */
  cut(key: number): void {
    for (const [id, track] of this.tracks) if (id.startsWith(`${key}:`)) track.last = null;
  }

  /**
   * The ribbons at `time` as instances to draw — one for the scene and one
   * for the front layer (brought back from the camera's space by `view`, this
   * frame's) — or null where there are none.
   */
  instances(time: number, view: Mat4 | null = null): { main: MeshSceneInstance | null; front: MeshSceneInstance | null } {
    const out = { main: [] as MeshPrimitive[], front: [] as MeshPrimitive[] };
    for (const [id, track] of this.tracks) {
      track.samples = track.samples.filter((p) => time - p.t <= track.trail.life);
      const lit = track.samples.some((p) => p.a[0] !== p.b[0] || p.a[1] !== p.b[1] || p.a[2] !== p.b[2]);
      if (track.samples.length < 2 || !lit) continue;
      (track.front ? out.front : out.main).push(this.ribbon(id, track, time));
    }
    const instance = (primitives: MeshPrimitive[], model: Mat4): MeshSceneInstance | null => {
      if (primitives.length === 0) return null;
      const mesh: MeshAsset = { name: "trails", primitives };
      return { mesh, model, textures: primitives.map(() => null), emissiveTextures: primitives.map(() => fade()) };
    };
    return { main: instance(out.main, this.identity), front: instance(out.front, view ? invertView(view) : this.identity) };
  }

  /**
   * A track's ribbon: a strip of quads between its stretches, both ways round
   * so it shows from either side. Its buffers are made once at full length
   * and rewritten each frame (unused corners folded onto the newest stretch),
   * so a GPU renderer updates them in place.
   */
  private ribbon(id: string, track: Track, time: number): MeshPrimitive {
    let primitive = this.primitives.get(id);
    if (!primitive) {
      const cap = TRAIL_SAMPLES;
      const indices = new Uint32Array((cap - 1) * 12);
      for (let i = 0; i < cap - 1; i += 1) {
        const [a0, b0, a1, b1] = [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3];
        indices.set([a0, a1, b1, a0, b1, b0, a0, b1, a1, a0, b0, b1], i * 12);
      }
      const { color, intensity } = track.trail;
      const material: MeshMaterial = {
        name: `trail:${id}`,
        // Black and glowing, added over what's behind (like a glowing particle).
        baseColorFactor: [0, 0, 0, 1],
        baseColorImage: null,
        metallicFactor: 0,
        roughnessFactor: 1,
        emissiveFactor: [color[0] * intensity, color[1] * intensity, color[2] * intensity],
        alphaMode: "additive",
      };
      // The glow is unlit: any normal will do.
      const normals = new Float32Array(cap * 6);
      for (let i = 0; i < cap * 2; i += 1) normals[i * 3 + 1] = 1;
      primitive = { positions: new Float32Array(cap * 6), normals, uvs: new Float32Array(cap * 4), indices, material, dynamic: { revision: 0 } };
      this.primitives.set(id, primitive);
    }
    const positions = primitive.positions;
    const uvs = primitive.uvs!;
    const samples = track.samples;
    const newest = samples[samples.length - 1]!;
    for (let i = 0; i < TRAIL_SAMPLES; i += 1) {
      const p = samples[i] ?? newest;
      positions.set(p.a, i * 6);
      positions.set(p.b, i * 6 + 3);
      const u = Math.min(1, (time - p.t) / track.trail.life);
      uvs.set([u, 0, u, 1], i * 4);
    }
    primitive.dynamic!.revision += 1;
    return primitive;
  }
}
