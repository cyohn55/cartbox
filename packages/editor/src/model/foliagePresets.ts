/**
 * Built-in foliage (ENGINE_PARITY_ROADMAP.md EP11): small, cheap, low-poly
 * meshes to scatter without importing anything — a boulder, a snow drift, a
 * grass tuft and a pine — each with the layer settings it suits. Flat-shaded,
 * a few dozen triangles each, since a layer draws thousands of them.
 */

import { withGeneratedMaps, type EncodedImage, type MeshAsset, type MeshMaterial } from "./MeshAsset";
import { foliageRandom, type FoliageFill, type FoliageLayer } from "./foliage";
import { valueNoise } from "./materialGraph";
import { encodeRgbaPng } from "./png";

type V3 = readonly [number, number, number];

/** A flat-shaded mesh from triangles (each its own three vertices and face normal). */
function faceted(name: string, material: MeshMaterial, tris: readonly (readonly [V3, V3, V3])[]): MeshAsset {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  const uvs = new Float32Array(tris.length * 6);
  tris.forEach(([a, b, c], k) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    [a, b, c].forEach((p, i) => {
      positions.set(p, k * 9 + i * 3);
      normals.set([nx, ny, nz], k * 9 + i * 3);
      uvs.set([p[0] + p[2] * 0.5, p[1]], k * 6 + i * 2);
    });
  });
  return { name, primitives: [{ positions, normals, uvs, indices: Uint32Array.from({ length: tris.length * 3 }, (_, i) => i), material }] };
}

const mat = (name: string, rgb: V3, roughness: number): MeshMaterial => ({ name, baseColorFactor: [rgb[0], rgb[1], rgb[2], 1], baseColorImage: null, roughnessFactor: roughness, metallicFactor: 0 });

/** A lumpy boulder: an icosahedron, its corners pushed in and out, squashed a little. Half a unit across. */
export function boulderMesh(seed = 7, color: V3 = [0.36, 0.36, 0.38]): MeshAsset {
  const t = (1 + Math.sqrt(5)) / 2;
  const random = foliageRandom(seed);
  const corners: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x!, y!, z!);
    const r = 0.5 * (0.8 + random() * 0.4);
    return [(x! / l) * r, (y! / l) * r * 0.72, (z! / l) * r] as V3;
  });
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return faceted("boulder", mat("boulder", color, 0.92), faces.map(([a, b, c]) => [corners[a!]!, corners[b!]!, corners[c!]!] as const));
}

/** A wind-blown snow drift: a low, long dome, its rim uneven. About two units long. */
export function driftMesh(seed = 3): MeshAsset {
  const random = foliageRandom(seed);
  const n = 10;
  const rim: V3[] = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = 0.85 + random() * 0.3;
    return [Math.cos(a) * r, 0, Math.sin(a) * r * 0.45];
  });
  const mid: V3[] = rim.map(([x, , z], i) => [x * 0.55, 0.22 + (i % 2) * 0.03, z * 0.6]);
  const top: V3 = [0.15, 0.32, 0];
  const tris: [V3, V3, V3][] = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    tris.push([rim[i]!, mid[j]!, rim[j]!], [rim[i]!, mid[i]!, mid[j]!], [mid[i]!, top, mid[j]!]);
  }
  return faceted("drift", mat("drift", [0.86, 0.89, 0.94], 0.8), tris);
}

/** A grass tuft: crossed blades, both faces each, so it reads from any side. Half a unit tall. */
export function grassMesh(color: V3 = [0.32, 0.5, 0.2]): MeshAsset {
  const tris: [V3, V3, V3][] = [];
  for (let k = 0; k < 3; k += 1) {
    const a = (k / 3) * Math.PI;
    const dx = Math.cos(a) * 0.18, dz = Math.sin(a) * 0.18;
    const lean = 0.06;
    const l: V3 = [-dx, 0, -dz], r: V3 = [dx, 0, dz], tip: V3 = [lean * Math.sin(a), 0.5, lean * Math.cos(a)];
    tris.push([l, r, tip], [r, l, tip]);
  }
  return faceted("grass", mat("grass", color, 0.95), tris);
}

