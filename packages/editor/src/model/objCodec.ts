/**
 * A reader and writer for Wavefront OBJ — the simplest and most universal mesh
 * interchange format, so a voxel sculpt or an imported model can move between the
 * editor and Blender/Godot/Unity/Maya. OBJ is ASCII: `v`/`vt`/`vn` declare shared
 * position/texcoord/normal pools, and `f` faces index them (1-based, separate
 * index spaces per attribute). A companion `.mtl` names materials and their
 * diffuse colour.
 *
 * Two things this codec does that a naive expander does not:
 *
 * - **Re-indexes** rather than flattening. Each distinct `v/vt/vn` combination
 *   becomes one vertex, shared by every triangle that uses it, so the imported
 *   {@link MeshAsset} keeps compact indexed geometry instead of three vertices
 *   per triangle.
 * - **Splits by material** (`usemtl`) into one {@link MeshPrimitive} per material,
 *   so a multi-material OBJ imports as several primitives, each flat-colourable.
 *
 * Scope: polygons are fan-triangulated; texture *images* are not read here (OBJ
 * references them as separate files — the editor supplies those), so a material
 * carries only its `Kd` diffuse colour. Coordinates are preserved exactly as the
 * file states them (no axis conversion). Pure and DOM-free.
 */

import {
  type MeshAsset,
  type MeshPrimitive,
  type MeshMaterial,
  defaultMaterial,
} from "./MeshAsset";

/** Parsed `.mtl` diffuse colours, keyed by material name. */
type MtlColors = Map<string, [number, number, number, number]>;

/** Parse the `Kd` diffuse colour (and `d`/`Tr` alpha) of each `newmtl` block. */
function parseMtl(mtl: string): MtlColors {
  const colors: MtlColors = new Map();
  let current: string | null = null;
  for (const line of mtl.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const keyword = parts[0];
    if (keyword === "newmtl") {
      current = parts[1] ?? "";
      colors.set(current, [1, 1, 1, 1]);
    } else if (keyword === "Kd" && current !== null) {
      const existing = colors.get(current)!;
      colors.set(current, [Number(parts[1]), Number(parts[2]), Number(parts[3]), existing[3]]);
    } else if ((keyword === "d" || keyword === "Tr") && current !== null) {
      // `d` is opacity, `Tr` is transparency — complements of each other.
      const value = Number(parts[1]);
      const alpha = keyword === "d" ? value : 1 - value;
      const existing = colors.get(current)!;
      colors.set(current, [existing[0], existing[1], existing[2], alpha]);
    }
  }
  return colors;
}

/** Resolve a 1-based OBJ index (negative counts back from the pool's end) to 0-based, or -1. */
function resolveIndex(token: string | undefined, poolLength: number): number {
  if (!token) return -1;
  const value = Number.parseInt(token, 10);
  if (Number.isNaN(value)) return -1;
  const zeroBased = value > 0 ? value - 1 : poolLength + value; // negative is relative to the end
  return zeroBased >= 0 && zeroBased < poolLength ? zeroBased : -1;
}

/** Accumulates de-indexed vertices for a single material group. */
class PrimitiveBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  private readonly comboToIndex = new Map<string, number>();
  hasAllNormals = true;
  hasAllUvs = true;

  /** Map one face-corner (a `v/vt/vn` triple, already resolved) to a shared vertex index. */
  vertex(
    verts: readonly number[],
    texcoords: readonly number[],
    norms: readonly number[],
    vi: number,
    ti: number,
    ni: number,
  ): number {
    const key = `${vi}/${ti}/${ni}`;
    const existing = this.comboToIndex.get(key);
    if (existing !== undefined) return existing;

    const index = this.positions.length / 3;
    this.positions.push(verts[vi * 3]!, verts[vi * 3 + 1]!, verts[vi * 3 + 2]!);
    if (ti >= 0) this.uvs.push(texcoords[ti * 2]!, texcoords[ti * 2 + 1]!);
    else {
      this.uvs.push(0, 0);
      this.hasAllUvs = false;
    }
    if (ni >= 0) this.normals.push(norms[ni * 3]!, norms[ni * 3 + 1]!, norms[ni * 3 + 2]!);
    else {
      this.normals.push(0, 0, 0);
      this.hasAllNormals = false;
    }
    this.comboToIndex.set(key, index);
    return index;
  }

  build(material: MeshMaterial): MeshPrimitive {
    return {
      positions: Float32Array.from(this.positions),
      // Only surface normals/uvs when every vertex in the group had them; a
      // partial set is worse than none (the rasteriser can derive smooth normals).
      normals: this.hasAllNormals ? Float32Array.from(this.normals) : null,
      uvs: this.hasAllUvs ? Float32Array.from(this.uvs) : null,
      indices: Uint32Array.from(this.indices),
      material,
    };
  }
}

export interface ParseObjOptions {
  /** Companion `.mtl` text, so `usemtl` groups pick up their diffuse colour. */
  readonly mtl?: string;
  /** Name for the resulting asset (defaults to `"mesh"`). */
  readonly name?: string;
}

/**
 * Parse OBJ text into a {@link MeshAsset}. Faces are fan-triangulated, attributes
 * are re-indexed, and each `usemtl` group becomes its own primitive. Throws only
 * if the file yields no triangles at all.
 */
