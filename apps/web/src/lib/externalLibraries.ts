/**
 * CC0 libraries beyond the Cartbox catalogue (AAA_FIDELITY_ROADMAP.md F9f):
 * search Poly Haven and ambientCG from the editor and bring an asset into the
 * cart as the tier wants it.
 *
 * - **Search** goes to each library's public API (Poly Haven's
 *   `api.polyhaven.com/assets`, ambientCG's `api/v2/full_json`). Results
 *   become {@link ExternalAsset}s: a material, an HDRI or a mesh, with its
 *   provenance (source, authors, CC0, the asset's page), the same credit the
 *   Cartbox library stamps into a cart.
 * - **Import** fetches the files at the resolution asked:
 *   - a material's PNG maps become the engine's (base colour, the OpenGL
 *     normal map, roughness and ambient occlusion packed into the
 *     metal/roughness map's G and R as glTF keeps them, height as relief);
 *     ambientCG's come as a ZIP, read in place;
 *   - an HDRI becomes the sky's Radiance `.hdr` panorama;
 *   - a mesh is Poly Haven's glTF, its buffers and textures fetched beside it.
 *
 * Network and decoding are passed in (`fetchImpl`, the PNG codec), so all of
 * it runs, and is tested, without a browser or the network.
 */

import { decodePngRgba, encodeRgbaPng, parseGltf, type EncodedImage, type MeshAsset, type MeshMaterial } from "@cartbox/editor";

import type { AssetProvenance } from "./libraryManifest";
import { readZip } from "./zipReader";

export type ExternalSource = "polyhaven" | "ambientcg";
export type ExternalKind = "material" | "hdri" | "mesh";

export interface ExternalAsset {
  readonly id: string;
  readonly source: ExternalSource;
  readonly kind: ExternalKind;
  readonly name: string;
  readonly tags: readonly string[];
  readonly thumbnailUrl: string;
  readonly provenance: AssetProvenance;
  /** ambientCG: the download for each resolution (e.g. "1K-PNG" → its ZIP). */
  readonly downloads?: Readonly<Record<string, string>>;
}

/** Resolutions offered, smallest first; imports default to 1k. */
export const EXTERNAL_RESOLUTIONS = ["1k", "2k", "4k"] as const;
export type ExternalResolution = (typeof EXTERNAL_RESOLUTIONS)[number];

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

// --- Poly Haven ---------------------------------------------------------------

const POLY_TYPES: Record<ExternalKind, string> = { material: "textures", hdri: "hdris", mesh: "models" };

/** Poly Haven's listing URL for a kind. */
export function polyHavenListUrl(kind: ExternalKind): string {
  return `https://api.polyhaven.com/assets?t=${POLY_TYPES[kind]}`;
}