/** A pine: a stacked cone over a short trunk. About three units tall. */
export function pineMesh(): MeshAsset {
  const sides = 7;
  const ring = (y: number, r: number): V3[] => Array.from({ length: sides }, (_, i) => [Math.cos((i / sides) * Math.PI * 2) * r, y, Math.sin((i / sides) * Math.PI * 2) * r]);
  const trunk: [V3, V3, V3][] = [];
  const t0 = ring(0, 0.12), t1 = ring(0.6, 0.1);
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    trunk.push([t0[i]!, t1[i]!, t1[j]!], [t0[i]!, t1[j]!, t0[j]!]);
  }
  const leaves: [V3, V3, V3][] = [];
  for (const [y, r, h] of [[0.5, 0.9, 1.3], [1.3, 0.65, 1.1], [2.0, 0.4, 0.9]] as const) {
    const base = ring(y, r);
    const tip: V3 = [0, y + h, 0];
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      leaves.push([base[i]!, tip, base[j]!], [base[j]!, [0, y, 0], base[i]!]);
    }
  }
  const wood = faceted("pine", mat("bark", [0.3, 0.22, 0.15], 0.9), trunk);
  const needles = faceted("pine", mat("needles", [0.16, 0.3, 0.18], 0.85), leaves);
  return { name: "pine", primitives: [...wood.primitives, ...needles.primitives] };
}

/** Reeds: a clump of tall, thin, two-sided blades fanning out, for a creek's edge. About a metre tall. */
export function reedsMesh(seed = 5): MeshAsset {
  const random = foliageRandom(seed);
  const tris: [V3, V3, V3][] = [];
  for (let k = 0; k < 7; k += 1) {
    const a = random() * Math.PI * 2;
    const h = 0.7 + random() * 0.45;
    const w = 0.025;
    const lean = 0.08 + random() * 0.12;
    const bx = Math.cos(a) * 0.08, bz = Math.sin(a) * 0.08;
    const l: V3 = [bx - Math.sin(a) * w, 0, bz + Math.cos(a) * w];
    const r: V3 = [bx + Math.sin(a) * w, 0, bz - Math.cos(a) * w];
    const tip: V3 = [bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean];
    tris.push([l, r, tip], [r, l, tip]);
  }
  return faceted("reeds", mat("reeds", [0.42, 0.5, 0.24], 0.9), tris);
}

/** A broadleaf tree: a short trunk under a lumpy crown of three overlapping boulders' worth of leaves. About four units tall. */
export function broadleafMesh(seed = 11): MeshAsset {
  const sides = 6;
  const ring = (y: number, r: number): V3[] => Array.from({ length: sides }, (_, i) => [Math.cos((i / sides) * Math.PI * 2) * r, y, Math.sin((i / sides) * Math.PI * 2) * r]);
  const trunk: [V3, V3, V3][] = [];
  const t0 = ring(0, 0.16), t1 = ring(1.8, 0.1);
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    trunk.push([t0[i]!, t1[i]!, t1[j]!], [t0[i]!, t1[j]!, t0[j]!]);
  }
  const random = foliageRandom(seed);
  const leaves: [V3, V3, V3][] = [];
  for (const [cx, cy, cz, s] of [[0, 2.7, 0, 3], [0.6, 2.3, 0.3, 2.2], [-0.5, 2.4, -0.4, 2.3]] as const) {
    const blob = boulderMesh(Math.floor(random() * 1000), [0, 0, 0]).primitives[0]!.positions;
    for (let i = 0; i < blob.length; i += 9) {
      const p = (k: number): V3 => [cx + blob[i + k * 3]! * s, cy + blob[i + k * 3 + 1]! * s, cz + blob[i + k * 3 + 2]! * s];
      leaves.push([p(0), p(1), p(2)]);
    }
  }
  const wood = faceted("broadleaf", mat("bark", [0.32, 0.25, 0.18], 0.9), trunk);
  const crown = faceted("broadleaf", mat("leaves", [0.24, 0.38, 0.16], 0.8), leaves);
  return { name: "broadleaf", primitives: [...wood.primitives, ...crown.primitives] };
}