export function parseObj(objText: string, options: ParseObjOptions = {}): MeshAsset {
  const mtlColors = options.mtl ? parseMtl(options.mtl) : null;
  const verts: number[] = [];
  const texcoords: number[] = [];
  const norms: number[] = [];

  // One builder per material name; faces before any `usemtl` land in the default.
  const builders = new Map<string, PrimitiveBuilder>();
  const materialOrder: string[] = [];
  let currentMaterial = "";
  const builderFor = (name: string): PrimitiveBuilder => {
    let builder = builders.get(name);
    if (!builder) {
      builder = new PrimitiveBuilder();
      builders.set(name, builder);
      materialOrder.push(name);
    }
    return builder;
  };

  for (const line of objText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    const keyword = parts[0];

    if (keyword === "v") {
      verts.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (keyword === "vt") {
      texcoords.push(Number(parts[1]), Number(parts[2]));
    } else if (keyword === "vn") {
      norms.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (keyword === "usemtl") {
      currentMaterial = parts[1] ?? "";
    } else if (keyword === "f") {
      const builder = builderFor(currentMaterial);
      // Resolve every corner of the face once, then fan-triangulate.
      const corners = parts.slice(1).map((token) => {
        const [v, t, n] = token.split("/");
        return builder.vertex(
          verts,
          texcoords,
          norms,
          resolveIndex(v, verts.length / 3),
          resolveIndex(t, texcoords.length / 2),
          resolveIndex(n, norms.length / 3),
        );
      });
      for (let i = 1; i < corners.length - 1; i += 1) {
        builder.indices.push(corners[0]!, corners[i]!, corners[i + 1]!);
      }
    }
  }

  const primitives: MeshPrimitive[] = [];
  for (const name of materialOrder) {
    const builder = builders.get(name)!;
    if (builder.indices.length === 0) continue;
    const color = mtlColors?.get(name) ?? null;
    const material: MeshMaterial = color
      ? { name: name || "default", baseColorFactor: color, baseColorImage: null }
      : defaultMaterial(name || "default");
    primitives.push(builder.build(material));
  }

  if (primitives.length === 0) throw new Error("OBJ file contains no triangles");
  return { name: options.name ?? "mesh", primitives };
}

/** The two text files an OBJ export produces: the geometry and its material library. */
export interface ObjFiles {
  readonly obj: string;
  readonly mtl: string;
}

/** Format a float compactly, dropping a trailing `.0` the way OBJ writers do. */
const fmt = (value: number): string => {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/**
 * Encode a {@link MeshAsset} to OBJ + MTL text. Each primitive becomes a
 * `usemtl` group over a shared, file-global vertex pool; normals and texcoords
 * are written when present. Texture *images* are not embedded (OBJ has no
 * mechanism for it) — only the base colour survives, as the material's `Kd`. Use
 * the glTF/GLB export to keep textures.
 */
export function encodeObj(mesh: MeshAsset, materialLibName = "mesh.mtl"): ObjFiles {
  const objLines: string[] = [`# Exported from Cartbox`, `mtllib ${materialLibName}`];
  const mtlLines: string[] = [`# Exported from Cartbox`];

  // OBJ indices are 1-based and shared across the whole file, so each primitive's
  // faces are offset past the vertices already written.
  let positionBase = 1;
  let uvBase = 1;
  let normalBase = 1;

  mesh.primitives.forEach((primitive, index) => {
    const materialName = primitive.material.name || `material_${index}`;
    const [r, g, b, a] = primitive.material.baseColorFactor;
    mtlLines.push(`newmtl ${materialName}`, `Kd ${fmt(r)} ${fmt(g)} ${fmt(b)}`, `d ${fmt(a)}`);

    const vertexCount = primitive.positions.length / 3;
    for (let v = 0; v < vertexCount; v += 1) {
      objLines.push(`v ${fmt(primitive.positions[v * 3]!)} ${fmt(primitive.positions[v * 3 + 1]!)} ${fmt(primitive.positions[v * 3 + 2]!)}`);
    }
    if (primitive.uvs) {
      for (let v = 0; v < vertexCount; v += 1) {
        objLines.push(`vt ${fmt(primitive.uvs[v * 2]!)} ${fmt(primitive.uvs[v * 2 + 1]!)}`);
      }
    }
    if (primitive.normals) {
      for (let v = 0; v < vertexCount; v += 1) {
        objLines.push(`vn ${fmt(primitive.normals[v * 3]!)} ${fmt(primitive.normals[v * 3 + 1]!)} ${fmt(primitive.normals[v * 3 + 2]!)}`);
      }
    }

    objLines.push(`usemtl ${materialName}`);
    // Build a face reference for one vertex: v, v/vt, v//vn, or v/vt/vn.
    const ref = (local: number): string => {
      const p = positionBase + local;
      const t = uvBase + local;
      const n = normalBase + local;
      if (primitive.uvs && primitive.normals) return `${p}/${t}/${n}`;
      if (primitive.uvs) return `${p}/${t}`;
      if (primitive.normals) return `${p}//${n}`;
      return `${p}`;
    };
    for (let i = 0; i < primitive.indices.length; i += 3) {
      objLines.push(`f ${ref(primitive.indices[i]!)} ${ref(primitive.indices[i + 1]!)} ${ref(primitive.indices[i + 2]!)}`);
    }

    positionBase += vertexCount;
    if (primitive.uvs) uvBase += vertexCount;
    if (primitive.normals) normalBase += vertexCount;
  });

  return { obj: objLines.join("\n") + "\n", mtl: mtlLines.join("\n") + "\n" };
}
