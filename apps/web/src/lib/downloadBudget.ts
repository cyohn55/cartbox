/**
 * What a cart costs to download (ENGINE_ROADMAP.md, Phase 4): the pieces a
 * player's browser fetches before the cart runs, measured as they travel
 * (gzip-compressed, as the server sends them), with load-time estimates on
 * typical connections and tips on what would shrink it.
 *
 * - The engine core for the cart's console model (a fixed size per model).
 * - The cartridge itself: code, sprites, map, sound.
 * - The 3D scene (the mesh sidecar), broken down into geometry, textures and
 *   animation so the heavy part is obvious.
 * - The physics engine, fetched only for scenes with bodies (a larger build when
 *   deterministic physics is on).
 * - The KTX2 texture transcoder, fetched only for scenes that keep KTX2 textures.
 * - The rest of the editor-made data (voxels, backdrops, particles…).
 * - Uploaded files, as stored (already-compressed formats don't shrink).
 *
 * The Cartbox player itself is shared by every cart (and cached), so it isn't
 * counted. Pure apart from gzip, which uses the platform's CompressionStream.
 */

import type { ConsoleModelId } from "@cartbox/editor";

/**
 * Gzipped engine core (JS + WASM) per console model, measured from the builds in
 * packages/engine/dist — a test checks these stay within a few percent.
 */
export const ENGINE_TRANSFER_BYTES: Readonly<Record<ConsoleModelId, number>> = {
  classic: 421_990,
  voxel: 421_990,
  pro: 422_177,
  portrait: 422_189,
  ps1: 422_915,
  n64: 422_915,
  xbox360: 422_860,
  modern: 422_860,
};

/** Gzipped Rapier builds (the WASM is inlined in the module), checked by a test. */
export const PHYSICS_TRANSFER_BYTES = { regular: 1_655_409, deterministic: 1_662_010 } as const;

/** Gzipped size of the vendored Basis Universal transcoder (JS + WASM), checked by a test. */
export const KTX2_TRANSCODER_TRANSFER_BYTES = 260_481;

/** Typical connections: effective throughput and a round-trip for the requests. */
export const CONNECTIONS = [
  { name: "Slow 4G", mbps: 1.6, rttMs: 400 },
  { name: "4G", mbps: 9, rttMs: 170 },
  { name: "Broadband", mbps: 50, rttMs: 40 },
] as const;

/** Under this the cart feels instant on most connections; over the second it's heavy for mobile. */
export const BUDGET_LIGHT_BYTES = 3 * 1024 * 1024;
export const BUDGET_HEAVY_BYTES = 12 * 1024 * 1024;

export interface BudgetItem {
  readonly key: "engine" | "cartridge" | "scene" | "physics" | "transcoder" | "data" | "files";
  readonly label: string;
  /** Bytes as transferred. */
  readonly bytes: number;
  readonly note?: string;
}

export interface SceneBreakdown {
  /** Raw (uncompressed) bytes by kind. */
  readonly geometry: number;
  readonly textures: number;
  readonly animation: number;
  readonly other: number;
  /** The heaviest distinct meshes by raw bytes. */
  readonly heaviest: readonly { readonly name: string; readonly bytes: number }[];
}

export interface DownloadBudget {
  readonly items: readonly BudgetItem[];
  readonly total: number;
  /**
   * Bytes before the cart can start: everything but the 3D scene's textures,
   * which a published cart streams in once it's running (see textureStream.ts).
   */
  readonly playable: number;
  readonly scene: SceneBreakdown | null;
  readonly loadSeconds: readonly { readonly name: string; readonly seconds: number }[];
  readonly rating: "light" | "medium" | "heavy";
  readonly tips: readonly string[];
}