// --- Placement kit (EDITOR_PRO_ROADMAP.md P4) ----------------------------------------------

/**
 * A cliff rock: a slab of stone, wider than tall and longer than wide, its
 * faces broken by noise into chips and ledges (a twice-subdivided
 * icosahedron, displaced, faceted). Mapped with the rock generator (P1c),
 * projected triplanar in its own space, so every copy shows strata and
 * cracks without UVs. About a unit long.
 */
export function cliffRockMesh(seed = 4): MeshAsset {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x!, y!, z!);
    return [x! / l, y! / l, z! / l] as V3;
  });
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  // Subdivide twice, each new corner pushed out onto the sphere.
  for (let level = 0; level < 2; level += 1) {
    const mid = new Map<string, number>();
    const at = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let k = mid.get(key);
      if (k === undefined) {
        const p = verts[a]!, q = verts[b]!;
        const m: V3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        const l = Math.hypot(m[0], m[1], m[2]);
        k = verts.length;
        verts = [...verts, [m[0] / l, m[1] / l, m[2] / l]];
        mid.set(key, k);
      }
      return k;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = at(a, b), bc = at(b, c), ca = at(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]] as [number, number, number][];
    });
  }
  const shaped = verts.map(([x, y, z]) => {
    // Broad lumps and fine chips, then squashed into a slab; the base flattened to sit.
    const n = valueNoise(x * 1.6 + seed, y * 1.6, z * 1.6, 2) * 0.35 + valueNoise(x * 5 + seed * 3, y * 5, z * 5, 1) * 0.12;
    const r = 0.78 + n;
    return [x * r * 0.7, Math.max(-0.12, y * r * 0.32), z * r * 0.45] as V3;
  });
  const material = withGeneratedMaps({
    name: "cliff-rock",
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: null,
    metallicFactor: 1,
    roughnessFactor: 1,
    generator: { kind: "rock", seed, scale: 1, tint: [0.95, 0.9, 0.85], size: 128 },
    triplanar: 0.6,
  });
  return faceted("cliff rock", material, faces.map(([a, b, c]) => [shaped[a]!, shaped[b]!, shaped[c]!] as const));
}

let blades: EncodedImage | null = null;

/** The grass card's texture: a dozen tapering blades, green to straw at their tips, cut out by alpha. Shared, so stored once. */
export function grassCardTexture(): EncodedImage {
  if (blades) return blades;
  const w = 64, h = 64;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const random = foliageRandom(23);
  for (let b = 0; b < 14; b += 1) {
    const root = 3 + random() * (w - 6);
    const lean = (random() - 0.5) * 18;
    const tall = 0.55 + random() * 0.45;
    const thick = 1.4 + random() * 1.4;
    for (let y = 0; y < h; y += 1) {
      const up = 1 - y / (h - 1); // 0 at the root (bottom row), 1 at the top
      if (up > tall) continue;
      const f = up / tall;
      const cx = root + lean * f * f;
      const half = thick * (1 - f * 0.85);
      for (let x = Math.floor(cx - half - 1); x <= Math.ceil(cx + half + 1); x += 1) {
        if (x < 0 || x >= w) continue;
        const cover = Math.max(0, Math.min(1, half + 0.5 - Math.abs(x + 0.5 - cx)));
        if (cover <= 0) continue;
        const o = (y * w + x) * 4;
        const shade = 0.75 + valueNoise(x * 0.3, y * 0.2, b, 1) * 0.35;
        // Green at the root, drying toward the tip.
        const r = (0.28 + 0.3 * f) * shade, g = (0.48 + 0.12 * f) * shade, bl = (0.16 + 0.06 * f) * shade;
        if (cover * 255 > rgba[o + 3]!) rgba.set([r * 255, g * 255, bl * 255, cover * 255], o);
      }
    }
  }
  blades = { mime: "image/png", bytes: encodeRgbaPng(rgba, w, h, { compress: true }) };
  return blades;
}

