/**
 * Built-in foliage (ENGINE_PARITY_ROADMAP.md EP11): small, cheap, low-poly
 * meshes to scatter without importing anything — a boulder, a snow drift, a
 * grass tuft and a pine — each with the layer settings it suits. Flat-shaded,
 * a few dozen triangles each, since a layer draws thousands of them.
 */

import type { MeshAsset, MeshMaterial } from "./MeshAsset";
import { foliageRandom, type FoliageLayer } from "./foliage";

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

export type FoliagePreset = "boulder" | "drift" | "grass" | "reeds" | "pine" | "broadleaf";

/** Every preset, in the order the editor offers them. */
export const FOLIAGE_PRESETS: readonly FoliagePreset[] = ["boulder", "drift", "grass", "reeds", "pine", "broadleaf"];

/** A preset's mesh and the layer settings it suits. */
export function foliagePreset(kind: FoliagePreset): { mesh: MeshAsset; settings: Pick<FoliageLayer, "density" | "scale" | "align" | "sink" | "cull" | "wind"> } {
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
    case "broadleaf":
      return { mesh: broadleafMesh(), settings: { density: 0.6, scale: [0.8, 1.5], align: 0, sink: 0.1, cull: 240, wind: 0.7 } };
  }
}
