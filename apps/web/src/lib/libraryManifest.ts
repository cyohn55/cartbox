/**
 * The contract for the in-editor **asset library**: a first-party, curated set
 * of ready-to-use game-dev assets (sprites, tiles, voxel sculpts, meshes) a
 * creator can drop into the cart they are editing.
 *
 * This is a deliberately separate subsystem from `assetSupply`/`assetVault`/
 * `assetManifest`. Those govern *user-supplied* game data for ported titles,
 * whose entire design is that we never distribute it. The library is the
 * opposite posture — we *are* the distributor — so two properties are
 * load-bearing here rather than incidental:
 *
 *   1. **Licence is gated, not annotated.** v1 admits public-domain assets only
 *      (see {@link ALLOWED_LICENSES}). An asset carrying any other licence is a
 *      validation error, not a warning, because shipping it would make the
 *      platform a distributor of rights-encumbered work.
 *   2. **Every asset carries its provenance.** Source, author, licence, and a
 *      link travel with the asset so the UI can credit it and the credit can be
 *      stamped into the cart on insert — the manifest is the single source of
 *      truth for "where did this come from".
 *
 * Pure and dependency-free: no DOM, no network, no Node built-ins. The manifest
 * arrives as untrusted JSON (served over HTTP, editable out-of-band), so parsing
 * is validating — {@link parseLibraryManifest} turns arbitrary input into a
 * typed manifest or a precise error, and never trusts the shape it was handed.
 */

/** Serialized-format version, bumped on any breaking schema change. */
export const LIBRARY_MANIFEST_VERSION = 1;

/**
 * The mediums the library can carry, matching the editor's asset mediums so an
 * entry maps to exactly one insert path (mesh sidecar, sprite/tile block, or
 * voxel sculpt).
 */
export const ASSET_KINDS = ["sprite", "tile", "voxel", "mesh"] as const;
export type LibraryAssetKind = (typeof ASSET_KINDS)[number];

/**
 * Licences the library is allowed to distribute in v1. Public-domain only: a
 * creator can use these assets in any cart, commercial or not, with no
 * attribution obligation we have to enforce. CC-BY and friends are intentionally
 * excluded until the UI can carry a binding attribution surface.
 */
export const ALLOWED_LICENSES = ["CC0-1.0", "public-domain"] as const;
export type LibraryLicense = (typeof ALLOWED_LICENSES)[number];

/** Where an asset came from — shown as a credit and stamped into the cart. */
export interface AssetProvenance {
  /** Originating collection or site, e.g. "Kenney" or "Poly Haven". */
  readonly source: string;
  /** Creator credit; the source itself when no individual is named. */
  readonly author: string;
  /** Distribution licence — constrained to {@link ALLOWED_LICENSES}. */
  readonly license: LibraryLicense;
  /** Canonical URL for the asset or its collection, for the credit link. */
  readonly url: string;
}

/**
 * One library entry. Geometry/pixels live at {@link payloadUrl} (an R2 object)
 * rather than inline, so listing the whole library stays cheap and a payload is
 * fetched only when a creator actually inserts it.
 */
export interface LibraryAsset {
  /** Stable unique id, also the R2 key stem. */
  readonly id: string;
  readonly name: string;
  readonly kind: LibraryAssetKind;
  /** Coarse grouping for browsing, e.g. "props", "characters", "tilesets". */
  readonly category: string;
  /** Free-form search terms; lowercased on parse for case-insensitive search. */
  readonly tags: readonly string[];
  /** URL of a small preview image. */
  readonly thumbnailUrl: string;
  /** URL of the asset payload (`.glb`, sprite sheet, `.vox`, …). */
  readonly payloadUrl: string;
  /** Payload size in bytes; lets the UI warn before a large fetch. */
  readonly sizeBytes: number;
  readonly provenance: AssetProvenance;
}

/** The whole catalog as served to the editor. */
export interface LibraryManifest {
  readonly version: number;
  readonly assets: readonly LibraryAsset[];
}

/** Raised when untrusted input cannot be read as a valid manifest. */
export class LibraryManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryManifestError";
  }
}

