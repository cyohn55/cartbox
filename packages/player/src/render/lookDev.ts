/**
 * The look-dev stage (AAA_FIDELITY_ROADMAP.md F10c): a neutral scene where an
 * asset is checked under standard lighting before it ships.
 *
 * - **The asset** stands on the stage's origin at its own scale, its feet on
 *   the floor, and turns on a turntable; the stage's props are sized to it.
 * - **A calibrated grey ball** (18% reflectance, fully rough: a grey card
 *   made round) and **a chrome ball** (a mirror metal), the pair a VFX plate
 *   is shot with: the grey shows the light's level and direction, the chrome
 *   what the surroundings reflect.
 * - **A colour checker**: the 24 patches of the ColorChecker Classic in sRGB,
 *   on a black card, so a rig's colour and exposure read against known
 *   reflectances.
 * - **A neutral floor** (18% grey) to catch the asset's shadow and bounce.
 * - **Light rigs**, each a standard look in the renderer's units: a studio
 *   with a key, a fill and a rim (area lights, F2e-2) under a dim cyclorama;
 *   noon sun and sky; overcast; golden hour; moonlit night; and the cart's own
 *   HDRI, which the turntable turns about the asset (the panorama's columns
 *   shifted, so the asset and camera stay still). A rig suggests the exposure
 *   that puts the grey ball at middle grey.
 *
 * Pure: it builds instances, lights and an environment a renderer draws, the
 * linear-light one or the path-traced reference (F10b) alike.
 */

import { composeModelMatrix, multiplyMat4, projectionMatrix, viewMatrix, type EnvironmentLight, type Mat4, type MeshAsset, type MeshMaterial, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";

/** The grey card's reflectance, in linear light: middle grey. */
export const GREY_CARD = 0.18;

/** Linear light into the authored (sRGB) value the renderer decodes back to it. */
export function authoredFromLinear(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * The ColorChecker Classic's 24 patches, row by row from dark skin to black, as
 * sRGB bytes (X-Rite's published values for the post-2014 chart).
 */
export const COLOR_CHECKER: readonly { readonly name: string; readonly srgb: readonly [number, number, number] }[] = [
  { name: "dark skin", srgb: [115, 82, 68] },
  { name: "light skin", srgb: [194, 150, 130] },
  { name: "blue sky", srgb: [98, 122, 157] },
  { name: "foliage", srgb: [87, 108, 67] },
  { name: "blue flower", srgb: [133, 128, 177] },
  { name: "bluish green", srgb: [103, 189, 170] },
  { name: "orange", srgb: [214, 126, 44] },
  { name: "purplish blue", srgb: [80, 91, 166] },
  { name: "moderate red", srgb: [193, 90, 99] },
  { name: "purple", srgb: [94, 60, 108] },
  { name: "yellow green", srgb: [157, 188, 64] },
  { name: "orange yellow", srgb: [224, 163, 46] },
  { name: "blue", srgb: [56, 61, 150] },
  { name: "green", srgb: [70, 148, 73] },
  { name: "red", srgb: [175, 54, 60] },
  { name: "yellow", srgb: [231, 199, 31] },
  { name: "magenta", srgb: [187, 86, 149] },
  { name: "cyan", srgb: [8, 133, 161] },
  { name: "white 9.5", srgb: [243, 243, 242] },
  { name: "neutral 8", srgb: [200, 200, 200] },
  { name: "neutral 6.5", srgb: [160, 160, 160] },
  { name: "neutral 5", srgb: [122, 122, 121] },
  { name: "neutral 3.5", srgb: [85, 85, 85] },
  { name: "black 2", srgb: [52, 52, 52] },
];

export type LookDevRig = "studio" | "noon" | "overcast" | "goldenHour" | "night" | "hdri";

/** The rigs, in menu order, with what each is for. */
export const LOOK_DEV_RIGS: readonly { readonly id: LookDevRig; readonly label: string; readonly hint: string }[] = [
  { id: "studio", label: "Studio", hint: "A key, a fill and a rim (area lights) under a dim cyclorama: form and highlights." },
  { id: "noon", label: "Noon", hint: "A high sun under a blue sky: hard shadows and saturated colour." },
  { id: "overcast", label: "Overcast", hint: "A soft white sky and no sun: albedo and occlusion, with no direct light to hide behind." },
  { id: "goldenHour", label: "Golden hour", hint: "A low, warm sun under a cooling sky: grazing light and long shadows." },
  { id: "night", label: "Night", hint: "A cold moon over a dark sky: how the asset holds in the dark, and its emission." },
  { id: "hdri", label: "HDRI", hint: "The cart's own environment, turned about the asset by the turntable." },
];

export interface LookDevOptions {
  readonly rig: LookDevRig;
  /** The turntable's angle in radians: the asset turns, or with the HDRI rig the light turns about it. */
  readonly turntable?: number;
  /** The HDRI rig's environment (the cart's sky); without one it falls back to the studio. */
  readonly environment?: EnvironmentLight | null;
  /** Which props stand on the stage (all by default). */
  readonly balls?: boolean;
  readonly chart?: boolean;
  readonly floor?: boolean;
  /** The camera's height above the asset's middle, as an angle (radians, default 0.25), and its vertical field of view (default π / 4). */
  readonly elevation?: number;
  readonly fov?: number;
}

/** An asset's decoded maps per primitive, as an instance carries them. */
export type LookDevMaps = Partial<Pick<MeshSceneInstance, "textures" | "mrTextures" | "emissiveTextures" | "normalTextures" | "occlusionTextures">>;

/** A stage ready to draw: what stands on it, how it is lit and seen, and where its props are. */
export interface LookDevStage {
  readonly instances: MeshSceneInstance[];
  readonly lights: SceneLight[];
  readonly environment: EnvironmentLight | null;
  /** The flat ambient for a frame without an environment (0: the environment lights it). */
  readonly ambient: number;
  readonly view: Mat4;
  readonly projection: Mat4;
  /** The exposure that puts a level grey card, lit by the rig, at middle grey (about; each rig's estimate of its light). */
  readonly exposure: number;
  /** The props' centres and radii, so a check can find them on screen (absent props are null). */
  readonly greyBall: { readonly centre: readonly [number, number, number]; readonly radius: number } | null;
  readonly chromeBall: { readonly centre: readonly [number, number, number]; readonly radius: number } | null;
  readonly chart: { readonly centre: readonly [number, number, number]; readonly patch: number } | null;
}

function material(name: string, linear: readonly [number, number, number], metallic: number, roughness: number): MeshMaterial {
  return { name, baseColorFactor: [authoredFromLinear(linear[0]), authoredFromLinear(linear[1]), authoredFromLinear(linear[2]), 1], baseColorImage: null, metallicFactor: metallic, roughnessFactor: roughness };
}

/** A UV sphere of radius 1 about the origin. */
export function lookDevSphere(name: string, mat: MeshMaterial, rings = 24, segments = 48): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const theta = (Math.PI * r) / rings;
    for (let s = 0; s <= segments; s += 1) {
      const phi = (2 * Math.PI * s) / segments;
      const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      positions.push(...n);
      normals.push(...n);
      uvs.push(s / segments, 1 - r / rings);
    }
  }
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { name, primitives: [{ positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), material: mat }] } as unknown as MeshAsset;
}