export interface BudgetInput {
  readonly modelId: ConsoleModelId;
  /** The saved cartridge bytes, if known. */
  readonly cartridge: Uint8Array | null;
  /** The mesh sidecar as stored, or null. */
  readonly meshSidecar: string | null;
  /** Every other editor sidecar value (serialized as stored). */
  readonly otherData: readonly unknown[];
  /** Uploaded files' total bytes. */
  readonly uploadedBytes: number;
}

/** Gzipped size of some bytes (falls back to an estimate where CompressionStream is missing). */
export async function gzipSize(data: Uint8Array | string): Promise<number> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.length === 0) return 0;
  if (typeof CompressionStream === "undefined") return Math.round(bytes.length * 0.75);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
}

/**
 * How a stored mesh sidecar's bytes split between geometry, textures, animation
 * and everything else, and its heaviest meshes. Works on the raw JSON (meshes are
 * base64 inside JSON strings), so it costs a parse, not a decode.
 */
export function sceneBreakdown(meshSidecar: string | null): SceneBreakdown | null {
  if (!meshSidecar) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(meshSidecar);
  } catch {
    return null;
  }
  const root = parsed as { meshes?: { name?: unknown; mesh?: unknown }[]; library?: Record<string, unknown>; prefabs?: { nodes?: { name?: unknown; mesh?: unknown }[] }[] };
  let geometry = 0;
  let textures = 0;
  let animation = 0;
  const sized = new Map<string, { name: string; bytes: number }>();
  const measureMesh = (serialized: string, name: string) => {
    if (sized.has(serialized)) return;
    let mesh: Record<string, unknown>;
    try {
      mesh = JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      return;
    }
    const len = (v: unknown) => (typeof v === "string" ? v.length : 0);
    for (const p of (mesh.primitives as Record<string, unknown>[] | undefined) ?? []) {
      geometry += len(p.positions) + len(p.normals) + len(p.uvs) + len(p.indices) + len(p.joints) + len(p.weights);
      const m = (p.material ?? {}) as Record<string, unknown>;
      for (const key of ["image", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage"]) {
        textures += len((m[key] as { bytes?: unknown } | null | undefined)?.bytes);
      }
    }
    const skin = mesh.skin as { inverseBind?: unknown } | undefined;
    animation += len(skin?.inverseBind);
    for (const clip of (mesh.clips as { channels?: { times?: unknown; values?: unknown }[] }[] | undefined) ?? []) {
      for (const c of clip.channels ?? []) animation += len(c.times) + len(c.values);
    }
    sized.set(serialized, { name, bytes: serialized.length });
  };
  const library = root.library ?? {};
  const resolve = (ref: unknown): string | null => {
    if (typeof ref !== "string") return null;
    if (ref.startsWith("@lib:")) {
      const hit = library[ref.slice(5)];
      return typeof hit === "string" ? hit : null;
    }
    return ref;
  };
  const visit = (entry: { name?: unknown; mesh?: unknown }) => {
    const serialized = resolve(entry.mesh);
    if (serialized) measureMesh(serialized, typeof entry.name === "string" ? entry.name : "mesh");
  };
  for (const entry of root.meshes ?? []) visit(entry);
  for (const prefab of root.prefabs ?? []) for (const node of prefab.nodes ?? []) visit(node);
  const other = Math.max(0, meshSidecar.length - geometry - textures - animation);
  const heaviest = [...sized.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  return { geometry, textures, animation, other, heaviest };
}

/** Whether a stored mesh sidecar has physics bodies (anywhere) and asks for deterministic physics. */
function physicsNeeds(meshSidecar: string | null): { bodies: boolean; deterministic: boolean } {
  if (!meshSidecar) return { bodies: false, deterministic: false };
  // A cheap textual check keeps this from decoding every mesh: bodies are the only
  // place a `"physics":{"body"` appears.
  const bodies = /"physics":\{"body"/.test(meshSidecar);
  return { bodies, deterministic: bodies && /"physicsWorld":\{"deterministic":true/.test(meshSidecar) };
}

/** Seconds to fetch `bytes` on a connection (a handful of round trips, then the transfer). */
export function loadSeconds(bytes: number, connection: { mbps: number; rttMs: number }, requests = 4): number {
  return (requests * connection.rttMs) / 1000 + (bytes * 8) / (connection.mbps * 1_000_000);
}

export async function measureDownload(input: BudgetInput): Promise<DownloadBudget> {
  const scene = sceneBreakdown(input.meshSidecar);
  const physics = physicsNeeds(input.meshSidecar);
  const others = input.otherData.filter((v) => v !== null && v !== undefined);
  const items: BudgetItem[] = [
    { key: "engine", label: "Engine core", bytes: ENGINE_TRANSFER_BYTES[input.modelId] ?? ENGINE_TRANSFER_BYTES.classic, note: `for the ${input.modelId} model` },
    { key: "cartridge", label: "Cartridge", bytes: input.cartridge ? await gzipSize(input.cartridge) : 0, note: "code, sprites, map, sound" },
  ];
  if (input.meshSidecar) items.push({ key: "scene", label: "3D scene", bytes: await gzipSize(input.meshSidecar), note: "meshes, textures, animation" });
  if (physics.bodies)
    items.push({
      key: "physics",
      label: "Physics engine",
      bytes: physics.deterministic ? PHYSICS_TRANSFER_BYTES.deterministic : PHYSICS_TRANSFER_BYTES.regular,
      note: physics.deterministic ? "deterministic build" : "only for scenes with bodies",
    });
  if (input.meshSidecar?.includes('"mime":"image/ktx2"'))
    items.push({ key: "transcoder", label: "Texture transcoder", bytes: KTX2_TRANSCODER_TRANSFER_BYTES, note: "for KTX2 textures" });
  if (others.length > 0) items.push({ key: "data", label: "Other editor data", bytes: await gzipSize(JSON.stringify(others)), note: "voxels, backdrops, effects…" });
  if (input.uploadedBytes > 0) items.push({ key: "files", label: "Uploaded files", bytes: input.uploadedBytes, note: "as stored" });
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  const rating = total <= BUDGET_LIGHT_BYTES ? "light" : total <= BUDGET_HEAVY_BYTES ? "medium" : "heavy";

  const tips: string[] = [];
  const sceneItem = items.find((i) => i.key === "scene");
  if (scene && sceneItem && sceneItem.bytes > 512 * 1024) {
    const raw = scene.geometry + scene.textures + scene.animation + scene.other;
    if (scene.textures > raw * 0.5) tips.push("Textures are most of the 3D scene: smaller or fewer texture maps (or JPEG for photos) would cut it most.");
    else if (scene.geometry > raw * 0.5) tips.push("Geometry is most of the 3D scene: simplify dense meshes (decimate in your modelling tool) before importing.");
    if (scene.animation > raw * 0.3) tips.push("Animation clips are a large share: trim unused clips or bake them at a lower key rate.");
    if (scene.heaviest[0]) tips.push(`The heaviest mesh is “${scene.heaviest[0].name}”.`);
  }
  if (physics.bodies && total > BUDGET_LIGHT_BYTES) tips.push("The physics engine alone is about 1.6 MB — it's only fetched because objects have bodies.");
  if (input.uploadedBytes > 2 * 1024 * 1024) tips.push("Uploaded files are large: compress audio and images before uploading.");
  // The textures' share of the scene as sent, estimated from their share of it raw.
  const sceneRaw = scene ? scene.geometry + scene.textures + scene.animation + scene.other : 0;
  const streamed = sceneItem && scene && sceneRaw > 0 ? Math.round(sceneItem.bytes * (scene.textures / sceneRaw)) : 0;
  return {
    items,
    total,
    playable: total - streamed,
    scene,
    loadSeconds: CONNECTIONS.map((c) => ({ name: c.name, seconds: loadSeconds(total, c, items.length) })),
    rating,
    tips,
  };
}