/** Poly Haven's listing (id → info) as assets, those matching `text` (name, tags, categories), sorted by name. */
export function parsePolyHaven(json: unknown, kind: ExternalKind, text = ""): ExternalAsset[] {
  if (!json || typeof json !== "object") return [];
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out: ExternalAsset[] = [];
  for (const [id, raw] of Object.entries(json as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" ? raw.name : id;
    const tags = [...(Array.isArray(raw.tags) ? raw.tags : []), ...(Array.isArray(raw.categories) ? raw.categories : [])].filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
    const hay = `${name.toLowerCase()} ${id} ${tags.join(" ")}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const authors = raw.authors && typeof raw.authors === "object" ? Object.keys(raw.authors as object) : [];
    out.push({
      id,
      source: "polyhaven",
      kind,
      name,
      tags,
      thumbnailUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256`,
      provenance: { source: "Poly Haven", author: authors.join(", ") || "Poly Haven", license: "CC0-1.0", url: `https://polyhaven.com/a/${id}` },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Poly Haven's files for an asset. */
export function polyHavenFilesUrl(id: string): string {
  return `https://api.polyhaven.com/files/${encodeURIComponent(id)}`;
}

type Files = Record<string, Record<string, Record<string, { url: string; include?: Record<string, { url: string }> }>>>;

/** The URL of one of Poly Haven's maps (by any of its names) at a resolution and format, or null. */
function polyFile(files: Files, names: readonly string[], resolution: string, format: string): string | null {
  for (const name of names) {
    const entry = files[name]?.[resolution]?.[format];
    if (entry?.url) return entry.url;
  }
  return null;
}

/** The maps a material import takes from Poly Haven's files (PNG): base colour, normal (OpenGL), roughness, AO, height. */
export function polyHavenMaterialMaps(files: unknown, resolution: ExternalResolution = "1k"): MaterialMapUrls {
  const f = files as Files;
  return {
    color: polyFile(f, ["Diffuse", "diff", "albedo", "Color"], resolution, "png"),
    normal: polyFile(f, ["nor_gl", "Normal"], resolution, "png"),
    roughness: polyFile(f, ["Rough", "rough", "Roughness"], resolution, "png"),
    occlusion: polyFile(f, ["AO", "ao"], resolution, "png"),
    height: polyFile(f, ["Displacement", "disp", "height"], resolution, "png"),
  };
}

// --- ambientCG ----------------------------------------------------------------

/** ambientCG's search URL (materials or HDRIs; it carries few meshes). */
export function ambientCgSearchUrl(text: string, kind: ExternalKind, offset = 0): string {
  const type = kind === "hdri" ? "HDRI" : "Material";
  return `https://ambientcg.com/api/v2/full_json?type=${type}&q=${encodeURIComponent(text)}&limit=30&offset=${offset}&include=downloadData,tagData,previewData`;
}

/** ambientCG's search results as assets. */
export function parseAmbientCg(json: unknown, kind: ExternalKind): ExternalAsset[] {
  const found = (json as { foundAssets?: unknown[] })?.foundAssets;
  if (!Array.isArray(found)) return [];
  return found.flatMap((raw) => {
    const a = raw as Record<string, unknown>;
    if (typeof a.assetId !== "string") return [];
    const downloads: Record<string, string> = {};
    const zip = (a.downloadFolders as { default?: { downloadFiletypeCategories?: { zip?: { downloads?: { attribute?: string; downloadLink?: string; fullDownloadPath?: string }[] } } } })?.default?.downloadFiletypeCategories?.zip?.downloads ?? [];
    for (const d of zip) {
      const link = d.fullDownloadPath ?? d.downloadLink;
      if (typeof d.attribute === "string" && typeof link === "string") downloads[d.attribute] = link;
    }
    const preview = (a.previewImage as Record<string, string> | undefined) ?? {};
    return [{
      id: a.assetId,
      source: "ambientcg" as const,
      kind,
      name: typeof a.displayName === "string" ? a.displayName : a.assetId,
      tags: (Array.isArray(a.tags) ? a.tags : []).filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()),
      thumbnailUrl: preview["256-PNG"] ?? preview["128-PNG"] ?? "",
      provenance: { source: "ambientCG", author: "ambientCG", license: "CC0-1.0" as const, url: `https://ambientcg.com/view?id=${encodeURIComponent(a.assetId)}` },
      downloads,
    }];
  });
}

/** Which of ambientCG's ZIP files is which map (by the suffix ambientCG names them with). */
export function ambientCgMaterialMaps(names: readonly string[]): Record<keyof MaterialMapUrls, string | null> {
  const find = (re: RegExp) => names.find((n) => re.test(n) && /\.png$/i.test(n)) ?? null;
  return {
    color: find(/_Color\./i),
    normal: find(/_NormalGL\./i),
    roughness: find(/_Roughness\./i),
    occlusion: find(/_AmbientOcclusion\./i),
    height: find(/_Displacement\./i),
  };
}

// --- Import -------------------------------------------------------------------

export interface MaterialMapUrls {
  readonly color: string | null;
  readonly normal: string | null;
  readonly roughness: string | null;
  readonly occlusion: string | null;
  readonly height: string | null;
}

const png = (bytes: Uint8Array): EncodedImage => ({ mime: "image/png", bytes });

/**
 * A material from its maps' bytes (PNG): base colour and normal as they are,
 * roughness into G and AO into R of the metal/roughness map (B, metalness, 0),
 * height into the relief map's R. Factors set so the maps rule.
 */
export async function materialFromMaps(name: string, maps: { color: Uint8Array | null; normal: Uint8Array | null; roughness: Uint8Array | null; occlusion: Uint8Array | null; height: Uint8Array | null }): Promise<MeshMaterial> {
  let metallicRoughnessImage: EncodedImage | null = null;
  if (maps.roughness) {
    const rough = await decodePngRgba(maps.roughness);
    const ao = maps.occlusion ? await decodePngRgba(maps.occlusion) : null;
    const packed = new Uint8ClampedArray(rough.width * rough.height * 4);
    for (let i = 0; i < rough.width * rough.height; i += 1) {
      // AO's R when it has the same size; else full.
      packed[i * 4] = ao && ao.width === rough.width && ao.height === rough.height ? ao.data[i * 4]! : 255;
      packed[i * 4 + 1] = rough.data[i * 4]!;
      packed[i * 4 + 2] = 0;
      packed[i * 4 + 3] = 255;
    }
    metallicRoughnessImage = png(encodeRgbaPng(packed, rough.width, rough.height));
  }
  return {
    name,
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: maps.color ? png(maps.color) : null,
    metallicFactor: 0,
    roughnessFactor: 1,
    ...(maps.normal ? { normalImage: png(maps.normal) } : {}),
    ...(metallicRoughnessImage ? { metallicRoughnessImage } : {}),
    ...(maps.occlusion && metallicRoughnessImage ? { occlusionImage: metallicRoughnessImage } : {}),
    ...(maps.height ? { reliefImage: png(maps.height), parallaxDepth: 0.02 } : {}),
  };
}

async function bytesOf(fetchImpl: Fetch, url: string): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Import a library material at a resolution. */
export async function importExternalMaterial(asset: ExternalAsset, fetchImpl: Fetch, resolution: ExternalResolution = "1k"): Promise<MeshMaterial> {
  if (asset.source === "polyhaven") {
    const files = await (await fetchImpl(polyHavenFilesUrl(asset.id))).json();
    const urls = polyHavenMaterialMaps(files, resolution);
    if (!urls.color) throw new Error(`“${asset.name}” has no ${resolution} PNG colour map`);
    const get = (u: string | null) => (u ? bytesOf(fetchImpl, u) : Promise.resolve(null));
    const [color, normal, roughness, occlusion, height] = await Promise.all([get(urls.color), get(urls.normal), get(urls.roughness), get(urls.occlusion), get(urls.height)]);
    return materialFromMaps(asset.name, { color, normal, roughness, occlusion, height });
  }
  const key = `${resolution.toUpperCase()}-PNG`;
  const url = asset.downloads?.[key];
  if (!url) throw new Error(`“${asset.name}” has no ${key} download`);
  const files = await readZip(await bytesOf(fetchImpl, url));
  const names = ambientCgMaterialMaps([...files.keys()]);
  const pick = (n: string | null) => (n ? (files.get(n) ?? null) : null);
  if (!names.color) throw new Error(`“${asset.name}” has no colour map in its download`);
  return materialFromMaps(asset.name, { color: pick(names.color), normal: pick(names.normal), roughness: pick(names.roughness), occlusion: pick(names.occlusion), height: pick(names.height) });
}

/** Import an HDRI as the sky's Radiance panorama (bytes, `image/vnd.radiance`). */
export async function importExternalHdri(asset: ExternalAsset, fetchImpl: Fetch, resolution: ExternalResolution = "1k"): Promise<{ mime: string; bytes: Uint8Array }> {
  if (asset.source === "polyhaven") {
    const files = (await (await fetchImpl(polyHavenFilesUrl(asset.id))).json()) as Files;
    const url = files.hdri?.[resolution]?.hdr?.url;
    if (!url) throw new Error(`“${asset.name}” has no ${resolution} .hdr`);
    return { mime: "image/vnd.radiance", bytes: await bytesOf(fetchImpl, url) };
  }
  const key = `${resolution.toUpperCase()}-HDR`;
  const url = asset.downloads?.[key];
  if (!url) throw new Error(`“${asset.name}” has no ${key} download`);
  const data = await bytesOf(fetchImpl, url);
  // ambientCG's HDRIs come as a ZIP holding the .hdr, or the .hdr itself.
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const files = await readZip(data);
    const name = [...files.keys()].find((n) => /\.hdr$/i.test(n));
    if (!name) throw new Error(`“${asset.name}”'s download has no .hdr`);
    return { mime: "image/vnd.radiance", bytes: files.get(name)! };
  }
  return { mime: "image/vnd.radiance", bytes: data };
}

/** Import a Poly Haven model: its glTF, with the buffers and textures it names fetched beside it. */
export async function importExternalMesh(asset: ExternalAsset, fetchImpl: Fetch, resolution: ExternalResolution = "1k"): Promise<MeshAsset> {
  if (asset.source !== "polyhaven") throw new Error("Only Poly Haven's models can be imported");
  const files = (await (await fetchImpl(polyHavenFilesUrl(asset.id))).json()) as Files;
  const entry = files.gltf?.[resolution]?.gltf;
  if (!entry?.url) throw new Error(`“${asset.name}” has no ${resolution} glTF`);
  const json = JSON.parse(new TextDecoder().decode(await bytesOf(fetchImpl, entry.url)));
  const include = entry.include ?? {};
  const fetchRelative = async (uri: string) => {
    const known = include[uri]?.url;
    return bytesOf(fetchImpl, known ?? new URL(uri, entry.url).toString());
  };
  const buffers = await Promise.all((json.buffers ?? []).map((b: { uri?: string }) => (b.uri ? fetchRelative(b.uri) : Promise.resolve(null))));
  // Images by URI become embedded, so the mesh carries them.
  for (const image of json.images ?? []) {
    if (typeof image.uri === "string" && !image.uri.startsWith("data:")) {
      const bytes = await fetchRelative(image.uri);
      const mime = /\.png$/i.test(image.uri) ? "image/png" : "image/jpeg";
      image.uri = `data:${mime};base64,${btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(""))}`;
    }
  }
  return parseGltf(json, buffers.map((b: Uint8Array | null) => b), asset.name);
}

/** Search a library for a kind (ambientCG has no meshes worth importing; it's skipped for them). */
export async function searchExternal(source: ExternalSource, kind: ExternalKind, text: string, fetchImpl: Fetch): Promise<ExternalAsset[]> {
  if (source === "polyhaven") return parsePolyHaven(await (await fetchImpl(polyHavenListUrl(kind))).json(), kind, text);
  if (kind === "mesh") return [];
  return parseAmbientCg(await (await fetchImpl(ambientCgSearchUrl(text, kind))).json(), kind);
}

/** The credit stamped into a cart for an imported asset. */
export function externalCredit(asset: ExternalAsset): string {
  return `“${asset.name}” by ${asset.provenance.author} (${asset.provenance.source}, CC0) — ${asset.provenance.url}`;
}