/** A quad of `w × h` facing +z (or, `up`, +y), centred on `centre`. */
function quadPrimitive(mat: MeshMaterial, centre: readonly [number, number, number], w: number, h: number, up = false) {
  const [x, y, z] = centre;
  const positions = up
    ? [x - w / 2, y, z + h / 2, x + w / 2, y, z + h / 2, x + w / 2, y, z - h / 2, x - w / 2, y, z - h / 2]
    : [x - w / 2, y - h / 2, z, x + w / 2, y - h / 2, z, x + w / 2, y + h / 2, z, x - w / 2, y + h / 2, z];
  const n = up ? [0, 1, 0] : [0, 0, 1];
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array([...n, ...n, ...n, ...n]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    material: mat,
  };
}

/**
 * The colour checker: 6 × 4 patches `patch` across with a gap of a sixth
 * between, on a black card, facing +z, centred on the origin.
 */
export function lookDevChart(patch: number): MeshAsset {
  const gap = patch / 6;
  const pitch = patch + gap;
  const width = 6 * pitch + gap;
  const height = 4 * pitch + gap;
  const primitives = [quadPrimitive(material("chart card", [0.02, 0.02, 0.02], 0, 0.9), [0, 0, -0.001], width, height)];
  COLOR_CHECKER.forEach((p, i) => {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const centre: [number, number, number] = [-width / 2 + gap + pitch * col + patch / 2, height / 2 - gap - pitch * row - patch / 2, 0];
    const m: MeshMaterial = { name: p.name, baseColorFactor: [p.srgb[0] / 255, p.srgb[1] / 255, p.srgb[2] / 255, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.9 };
    primitives.push(quadPrimitive(m, centre, patch, patch));
  });
  return { name: "colour checker", primitives } as unknown as MeshAsset;
}

/** An asset's bounds over all its primitives (a unit box when it has none). */
export function meshBounds(mesh: MeshAsset | null): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh?.primitives ?? []) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let a = 0; a < 3; a += 1) {
        min[a] = Math.min(min[a]!, p.positions[i + a]!);
        max[a] = Math.max(max[a]!, p.positions[i + a]!);
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  return { min, max };
}

