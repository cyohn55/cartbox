/**
 * Ingest flow for user-supplied game data: hash → identify → store.
 *
 * Orchestrates assetManifest.ts (which release is this?) and assetVault.ts
 * (client-side storage) without knowing about either the DOM or the network.
 * The vault is injected, so this is exercised in tests against real bytes and a
 * real SHA-256 rather than a mock of the thing being tested.
 */

import {
  checkSupply,
  selectBestManifest,
  type AssetManifest,
  type SuppliedFile,
  type SupplyReport,
} from "./assetManifest";
import { sha256Hex, type AssetVault, type StoredAsset } from "./assetVault";

/** A file the player selected, before hashing. */
export interface CandidateFile {
  name: string;
  bytes: Uint8Array;
}

export interface IngestResult {
  report: SupplyReport;
  /** Files newly written to the vault this run. */
  stored: StoredAsset[];
  /**
   * Files the player supplied that belong to no supported release. Reported
   * rather than stored — selecting a whole game folder is normal, and silently
   * keeping unrecognised bytes would waste the player's storage.
   */
  ignored: SuppliedFile[];
}

/**
 * Hashes each candidate once and pairs it with its bytes.
 *
 * Hashing is the expensive step for game-sized data, so it happens exactly once
 * per file and the result is threaded through identification and storage.
 */
async function hashCandidates(
  candidates: readonly CandidateFile[],
): Promise<{ supplied: SuppliedFile; bytes: Uint8Array }[]> {
  return Promise.all(
    candidates.map(async (candidate) => ({
      supplied: {
        name: candidate.name,
        sizeBytes: candidate.bytes.byteLength,
        sha256: await sha256Hex(candidate.bytes),
      },
      bytes: candidate.bytes,
    })),
  );
}

/**
 * Identifies supplied files against a title's manifests and stores the ones
 * that belong to the best-matching release.
 *
 * Only identified files are persisted: the vault holds bytes we have positively
 * recognised, never an arbitrary folder the player happened to select.
 */
export async function ingestSuppliedFiles(
  titleId: string,
  candidates: readonly CandidateFile[],
  manifests: readonly AssetManifest[],
  vault: AssetVault,
): Promise<IngestResult | null> {
  const hashed = await hashCandidates(candidates);
  const report = selectBestManifest(
    hashed.map((entry) => entry.supplied),
    manifests,
  );
  if (!report) {
    return null;
  }

  // An unverified manifest must not gate real files in either direction: it
  // cannot confirm a match, so it must not store anything either.
  if (report.status === "unverified-manifest") {
    return { report, stored: [], ignored: hashed.map((entry) => entry.supplied) };
  }

  const wantedByHash = new Map(report.manifest.files.map((file) => [file.sha256, file]));
  const stored: StoredAsset[] = [];

  for (const { supplied, bytes } of hashed) {
    const wanted = wantedByHash.get(supplied.sha256);
    if (!wanted || wanted.sizeBytes !== supplied.sizeBytes) {
      continue;
    }
    // The manifest's path wins over the player's filename: the engine expects a
    // specific layout, and supplied names vary by installer and platform.
    const asset: StoredAsset = {
      path: wanted.path,
      sizeBytes: wanted.sizeBytes,
      sha256: wanted.sha256,
    };
    await vault.put(titleId, asset, bytes);
    stored.push(asset);
  }

  return {
    report,
    stored,
    ignored: report.unmatched,
  };
}

/**
 * Re-checks what is already in the vault against a title's manifests, without
 * re-reading file contents.
 *
 * Called on every visit to a Tier C title, so it must stay cheap: it trusts the
 * hashes recorded at ingest time rather than re-hashing gigabytes to prove the
 * browser did not corrupt its own storage.
 */
export async function reviewStoredAssets(
  titleId: string,
  manifests: readonly AssetManifest[],
  vault: AssetVault,
): Promise<SupplyReport | null> {
  const stored = await vault.list(titleId);
  const supplied: SuppliedFile[] = stored.map((asset) => ({
    name: asset.path,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
  }));
  return selectBestManifest(supplied, manifests);
}

/**
 * Whether the stored data is complete enough to launch.
 *
 * Deliberately strict: a partially supplied game boots and then fails somewhere
 * unpredictable, which reads to the player as a broken console rather than as
 * missing data.
 */
export function isPlayable(report: SupplyReport | null): boolean {
  return report?.status === "complete";
}

/** Re-checks one manifest directly, for callers that already know the release. */
export function reviewAgainstManifest(
  stored: readonly StoredAsset[],
  manifest: AssetManifest,
): SupplyReport {
  return checkSupply(
    stored.map((asset) => ({ name: asset.path, sizeBytes: asset.sizeBytes, sha256: asset.sha256 })),
    manifest,
  );
}
