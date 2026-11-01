/**
 * Asset validation (AAA_FIDELITY_ROADMAP.md F9e): what an asset checker in a
 * AAA pipeline flags before an asset ships — the texel density its maps give
 * it, its names, its budgets, and the maps a material should have but doesn't.
 *
 * Each finding has a severity ("error" blocks a publish where the caller
 * enforces it, "warning" is advice), a code, the primitive it concerns and a
 * message a creator can act on. Pure and DOM-free.
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly code: "texel-density-low" | "texel-density-high" | "texel-density-uneven" | "name" | "triangles" | "texture-memory" | "texture-size" | "missing-uvs" | "missing-normals" | "missing-map" | "missing-tangents" | "degenerate";
  /** The primitive it concerns, or −1 for the whole asset. */
  readonly primitive: number;
  readonly message: string;
}

export interface ValidationOptions {
  /** The texel density aimed for, texels per metre (default 512: a 2K map over 4 m, AAA first-person props). */
  readonly texelDensity?: number;
  /** How far off the target a primitive may be, as a factor either way, before a warning (default 2). */
  readonly densityTolerance?: number;
  /** The most triangles the asset may have (default none). */
  readonly maxTriangles?: number;
  /** The most texture memory, in bytes as uploaded (RGBA8 with mips), the asset's maps may take (default none). */
  readonly maxTextureBytes?: number;
  /** The largest edge any map may have (default 8192). */
  readonly maxTextureSize?: number;
  /** What names must look like (default: letters, digits, `_`, `-`, `.`; no spaces). */
  readonly namePattern?: RegExp;
}

/** Known image slots and what a missing one means. */
const PBR_SLOTS = ["baseColorImage", "normalImage", "metallicRoughnessImage"] as const;

/** An encoded image's size, read from its header (PNG, JPEG and KTX2), or null. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: the first start-of-frame marker holds the size.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
      }
      i += 2 + length;
    }
    return null;
  }
  if (bytes.length >= 32 && bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(20, true), height: v.getUint32(24, true) };
  }
  return null;
}

/** The images a material carries, with their slots. */
function images(material: MeshMaterial): { slot: string; bytes: Uint8Array }[] {
  const out: { slot: string; bytes: Uint8Array }[] = [];
  for (const [slot, value] of Object.entries(material)) {
    if (!slot.endsWith("Image") || !value || typeof value !== "object") continue;
    const bytes = (value as { bytes?: unknown }).bytes;
    if (bytes instanceof Uint8Array && bytes.length > 0) out.push({ slot, bytes });
  }
  return out;
}

/**
 * A primitive's texel density: texels per metre its base-colour map (or, failing
 * that, its largest map) gives it, from the ratio of its UV area to its surface
 * area, and how uneven that is across its triangles (the largest triangle
 * density over the smallest, area-weighted to ignore slivers).
 */
export function texelDensity(p: MeshPrimitive, mapSize: number): { density: number; spread: number } | null {
  const uvs = p.uvs;
  if (!uvs) return null;
  let world = 0;
  let uv = 0;
  const per: { d: number; a: number }[] = [];
  for (let t = 0; t < p.indices.length; t += 3) {
    const [a, b, c] = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
    const e1 = [0, 1, 2].map((k) => p.positions[b * 3 + k]! - p.positions[a * 3 + k]!);
    const e2 = [0, 1, 2].map((k) => p.positions[c * 3 + k]! - p.positions[a * 3 + k]!);
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const wa = Math.hypot(cr[0]!, cr[1]!, cr[2]!) / 2;
    const ua = Math.abs((uvs[b * 2]! - uvs[a * 2]!) * (uvs[c * 2 + 1]! - uvs[a * 2 + 1]!) - (uvs[c * 2]! - uvs[a * 2]!) * (uvs[b * 2 + 1]! - uvs[a * 2 + 1]!)) / 2;
    world += wa;
    uv += ua;
    if (wa > 1e-12 && ua > 1e-12) per.push({ d: Math.sqrt(ua / wa) * mapSize, a: wa });
  }
  if (world <= 1e-12 || uv <= 1e-12) return null;
  // The spread between the 10th and 90th area-weighted percentiles, so a few slivers don't dominate.
  per.sort((x, y) => x.d - y.d);
  const total = per.reduce((s, x) => s + x.a, 0);
  const percentile = (q: number) => {
    let seen = 0;
    for (const x of per) {
      seen += x.a;
      if (seen >= q * total) return x.d;
    }
    return per.at(-1)?.d ?? 0;
  };
  const lo = percentile(0.1);
  const hi = percentile(0.9);
  return { density: Math.sqrt(uv / world) * mapSize, spread: lo > 0 ? hi / lo : 1 };
}