/**
 * Grass cards: three crossed quads (both faces each) carrying a texture of a
 * dozen blades, cut out by alpha (mask mode) — far more blades for the
 * triangles than modelled tufts. Normals point up, so the cards light like
 * the ground they grow from rather than flashing as they turn. Half a unit
 * tall.
 */
export function grassCardMesh(): MeshAsset {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = 0.3, tall = 0.5;
  for (let k = 0; k < 3; k += 1) {
    const a = (k / 3) * Math.PI;
    const dx = Math.cos(a) * half, dz = Math.sin(a) * half;
    for (const face of [0, 1]) {
      const o = positions.length / 3;
      positions.push(-dx, 0, -dz, dx, 0, dz, dx, tall, dz, -dx, tall, -dz);
      uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
      if (face === 0) indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
      else indices.push(o, o + 2, o + 1, o, o + 3, o + 2);
    }
  }
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v += 1) normals[v * 3 + 1] = 1;
  const material: MeshMaterial = {
    name: "grass-cards",
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: grassCardTexture(),
    metallicFactor: 0,
    roughnessFactor: 0.95,
    alphaMode: "mask",
    alphaCutoff: 0.5,
  };
  return { name: "grass cards", primitives: [{ positions: Float32Array.from(positions), normals, uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material }] };
}

export type FoliagePreset = "boulder" | "drift" | "grass" | "reeds" | "pine" | "broadleaf" | "cliffRocks" | "grassCards";

/** Every preset, in the order the editor offers them. */
export const FOLIAGE_PRESETS: readonly FoliagePreset[] = ["boulder", "drift", "grass", "reeds", "pine", "broadleaf", "cliffRocks", "grassCards"];

/** Each preset's name as the editor shows it (and a new layer is called). */
export const FOLIAGE_PRESET_LABELS: Readonly<Record<FoliagePreset, string>> = {
  boulder: "boulders",
  drift: "snow drifts",
  grass: "grass",
  reeds: "reeds",
  pine: "pines",
  broadleaf: "broadleaf trees",
  cliffRocks: "cliff rocks",
  grassCards: "grass cards",
};

/** A preset's mesh and the layer settings it suits. */
export function foliagePreset(kind: FoliagePreset): { mesh: MeshAsset; settings: Pick<FoliageLayer, "density" | "scale" | "align" | "sink" | "cull" | "wind">; fill?: Omit<FoliageFill, "seed"> } {
  switch (kind) {
    case "boulder":
      return { mesh: boulderMesh(), settings: { density: 2, scale: [0.6, 2.4], align: 0.8, sink: 0.12, cull: 160 } };
    case "drift":
      return { mesh: driftMesh(), settings: { density: 1.5, scale: [1, 2.6], align: 1, sink: 0.04, cull: 140 } };
    case "grass":
      return { mesh: grassMesh(), settings: { density: 60, scale: [0.6, 1.3], align: 0.7, sink: 0, cull: 40, wind: 3 } };
    case "reeds":
      return { mesh: reedsMesh(), settings: { density: 30, scale: [0.7, 1.4], align: 0.3, sink: 0, cull: 50, wind: 4 } };
    case "pine":
      return { mesh: pineMesh(), settings: { density: 1, scale: [0.8, 1.8], align: 0, sink: 0.1, cull: 220, wind: 0.5 } };
    case "cliffRocks":
      // Only on the steep faces, lying along them and half sunk, so they read as the cliff breaking up.
      return { mesh: cliffRockMesh(), settings: { density: 3, scale: [1.2, 3.4], align: 1, sink: 0.3, cull: 200 }, fill: { up: [0.2, 0.8] } };
    case "grassCards":
      return { mesh: grassCardMesh(), settings: { density: 45, scale: [0.7, 1.4], align: 0.6, sink: 0, cull: 45, wind: 3 } };
    case "broadleaf":
      return { mesh: broadleafMesh(), settings: { density: 0.6, scale: [0.8, 1.5], align: 0, sink: 0.1, cull: 240, wind: 0.7 } };
  }
}