/** Turn a direction about the vertical by `angle` (radians, counter-clockwise from above). */
function turn(v: readonly [number, number, number], angle: number): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/**
 * An environment turned about the vertical by `angle` (radians): its panorama's
 * columns shifted (u runs around from −x, as the IBL reads it). A gradient sky
 * is the same turned, and comes back as it is.
 */
export function turnEnvironment(env: EnvironmentLight, angle: number): EnvironmentLight {
  const shift = (width: number) => ((Math.round((-angle / (2 * Math.PI)) * width) % width) + width) % width;
  const rotate = <T extends Float32Array | Uint8ClampedArray>(data: T, width: number, height: number, channels: number): T => {
    const k = shift(width);
    if (k === 0) return data;
    const out = new (data.constructor as new (n: number) => T)(data.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const from = (y * width + x) * channels;
        const to = (y * width + ((x + k) % width)) * channels;
        for (let c = 0; c < channels; c += 1) out[to + c] = data[from + c]!;
      }
    }
    return out;
  };
  if (env.hdr) return { ...env, hdr: { ...env.hdr, data: rotate(env.hdr.data, env.hdr.width, env.hdr.height, 3) } };
  if (env.map) return { ...env, map: { ...env.map, data: rotate(env.map.data, env.map.width, env.map.height, 4) } };
  return env;
}

const gradient = (sky: [number, number, number], horizon: [number, number, number], ground: [number, number, number], intensity: number): EnvironmentLight =>
  ({ sky: sky.map(authoredFromLinear), horizon: horizon.map(authoredFromLinear), ground: ground.map(authoredFromLinear), intensity }) as unknown as EnvironmentLight;

/** A sun `elevation` radians up, `azimuth` round from +z toward +x: the direction toward it. */
function sunAt(elevation: number, azimuth: number): [number, number, number] {
  return [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)];
}

/** A rig's lights and sky for an asset of radius `r` (metres), before the turntable. */
function rigLights(rig: LookDevRig, r: number, hdri: EnvironmentLight | null): { lights: SceneLight[]; environment: EnvironmentLight | null; light: number } {
  const dark: SceneLight[] = [{ kind: "directional", direction: [0, 1, 0], color: [0, 0, 0], intensity: 0 }];
  switch (rig) {
    case "noon": {
      const sun = sunAt(1.05, 0.6);
      // A clear sky of about a quarter of the sun's light on a level grey card.
      return { lights: [{ kind: "directional", direction: sun, color: [1, 0.97, 0.92], intensity: 3 }], environment: gradient([0.12, 0.22, 0.5], [0.45, 0.55, 0.7], [0.12, 0.11, 0.1], 1), light: 3 * Math.sin(1.05) + 0.6 };
    }
    case "overcast":
      return { lights: dark, environment: gradient([0.85, 0.87, 0.9], [0.75, 0.76, 0.78], [0.2, 0.2, 0.2], 1), light: 0.85 };
    case "goldenHour": {
      const sun = sunAt(0.14, -0.9);
      return { lights: [{ kind: "directional", direction: sun, color: [1, 0.62, 0.32], intensity: 2.5 }], environment: gradient([0.08, 0.12, 0.28], [0.6, 0.38, 0.22], [0.06, 0.05, 0.04], 1), light: 2.5 * 0.6 + 0.3 };
    }
    case "night": {
      const moon = sunAt(0.7, 2.4);
      return { lights: [{ kind: "directional", direction: moon, color: [0.62, 0.72, 1], intensity: 0.02 }], environment: gradient([0.004, 0.006, 0.014], [0.008, 0.01, 0.02], [0.002, 0.002, 0.003], 1), light: 0.02 };
    }
    case "hdri":
      if (hdri) return { lights: dark, environment: hdri, light: 1 };
    // falls through: without an HDRI the studio stands in
    case "studio":
    default: {
      // Each panel is a metre and a half of the asset's size across, three of its sizes away: a luminance that lights
      // a grey card it faces to about four times the cyclorama.
      const d = 3 * r;
      const side = 1.5 * r;
      const luminance = (k: number) => (k * Math.PI * d * d) / (side * side);
      const panel = (at: [number, number, number], k: number, color: [number, number, number]): SceneLight => {
        const len = Math.hypot(...at);
        const toward = at.map((v) => -v / len) as [number, number, number];
        return { kind: "area", shape: "rect", size: [side, side], position: at.map((v) => (v / len) * d) as [number, number, number], direction: toward, color, intensity: luminance(k) };
      };
      return {
        lights: [panel([-1, 1.1, 1.2], 1, [1, 0.97, 0.94]), panel([1.4, 0.4, 1], 0.3, [0.9, 0.95, 1]), panel([0.4, 1, -1.5], 0.6, [1, 1, 1])],
        environment: gradient([0.05, 0.05, 0.05], [0.04, 0.04, 0.04], [0.03, 0.03, 0.03], 1),
        light: 1,
      };
    }
  }
}