/** Check an asset (see the module comment). */
export function validateMeshAsset(mesh: MeshAsset, options: ValidationOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const target = options.texelDensity ?? 512;
  const tolerance = Math.max(1.01, options.densityTolerance ?? 2);
  const maxSize = options.maxTextureSize ?? 8192;
  const pattern = options.namePattern ?? /^[A-Za-z0-9_.-]+$/;
  if (!pattern.test(mesh.name)) issues.push({ severity: "warning", code: "name", primitive: -1, message: `The asset's name "${mesh.name}" has characters a pipeline trips on: keep to letters, digits, "_", "-" and ".".` });
  let triangles = 0;
  let textureBytes = 0;
  const counted = new Set<Uint8Array>();
  mesh.primitives.forEach((p, i) => {
    const m = p.material;
    triangles += p.indices.length / 3;
    if (!pattern.test(m.name)) issues.push({ severity: "warning", code: "name", primitive: i, message: `Material "${m.name}" has characters a pipeline trips on.` });
    if (p.indices.length === 0 || p.indices.length % 3 !== 0) issues.push({ severity: "error", code: "degenerate", primitive: i, message: `Part ${i + 1} has no whole triangles.` });
    if (!p.normals) issues.push({ severity: "warning", code: "missing-normals", primitive: i, message: `Part ${i + 1} has no normals: it lights faceted.` });
    const maps = images(m);
    if (maps.length > 0 && !p.uvs) issues.push({ severity: "error", code: "missing-uvs", primitive: i, message: `Part ${i + 1} has maps but no texture coordinates to place them.` });
    // A PBR set half done: some of base colour, normal and metal/roughness, but not all.
    const has = PBR_SLOTS.map((slot) => Boolean(m[slot] && (m[slot] as { bytes: Uint8Array }).bytes.length > 0));
    if (has.some(Boolean) && !has.every(Boolean)) {
      const missing = PBR_SLOTS.filter((_, k) => !has[k]).map((slot) => slot.replace("Image", ""));
      issues.push({ severity: "warning", code: "missing-map", primitive: i, message: `Material "${m.name}" has some of its PBR maps but not ${missing.join(" or ")}.` });
    }
    if (m.normalImage && p.uvs && p.normals && !p.tangents) issues.push({ severity: "warning", code: "missing-tangents", primitive: i, message: `Part ${i + 1} has a normal map but no tangents: it decodes in a frame from its UVs, which bends at seams. Bake or import with MikkTSpace tangents.` });
    let largest = 0;
    let base = 0;
    for (const { slot, bytes } of maps) {
      const size = imageSize(bytes);
      if (!size) continue;
      const edge = Math.max(size.width, size.height);
      largest = Math.max(largest, edge);
      if (slot === "baseColorImage") base = edge;
      if (edge > maxSize) issues.push({ severity: "error", code: "texture-size", primitive: i, message: `Material "${m.name}"'s ${slot.replace("Image", "")} map is ${size.width}×${size.height}, over the ${maxSize} limit.` });
      if (!counted.has(bytes)) {
        counted.add(bytes);
        // RGBA8 with a full mip chain: 4 bytes a texel, a third more for the mips.
        textureBytes += size.width * size.height * 4 * (4 / 3);
      }
    }
    const mapSize = base || largest;
    if (mapSize > 0) {
      const d = texelDensity(p, mapSize);
      if (d) {
        if (d.density < target / tolerance) issues.push({ severity: "warning", code: "texel-density-low", primitive: i, message: `Part ${i + 1} gets ${Math.round(d.density)} texels a metre, under the ${target} aimed for: it will look soft beside other assets.` });
        if (d.density > target * tolerance) issues.push({ severity: "warning", code: "texel-density-high", primitive: i, message: `Part ${i + 1} gets ${Math.round(d.density)} texels a metre, over the ${target} aimed for: it spends memory no one sees.` });
        if (d.spread > 2.5) issues.push({ severity: "warning", code: "texel-density-uneven", primitive: i, message: `Part ${i + 1}'s texel density varies ${d.spread.toFixed(1)}× across its surface: some of it is stretched.` });
      }
    }
  });
  if (options.maxTriangles !== undefined && triangles > options.maxTriangles) issues.push({ severity: "error", code: "triangles", primitive: -1, message: `${triangles.toLocaleString()} triangles, over the budget of ${options.maxTriangles.toLocaleString()}.` });
  if (options.maxTextureBytes !== undefined && textureBytes > options.maxTextureBytes) issues.push({ severity: "error", code: "texture-memory", primitive: -1, message: `Its maps take ${(textureBytes / 1048576).toFixed(1)} MB uploaded, over the budget of ${(options.maxTextureBytes / 1048576).toFixed(1)} MB.` });
  return issues;
}
