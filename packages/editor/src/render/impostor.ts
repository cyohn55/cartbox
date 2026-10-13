/**
 * Impostors (EDITOR_PRO_ROADMAP.md P4): a tree baked into pictures of itself,
 * drawn far off in its place — two crossed cards carrying four views (front,
 * back and both sides), cut out by alpha, so a forest on a canyon rim costs a
 * few triangles a tree instead of hundreds.
 *
 * The views are rendered here by the software rasteriser from straight on
 * (orthographic), each material turned emissive-only for the bake, so the
 * pictures hold the tree's own colours unlit: the scene lights the cards once,
 * as it lights everything else. Each card's corners are projected through the
 * very camera that drew its view to find their UVs, so the picture lands
 * exactly where the tree stood. Pure; the editor bakes, the cart stores the
 * result, the player only draws it.
 */

import { encodeRgbaPng } from "../model/png";
import { meshBounds, type MeshAsset, type MeshMaterial, type MeshPrimitive } from "../model/MeshAsset";
import { renderMeshScene, viewMatrix, type DecodedTexture, type Mat4 } from "./meshRasterizer";

/** The four directions the views are taken from (toward the tree): +X, −X, +Z, −Z. */
const VIEWS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** An orthographic projection over [−w/2, w/2] × [−h/2, h/2], depth near..far (column-major, OpenGL clip). */
function ortho(w: number, h: number, near: number, far: number): Mat4 {
  return Float64Array.from([2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
}

/** The material for the bake: black, with its colour (and map) as emission, so it renders unlit. */
function unlit(material: MeshMaterial): MeshMaterial {
  const [r, g, b, a] = material.baseColorFactor;
  return {
    name: material.name,
    baseColorFactor: [0, 0, 0, a],
    baseColorImage: material.baseColorImage,
    emissiveFactor: [r, g, b],
    emissiveImage: material.baseColorImage,
    metallicFactor: 0,
    roughnessFactor: 1,
    ...(material.alphaMode ? { alphaMode: material.alphaMode } : {}),
    ...(material.alphaCutoff !== undefined ? { alphaCutoff: material.alphaCutoff } : {}),
  };
}

const mul = (m: Mat4, p: readonly number[]): [number, number, number, number] => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
  m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!,
];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r] = out[c * 4 + r]! + a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/** What baking a mesh gives: the card mesh (its atlas in its material), and the atlas's size in pixels. */
export interface BakedImpostor {
  readonly mesh: MeshAsset;
  readonly width: number;
  readonly height: number;
}

/**
 * Bake a mesh into an impostor: four views of `size` pixels tall side by side
 * in one atlas, on two crossed cards (both faces each) spanning the mesh's
 * bounds. `textures` are its primitives' decoded base-colour maps, index for
 * index (null where a primitive has none). Null for a mesh with no extent.
 */
