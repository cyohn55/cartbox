/**
 * MikkTSpace tangents for imported normal maps (AAA_FIDELITY_ROADMAP.md F1c).
 *
 * A tangent-space normal map is an encoding: it decodes exactly only in the
 * tangent frame it was baked in. Substance, Marmoset, Blender and xNormal bake
 * in MikkTSpace, and glTF recommends it, so a normal-mapped primitive that
 * arrives without TANGENT is given MikkTSpace tangents on import. The shader's
 * derivative tangent (the fallback every renderer keeps) is close on simple
 * UV layouts but bends seams and mirrored islands wrongly.
 *
 * MikkTSpace takes unwelded triangles, so the primitive is unwelded, given its
 * tangents, and welded again: a vertex splits only where its corners came back
 * with different tangents (a UV seam, a mirrored island). The generator itself
 * is supplied by the caller (the editor loads the WebAssembly build; tests load
 * the same file), so this module stays DOM-free.
 */

import type { MeshAsset, MeshPrimitive } from "./MeshAsset";

/**
 * MikkTSpace over unwelded triangles: three floats a corner of positions and
 * normals, two of texture coordinates in, four of tangent out (`w` the
 * bitangent's sign, in MikkTSpace's own texture convention).
 */
export type MikkTSpace = (positions: Float32Array, normals: Float32Array, uvs: Float32Array) => Float32Array;

/** Whether a primitive decodes a normal map and could carry tangents, but has none. */
export function needsTangents(primitive: MeshPrimitive): boolean {
  return Boolean(primitive.material.normalImage) && Boolean(primitive.normals) && Boolean(primitive.uvs) && !primitive.tangents && !primitive.joints;
}

/** Per-vertex streams a weld carries over, with their components per vertex. */
const STREAMS = [
  ["positions", 3],
  ["normals", 3],
  ["uvs", 2],
  ["uvs2", 2],
  ["blend", 1],
  ["sway", 1],
] as const;

/**
 * The primitive with MikkTSpace tangents. The engine samples a texture at
 * (u, 1 − v), so its V points up the image as MikkTSpace's does, and
 * MikkTSpace's sign is the engine's own (glTF's is the opposite, see
 * gltfCodec.ts). Vertices split where their corners' tangents differ;
 * everything else stays as it was.
 */
export function withMikkTangents(primitive: MeshPrimitive, mikk: MikkTSpace): MeshPrimitive {
  if (!primitive.normals || !primitive.uvs) return primitive;
  const corners = primitive.indices.length;
  const positions = new Float32Array(corners * 3);
  const normals = new Float32Array(corners * 3);
  const uvs = new Float32Array(corners * 2);
  for (let c = 0; c < corners; c += 1) {
    const v = primitive.indices[c]!;
    for (let k = 0; k < 3; k += 1) {
      positions[c * 3 + k] = primitive.positions[v * 3 + k]!;
      normals[c * 3 + k] = primitive.normals[v * 3 + k]!;
    }
    uvs[c * 2] = primitive.uvs[v * 2]!;
    uvs[c * 2 + 1] = primitive.uvs[v * 2 + 1]!;
  }
  const generated = mikk(positions, normals, uvs);
  if (generated.length !== corners * 4) return primitive;

  // Weld: one vertex per (source vertex, tangent) pair.
  const remap = new Map<string, number>();
  const sources: number[] = [];
  const tangents: number[] = [];
  const indices = new Uint32Array(corners);
  for (let c = 0; c < corners; c += 1) {
    const v = primitive.indices[c]!;
    const t = [generated[c * 4]!, generated[c * 4 + 1]!, generated[c * 4 + 2]!, generated[c * 4 + 3]! < 0 ? -1 : 1] as const;
    const key = `${v}:${t[0]},${t[1]},${t[2]},${t[3]}`;
    let index = remap.get(key);
    if (index === undefined) {
      index = sources.length;
      remap.set(key, index);
      sources.push(v);
      tangents.push(t[0], t[1], t[2], t[3]);
    }
    indices[c] = index;
  }
  const out: Record<string, unknown> = { ...primitive, indices, tangents: Float32Array.from(tangents) };
  for (const [name, size] of STREAMS) {
    const stream = primitive[name] as Float32Array | null | undefined;
    if (!stream) continue;
    const copy = new Float32Array(sources.length * size);
    sources.forEach((v, i) => copy.set(stream.subarray(v * size, v * size + size), i * size));
    out[name] = copy;
  }
  return out as unknown as MeshPrimitive;
}

/** The mesh with MikkTSpace tangents on each normal-mapped primitive that has none; the same mesh when none needs them. */
export function withMeshTangents(mesh: MeshAsset, mikk: MikkTSpace): MeshAsset {
  if (!mesh.primitives.some(needsTangents)) return mesh;
  return { ...mesh, primitives: mesh.primitives.map((p) => (needsTangents(p) ? withMikkTangents(p, mikk) : p)) };
}
