/**
 * Supported-release manifests for Tier C titles.
 *
 * IMPORTANT — these are authored from real files, never guessed. A manifest with
 * invented hashes would reject every correct file the player supplies while
 * looking authoritative, so unrecorded entries carry PLACEHOLDER_HASH and
 * `isManifestPublishable` keeps them from gating anything.
 *
 * The OpenMW entry below is a shape example with its hashes deliberately
 * unrecorded: nobody has hashed a genuine Morrowind install for this catalog
 * yet. It renders as "release not verified yet" and accepts no files until the
 * real digests are filled in.
 */

import { PLACEHOLDER_HASH, type AssetManifest } from "./assetManifest";

/** Manifests keyed by title id. A title may support several releases. */
const MANIFESTS_BY_TITLE: Record<string, readonly AssetManifest[]> = {
  // OpenMW — Morrowind game data. Paths follow the layout OpenMW expects.
  "00000000-0000-4000-9000-000000000003": [
    {
      titleId: "00000000-0000-4000-9000-000000000003",
      releaseLabel: "Morrowind — Game of the Year Edition (GOG)",
      files: [
        { path: "Data Files/Morrowind.esm", sizeBytes: 0, sha256: PLACEHOLDER_HASH },
        { path: "Data Files/Tribunal.esm", sizeBytes: 0, sha256: PLACEHOLDER_HASH },
        { path: "Data Files/Bloodmoon.esm", sizeBytes: 0, sha256: PLACEHOLDER_HASH },
      ],
    },
  ],
};

export function manifestsForTitle(titleId: string): readonly AssetManifest[] {
  return MANIFESTS_BY_TITLE[titleId] ?? [];
}