export function bakeImpostor(mesh: MeshAsset, textures: readonly (DecodedTexture | null)[] = [], size = 64): BakedImpostor | null {
  const bounds = meshBounds(mesh);
  if (!bounds) return null;
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const height = y1 - y0;
  const across = Math.max(x1 - x0, z1 - z0);
  if (!(height > 0) || !(across > 0)) return null;
  const centre: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const cellH = Math.max(8, Math.round(size));
  const cellW = Math.max(8, Math.round((cellH * across) / height));
  const atlasW = cellW * VIEWS.length;
  const atlas = new Uint8ClampedArray(atlasW * cellH * 4);
  const bake = { ...mesh, primitives: mesh.primitives.map((p) => ({ ...p, material: unlit(p.material) })) };
  const reach = Math.hypot(x1 - x0, y1 - y0, z1 - z0) + 1;
  const projection = ortho(across, height, 0.01, reach * 2);
  const cameras: Mat4[] = [];
  VIEWS.forEach((dir, k) => {
    const eye: [number, number, number] = [centre[0] + dir[0] * reach, centre[1], centre[2] + dir[2] * reach];
    const view = viewMatrix(eye, centre);
    cameras.push(multiply(projection, view));
    const out = new Uint8ClampedArray(cellW * cellH * 4);
    renderMeshScene([{ mesh: bake, model: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), textures, emissiveTextures: textures }], {
      width: cellW,
      height: cellH,
      out,
      depth: new Float32Array(cellW * cellH),
      view,
      projection,
      background: [0, 0, 0, 0],
      ambient: 0,
      lightDirection: [0, 1, 0],
    });
    for (let y = 0; y < cellH; y += 1) atlas.set(out.subarray(y * cellW * 4, (y + 1) * cellW * 4), (y * atlasW + k * cellW) * 4);
  });
  // Bleed each opaque texel's colour into its transparent neighbours, so filtering at a cut-out edge doesn't fringe dark.
  for (let pass = 0; pass < 2; pass += 1) {
    const src = Uint8ClampedArray.from(atlas);
    for (let y = 0; y < cellH; y += 1) {
      for (let x = 0; x < atlasW; x += 1) {
        const o = (y * atlasW + x) * 4;
        if (src[o + 3]! > 0) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= atlasW || ny >= cellH) continue;
          const q = (ny * atlasW + nx) * 4;
          if (src[q + 3]! === 0 || (src[q]! === 0 && src[q + 1]! === 0 && src[q + 2]! === 0 && pass > 0)) continue;
          atlas[o] = src[q]!;
          atlas[o + 1] = src[q + 1]!;
          atlas[o + 2] = src[q + 2]!;
          break;
        }
      }
    }
  }
  const material: MeshMaterial = {
    name: `${mesh.name} impostor`,
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: { mime: "image/png", bytes: encodeRgbaPng(atlas, atlasW, cellH, { compress: true }) },
    metallicFactor: 0,
    roughnessFactor: 0.9,
    alphaMode: "mask",
    alphaCutoff: 0.5,
  };
  // Each view's card: a quad through the centre facing its camera, its UVs the camera's own projection of its corners.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  VIEWS.forEach((dir, k) => {
    const side: [number, number, number] = [-dir[2], 0, dir[0]];
    const corners: [number, number, number][] = [
      [centre[0] - side[0] * (across / 2), y0, centre[2] - side[2] * (across / 2)],
      [centre[0] + side[0] * (across / 2), y0, centre[2] + side[2] * (across / 2)],
      [centre[0] + side[0] * (across / 2), y1, centre[2] + side[2] * (across / 2)],
      [centre[0] - side[0] * (across / 2), y1, centre[2] - side[2] * (across / 2)],
    ];
    const o = positions.length / 3;
    // Lit mostly from above, leaning toward its camera: a canopy, not a sign.
    const nl = Math.hypot(dir[0] * 0.4, 1, dir[2] * 0.4);
    for (const c of corners) {
      positions.push(...c);
      normals.push((dir[0] * 0.4) / nl, 1 / nl, (dir[2] * 0.4) / nl);
      const clip = mul(cameras[k]!, c);
      const u = (clip[0] / clip[3] + 1) / 2;
      const v = 1 - (clip[1] / clip[3] + 1) / 2;
      uvs.push((k + Math.max(0, Math.min(1, u))) / VIEWS.length, Math.max(0, Math.min(1, v)));
    }
    // Facing its camera (counter-clockwise seen from `dir`).
    const a = corners[0]!, b = corners[1]!, c = corners[2]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const facing = (uy * vz - uz * vy) * dir[0] + (ux * vy - uy * vx) * dir[2];
    if (facing >= 0) indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
    else indices.push(o, o + 2, o + 1, o, o + 3, o + 2);
  });
  const primitive: MeshPrimitive = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material };
  return { mesh: { name: `${mesh.name} impostor`, primitives: [primitive] }, width: atlasW, height: cellH };
}
