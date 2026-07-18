/**
 * Asset manifests for user-supplied (Tier C) titles.
 *
 * A Tier C title ships the engine only; the player supplies their own copy of
 * the game data. A manifest describes exactly which files a supported release
 * consists of, so "wrong file" becomes a precise, actionable message before the
 * engine boots rather than an obscure crash halfway through loading.
 *
 * Pure: no storage, no crypto, no DOM. Hashing lives in assetVault.ts and the
 * bytes never leave the browser — see that module for why that separation is
 * load-bearing rather than stylistic.
 */

/** One file a release requires, identified by content hash rather than name. */
export interface ManifestFile {
  /** Path the engine expects, relative to the game's data root. */
  path: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: string;
}

/**
 * One supported release of a title. A game reissued on GOG, on CD, and in a
 * localised edition has genuinely different bytes, so a title carries several
 * manifests and the supplied files decide which one is in play.
 */
export interface AssetManifest {
  titleId: string;
  /** Human-readable release name, shown when asking for files. */
  releaseLabel: string;
  files: readonly ManifestFile[];
}

/** A file the player has selected, already hashed. */
export interface SuppliedFile {
  name: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Marker for a manifest entry whose real hash has not been recorded yet.
 *
 * Manifests must be authored from genuine files. Seeding one with invented
 * hashes would produce a manifest that silently rejects every correct file, so
 * unrecorded entries are marked explicitly and `isManifestPublishable` keeps
 * them out of production.
 */
export const PLACEHOLDER_HASH = "PLACEHOLDER";

export function isPlaceholder(file: ManifestFile): boolean {
  return file.sha256 === PLACEHOLDER_HASH;
}

/**
 * Whether a manifest is complete enough to gate real uploads. A manifest with
 * unrecorded hashes can be displayed ("this release is not verified yet") but
 * must never be used to accept or reject a player's files.
 */
export function isManifestPublishable(manifest: AssetManifest): boolean {
  return manifest.files.length > 0 && !manifest.files.some(isPlaceholder);
}

export type SupplyStatus = "complete" | "incomplete" | "unverified-manifest";

export interface SupplyReport {
  status: SupplyStatus;
  manifest: AssetManifest;
  /** Manifest files matched by a supplied file, in manifest order. */
  matched: ManifestFile[];
  /** Manifest files still needed. */
  missing: ManifestFile[];
  /**
   * Supplied files that matched nothing in the manifest. Not an error on its
   * own — players routinely select a whole folder — but surfacing them explains
   * why a file the player "already added" is not counted.
   */
  unmatched: SuppliedFile[];
}

/**
 * Checks supplied files against one release manifest.
 *
 * Matching is by content hash alone. Filenames vary across releases, installers
 * and operating systems, so a name-based match would reject correct data and
 * accept incorrect data — the exact failure this module exists to prevent.
 */
export function checkSupply(
  supplied: readonly SuppliedFile[],
  manifest: AssetManifest,
): SupplyReport {
  if (!isManifestPublishable(manifest)) {
    return {
      status: "unverified-manifest",
      manifest,
      matched: [],
      missing: [...manifest.files],
      unmatched: [...supplied],
    };
  }

  const suppliedByHash = new Map(supplied.map((file) => [file.sha256, file]));
  const matched: ManifestFile[] = [];
  const missing: ManifestFile[] = [];

  for (const file of manifest.files) {
    // Size is checked alongside the hash so a truncated file that somehow
    // collides is still rejected; the hash is what actually identifies it.
    const candidate = suppliedByHash.get(file.sha256);
    if (candidate && candidate.sizeBytes === file.sizeBytes) {
      matched.push(file);
    } else {
      missing.push(file);
    }
  }

  const manifestHashes = new Set(manifest.files.map((file) => file.sha256));
  const unmatched = supplied.filter((file) => !manifestHashes.has(file.sha256));

  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    manifest,
    matched,
    missing,
    unmatched,
  };
}

/**
 * Picks the release the player most likely owns, then reports against it.
 *
 * Ranking by matched-file count rather than first-match means a player holding
 * the GOG release is told what the *GOG* release still needs, instead of being
 * measured against an unrelated edition. Ties keep manifest order, so the
 * canonical release stays the default when nothing distinguishes them.
 */
export function selectBestManifest(
  supplied: readonly SuppliedFile[],
  manifests: readonly AssetManifest[],
): SupplyReport | null {
  if (manifests.length === 0) {
    return null;
  }

  let best: SupplyReport | null = null;
  for (const manifest of manifests) {
    const report = checkSupply(supplied, manifest);
    if (!best || report.matched.length > best.matched.length) {
      best = report;
    }
  }
  return best;
}

/** Total bytes a release requires — used to warn before the browser refuses. */
export function manifestSizeBytes(manifest: AssetManifest): number {
  return manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
}