/** Narrow an unknown to a non-empty string, the manifest's atom of identity. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LibraryManifestError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new LibraryManifestError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/** A URL we are willing to fetch: http(s) or a same-origin absolute path. */
function requireFetchableUrl(value: unknown, field: string): string {
  const url = requireNonEmptyString(value, field);
  const isAbsolutePath = url.startsWith("/");
  const isHttp = /^https?:\/\//i.test(url);
  if (!isAbsolutePath && !isHttp) {
    throw new LibraryManifestError(`${field} must be an http(s) URL or an absolute path, got "${url}"`);
  }
  return url;
}

function parseProvenance(raw: unknown): AssetProvenance {
  if (raw === null || typeof raw !== "object") {
    throw new LibraryManifestError("asset.provenance must be an object");
  }
  const record = raw as Record<string, unknown>;
  return {
    source: requireNonEmptyString(record.source, "provenance.source"),
    author: requireNonEmptyString(record.author, "provenance.author"),
    license: requireOneOf(record.license, ALLOWED_LICENSES, "provenance.license"),
    url: requireFetchableUrl(record.url, "provenance.url"),
  };
}

function parseTags(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new LibraryManifestError("asset.tags must be an array of strings");
  }
  // Lowercase and de-duplicate so search never has to normalise at query time.
  const seen = new Set<string>();
  for (const tag of raw) {
    seen.add(requireNonEmptyString(tag, "asset.tags[]").toLowerCase());
  }
  return [...seen];
}

function parseAsset(raw: unknown): LibraryAsset {
  if (raw === null || typeof raw !== "object") {
    throw new LibraryManifestError("each asset must be an object");
  }
  const record = raw as Record<string, unknown>;
  const size = record.sizeBytes;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new LibraryManifestError("asset.sizeBytes must be a non-negative number");
  }
  return {
    id: requireNonEmptyString(record.id, "asset.id"),
    name: requireNonEmptyString(record.name, "asset.name"),
    kind: requireOneOf(record.kind, ASSET_KINDS, "asset.kind"),
    category: requireNonEmptyString(record.category, "asset.category"),
    tags: parseTags(record.tags),
    thumbnailUrl: requireFetchableUrl(record.thumbnailUrl, "asset.thumbnailUrl"),
    payloadUrl: requireFetchableUrl(record.payloadUrl, "asset.payloadUrl"),
    sizeBytes: size,
    provenance: parseProvenance(record.provenance),
  };
}

/**
 * Turn arbitrary input (parsed JSON, a hand-authored object, an API response)
 * into a validated {@link LibraryManifest}, or throw {@link LibraryManifestError}
 * naming the first problem. Ids must be unique because they double as R2 keys
 * and as React list keys — a collision would silently drop or overwrite an entry.
 */
export function parseLibraryManifest(raw: unknown): LibraryManifest {
  if (raw === null || typeof raw !== "object") {
    throw new LibraryManifestError("manifest must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== LIBRARY_MANIFEST_VERSION) {
    throw new LibraryManifestError(
      `unsupported manifest version ${String(record.version)}; expected ${LIBRARY_MANIFEST_VERSION}`,
    );
  }
  if (!Array.isArray(record.assets)) {
    throw new LibraryManifestError("manifest.assets must be an array");
  }

  const assets: LibraryAsset[] = [];
  const ids = new Set<string>();
  for (const rawAsset of record.assets) {
    const asset = parseAsset(rawAsset);
    if (ids.has(asset.id)) {
      throw new LibraryManifestError(`duplicate asset id "${asset.id}"`);
    }
    ids.add(asset.id);
    assets.push(asset);
  }
  return { version: LIBRARY_MANIFEST_VERSION, assets };
}

/**
 * A one-line credit for an asset, e.g. `"Barrel by Kenney (CC0-1.0)"`. Used both
 * in the browser UI and when stamping provenance into a cart on insert, so the
 * credit a creator sees is exactly the credit that ships.
 */
export function provenanceCredit(asset: LibraryAsset): string {
  const { author, source, license } = asset.provenance;
  const by = author === source ? source : `${author} (${source})`;
  return `${asset.name} by ${by} — ${license}`;
}
