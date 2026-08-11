/**
 * The pure core of the asset-library ingestion pipeline: turn a set of source
 * descriptors into a validated {@link LibraryManifest}, deriving each asset's
 * payload and thumbnail URLs from one base URL.
 *
 * Kept free of I/O so the build script can be tested against plain data: the
 * script fetches/converts/uploads and computes a base URL (a same-origin path in
 * local mode, or the R2 public base in production), then hands the descriptors
 * here. Routing the result through {@link parseLibraryManifest} means the
 * pipeline can only ever emit a manifest the runtime will accept — a bad source
 * fails the build instead of shipping a broken catalogue.
 */

import {
  parseLibraryManifest,
  type LibraryAssetKind,
  type LibraryLicense,
  type LibraryManifest,
} from "./libraryManifest";

/** One asset the pipeline was asked to publish, before URLs are resolved. */
export interface LibrarySource {
  readonly id: string;
  readonly name: string;
  readonly kind: LibraryAssetKind;
  readonly category: string;
  readonly tags: readonly string[];
  /** Payload file's basename within its medium directory, e.g. `barrel.glb`. */
  readonly payloadFile: string;
  /** Thumbnail file's basename within the thumbs directory, e.g. `barrel.png`. */
  readonly thumbnailFile: string;
  readonly sizeBytes: number;
  readonly provenance: {
    readonly source: string;
    readonly author: string;
    readonly license: LibraryLicense;
    readonly url: string;
  };
}

/** The `library/…` sub-directory each medium's payloads live under. */
export function payloadDirForKind(kind: LibraryAssetKind): string {
  switch (kind) {
    case "mesh":
      return "meshes";
    case "voxel":
      return "voxels";
    case "sprite":
    case "tile":
      return "sprites";
  }
}

/**
 * Normalise a base URL to a prefix that joins cleanly with `/library/…`. An
 * empty base yields same-origin absolute paths (local mode); a host or CDN base
 * keeps its origin and drops any trailing slash so URLs never double up.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Public URL of a source's payload under a given base. */
export function payloadUrlFor(baseUrl: string, source: LibrarySource): string {
  return `${normalizeBaseUrl(baseUrl)}/library/${payloadDirForKind(source.kind)}/${source.payloadFile}`;
}

/** Public URL of a source's thumbnail under a given base. */
export function thumbnailUrlFor(baseUrl: string, source: LibrarySource): string {
  return `${normalizeBaseUrl(baseUrl)}/library/thumbs/${source.thumbnailFile}`;
}

/**
 * Assemble and validate a manifest from sources. `baseUrl` prefixes every
 * payload and thumbnail URL — `""` for local same-origin serving, or the R2
 * public base in production. Throws (via {@link parseLibraryManifest}) if any
 * source is malformed or two share an id.
 */
export function assembleManifest(sources: readonly LibrarySource[], baseUrl: string): LibraryManifest {
  return parseLibraryManifest({
    version: 1,
    assets: sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      category: source.category,
      tags: source.tags,
      thumbnailUrl: thumbnailUrlFor(baseUrl, source),
      payloadUrl: payloadUrlFor(baseUrl, source),
      sizeBytes: source.sizeBytes,
      provenance: source.provenance,
    })),
  });
}