/**
 * The stage for `asset` (or the props alone, with its decoded `maps`) seen in
 * a frame of `aspect` (width over height), lit by `options.rig`; see the module comment.
 */
export function lookDevStage(asset: MeshAsset | null, options: LookDevOptions, aspect = 16 / 9, maps: LookDevMaps = {}): LookDevStage {
  const angle = options.turntable ?? 0;
  const { min, max } = meshBounds(asset);
  const centre: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = Math.max(0.05, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const height = max[1] - min[1];
  const instances: MeshSceneInstance[] = [];
  const hdriRig = options.rig === "hdri" && Boolean(options.environment);
  if (asset) {
    // Feet on the floor at the origin; turned on the turntable unless the light turns instead.
    const spin = hdriRig ? 0 : (angle * 180) / Math.PI;
    const model = composeModelMatrix([0, 0, 0], [0, spin, 0], [1, 1, 1]);
    const offset = composeModelMatrix([-centre[0], -min[1], -centre[2]], [0, 0, 0], [1, 1, 1]);
    instances.push({ ...maps, mesh: asset, model: multiplyMat4(model, offset) } as MeshSceneInstance);
  }
  // The props, sized to the asset: a ball a fifth of its size across (at least 10 cm), set off to its right.
  const ball = Math.max(0.05, 0.2 * r);
  const greyBall = options.balls === false ? null : { centre: [r + 1.5 * ball, ball, 0.6 * r] as const, radius: ball };
  const chromeBall = options.balls === false ? null : { centre: [r + 4 * ball, ball, 0.6 * r] as const, radius: ball };
  if (greyBall && chromeBall) {
    instances.push({ mesh: lookDevSphere("grey ball", material("grey ball", [GREY_CARD, GREY_CARD, GREY_CARD], 0, 1)), model: composeModelMatrix(greyBall.centre as [number, number, number], [0, 0, 0], [ball, ball, ball]) } as MeshSceneInstance);
    instances.push({ mesh: lookDevSphere("chrome ball", material("chrome ball", [0.95, 0.95, 0.95], 1, 0)), model: composeModelMatrix(chromeBall.centre as [number, number, number], [0, 0, 0], [ball, ball, ball]) } as MeshSceneInstance);
  }
  const patch = Math.max(0.02, 0.14 * r);
  const chartHeight = 4 * (patch * 7) / 6 + patch / 6;
  const chart = options.chart === false ? null : { centre: [-(r + 3.6 * patch), chartHeight / 2 + 0.02 * r, -0.2 * r] as const, patch };
  if (chart) instances.push({ mesh: lookDevChart(patch), model: composeModelMatrix(chart.centre as [number, number, number], [0, 20, 0], [1, 1, 1]) } as MeshSceneInstance);
  if (options.floor !== false) {
    const side = 30 * r;
    instances.push({ mesh: { name: "floor", primitives: [quadPrimitive(material("floor", [GREY_CARD, GREY_CARD, GREY_CARD], 0, 0.85), [0, 0, 0], side, side, true)] } as unknown as MeshAsset, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) } as MeshSceneInstance);
  }

  const rig = rigLights(options.rig, r, options.environment ?? null);
  // The HDRI rig turns the light about the asset; the others turn the asset.
  const lights = hdriRig ? rig.lights.map((l) => ({ ...l, ...(l.direction ? { direction: turn(l.direction, angle) } : {}), ...(l.position ? { position: turn(l.position, angle) } : {}) })) : rig.lights;
  const environment = rig.environment && hdriRig ? turnEnvironment(rig.environment, angle) : rig.environment;

  // The camera: a little above, framing the asset and its props.
  const fov = options.fov ?? Math.PI / 4;
  const elevation = options.elevation ?? 0.25;
  const left = chart ? chart.centre[0] - 3.6 * patch : -r;
  const right = chromeBall ? chromeBall.centre[0] + ball : r;
  const span = Math.max(right - left, (height + 0.2 * r) * aspect);
  const target: [number, number, number] = [(left + right) / 2, Math.max(height, 2 * ball) / 2, 0];
  const distance = (span / 2 / Math.tan((fov * Math.min(1, aspect)) / 2)) * 1.15 + r;
  const eye: [number, number, number] = [target[0], target[1] + Math.sin(elevation) * distance, Math.cos(elevation) * distance];
  return {
    instances,
    lights,
    environment,
    ambient: 0,
    view: viewMatrix(eye, target),
    projection: projectionMatrix(fov, aspect, Math.max(0.01, distance / 200), distance * 40),
    // A level grey card reflects 0.18 × the light it takes: over that light, it shows at middle grey.
    exposure: 1 / Math.max(1e-4, rig.light),
    greyBall,
    chromeBall,
    chart,
  };
}
