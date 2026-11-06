/**
 * The player fetching a cart's mesh packages itself (AAA_PRODUCTION_ROADMAP.md
 * D5, after D4's packages).
 *
 * A saved scene keeps each large mesh as a package in the cart asset store
 * (`@pkg:<hash>`: meshoptimizer-compressed binary, content-addressed and so
 * cached by the CDN for good). The play page used to fetch every package on
 * the server and rebuild its JSON there, so the page carried the whole scene
 * as JSON. Now it hands the client the packages' URLs, and the client fetches
 * them in parallel from the CDN, checks each against its hash, decodes it and
 * parses the scene, on a worker where it can (M4), handing the parsed scene's
 * buffers back rather than copying them.
 *
 * Best effort, object by object: a package that can't be fetched, doesn't
 * match its hash or can't be decoded leaves its reference, which the scene's
 * reader drops, so it costs its objects, never the cart. Without a worker (or
 * when one fails) the same work runs on the page's thread.
 *
 * The scene's streamed textures are listed here too (`streamedMeshTextures`),
 * the same way on the server (for a scene without packages) and on the client
 * (once its packages are in, since a packaged mesh's textures are only visible
 * then).
 */

import type { MeshScene } from "@cartbox/player";

import { inlineMeshPackages, meshPackageRefs } from "./meshPackages";
import { meshTextureLevels, meshTextureObjects, meshTextureRefs } from "./meshTextureAssets";
import { sha256Hex } from "./sha256";
import type { StreamedTexture } from "./textureStream";
import type { MeshoptCodec } from "@cartbox/editor";

/** A package the scene references, and where its bytes are. */
export interface MeshPackageSource {
  readonly hash: string;
  readonly url: string;
  /** Its size, if the manifest knows it (0 otherwise). */
  readonly bytes: number;
}

/** How the client reaches the cart's assets: a URL prefix (the hash follows it) and the sizes the manifest records, by hash. */
export interface MeshAssetLinks {
  readonly base: string;
  readonly sizes: Readonly<Record<string, number>>;
}

/** The scene's textures kept in the asset store, as the stream fetches them: when each is needed, and its size. */
export function streamedMeshTextures(meshRaw: string | null, sizeOf: (hash: string) => number, urlOf: (hash: string) => string): StreamedTexture[] {
  const refs = meshTextureRefs(meshRaw);
  if (refs.length === 0) return [];
  // Textures only later levels use wait for those levels (cartbox.level)…
  const needs = meshTextureLevels(meshRaw);
  // …and textures only spatially loaded objects use wait for the focus to near them.
  const near = meshTextureObjects(meshRaw);
  return refs.map(({ hash, mime }) => {
    const levels = needs.get(hash);
    const objects = near.get(hash);
    return { hash, mime, bytes: sizeOf(hash), url: urlOf(hash), ...(levels ? { levels } : {}), ...(objects ? { objects } : {}) };
  });
}

export interface PackagedSidecar {
  /** The sidecar with every package that arrived put back as JSON. */
  readonly json: string;
  /** Packages still referenced: not fetched, not matching their hash, or unreadable. */
  readonly missing: readonly string[];
}

/**
 * Fetch the packages (all at once, at most `concurrency` in flight), check each
 * against its hash, and put them back into the sidecar as JSON.
 */
export async function fetchPackagedSidecar(
  meshRaw: string,
  packages: readonly MeshPackageSource[],
  { fetchFn = fetch, codec, concurrency = 6 }: { fetchFn?: typeof fetch; codec: MeshoptCodec | null; concurrency?: number },
): Promise<PackagedSidecar> {
  const wanted = new Set(meshPackageRefs(meshRaw));
  const sources = packages.filter((p) => wanted.has(p.hash));
  const bytes = new Map<string, Uint8Array | null>();
  let next = 0;
  const one = async (source: MeshPackageSource) => {
    try {
      const response = await fetchFn(source.url);
      if (!response.ok) throw new Error(String(response.status));
      const got = new Uint8Array(await response.arrayBuffer());
      // Content-addressed: bytes that don't hash to their name aren't the package.
      bytes.set(source.hash, (await sha256Hex(got)) === source.hash ? got : null);
    } catch {
      bytes.set(source.hash, null);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
      while (next < sources.length) await one(sources[next++]!);
    }),
  );
  const json = await inlineMeshPackages(meshRaw, async (hash) => bytes.get(hash) ?? null, codec);
  return { json, missing: meshPackageRefs(json) };
}

/** What the package worker is asked, and what it answers. */
export interface PackageRequest {
  readonly meshRaw: string;
  readonly packages: readonly MeshPackageSource[];
}
export type PackageReply = (PackagedSidecar & { readonly scene: MeshScene | null }) | { readonly error: string };

/** The part of a Worker this needs (so tests can hand in their own). */
export interface PackageWorker {
  postMessage(message: PackageRequest): void;
  terminate(): void;
  onmessage: ((event: { data: PackageReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface LoadedSidecar extends PackagedSidecar {
  /** The scene parsed, when a worker did it (the page then skips its own parse); absent from a load on this thread. */
  readonly scene?: MeshScene | null;
  /** Where it ran. */
  readonly where: "worker" | "here";
}

/**
 * A cart's sidecar with its packages in: on a worker when `makeWorker` gives
 * one (fetched, decoded and parsed there), else, or when the worker fails, on
 * this thread with `here`.
 */
export async function loadPackagedSidecar({
  meshRaw,
  packages,
  makeWorker,
  here,
}: {
  meshRaw: string;
  packages: readonly MeshPackageSource[];
  makeWorker: (() => PackageWorker) | null;
  here: (meshRaw: string, packages: readonly MeshPackageSource[]) => Promise<PackagedSidecar>;
}): Promise<LoadedSidecar> {
  if (makeWorker) {
    try {
      const reply = await new Promise<PackageReply>((resolve, reject) => {
        const worker = makeWorker();
        worker.onmessage = (event) => {
          worker.terminate();
          resolve(event.data);
        };
        worker.onerror = (event) => {
          worker.terminate();
          reject(event instanceof Error ? event : new Error("package worker failed"));
        };
        worker.postMessage({ meshRaw, packages });
      });
      if (!("error" in reply)) return { json: reply.json, missing: reply.missing, scene: reply.scene, where: "worker" };
    } catch {
      // Falls through to this thread.
    }
  }
  return { ...(await here(meshRaw, packages)), where: "here" };
}
