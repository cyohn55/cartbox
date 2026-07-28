/**
 * Unit tests for the user-supplied asset pipeline (Browse Phase 3):
 *   - manifest matching by content hash, across multiple supported releases
 *   - the ingest flow: hash → identify → store
 *   - vault isolation, which is the platform's legal posture in code form
 *
 * Hashes are computed from real bytes with the platform's WebCrypto rather than
 * pasted in, so the tests exercise the same identification path the browser
 * does. Storage runs against InMemoryAssetVault, which mirrors the OPFS
 * implementation's contract.
 *
 * Run with: npx vitest run "Unit Tests/asset-supply.test.ts"
 */

import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_HASH,
  checkSupply,
  isManifestPublishable,
  isPlaceholder,
  manifestSizeBytes,
  selectBestManifest,
  type AssetManifest,
  type SuppliedFile,
} from "../apps/web/src/lib/assetManifest";
import {
  ingestSuppliedFiles,
  isPlayable,
  reviewAgainstManifest,
  reviewStoredAssets,
  type CandidateFile,
} from "../apps/web/src/lib/assetSupply";
import {
  InMemoryAssetVault,
  VaultQuotaError,
  sha256Hex,
} from "../apps/web/src/lib/assetVault";
import { manifestsForTitle } from "../apps/web/src/lib/titleManifests";
import { DEMO_TITLES } from "../apps/web/src/lib/demoTitles";

const TITLE_ID = "title-under-test";

/** Deterministic, distinguishable bytes — not random, so failures reproduce. */
function bytesFor(seed: string, length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (seed.charCodeAt(index % seed.length) + index) % 256;
  }
  return bytes;
}

/** Builds a manifest whose hashes are the real digests of the given payloads. */
async function manifestFrom(
  releaseLabel: string,
  payloads: readonly { path: string; bytes: Uint8Array }[],
): Promise<AssetManifest> {
  return {
    titleId: TITLE_ID,
    releaseLabel,
    files: await Promise.all(
      payloads.map(async (payload) => ({
        path: payload.path,
        sizeBytes: payload.bytes.byteLength,
        sha256: await sha256Hex(payload.bytes),
      })),
    ),
  };
}

async function suppliedFrom(name: string, bytes: Uint8Array): Promise<SuppliedFile> {
  return { name, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

const CORE = { path: "Data Files/core.esm", bytes: bytesFor("core") };
const EXPANSION = { path: "Data Files/expansion.esm", bytes: bytesFor("expansion") };
const LOCALISED_CORE = { path: "Data Files/core.esm", bytes: bytesFor("core-de") };

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("produces a 64-character lowercase hex digest", async () => {
    const digest = await sha256Hex(bytesFor("anything"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical bytes and differs for different bytes", async () => {
    const [first, again, other] = await Promise.all([
      sha256Hex(bytesFor("same")),
      sha256Hex(bytesFor("same")),
      sha256Hex(bytesFor("different")),
    ]);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
  });

  it("detects a single flipped byte", async () => {
    const original = bytesFor("payload");
    const tampered = Uint8Array.from(original);
    tampered[0] ^= 0xff;
    expect(await sha256Hex(original)).not.toBe(await sha256Hex(tampered));
  });
});

// ---------------------------------------------------------------------------
// Manifest matching
// ---------------------------------------------------------------------------

describe("checkSupply", () => {
  it("reports a release as complete when every file is present", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE, EXPANSION]);
    const supplied = await Promise.all([
      suppliedFrom("core.esm", CORE.bytes),
      suppliedFrom("expansion.esm", EXPANSION.bytes),
    ]);

    const report = checkSupply(supplied, manifest);

    expect(report.status).toBe("complete");
    expect(report.missing).toEqual([]);
    expect(report.matched).toHaveLength(manifest.files.length);
  });

  it("names exactly which files are still needed", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE, EXPANSION]);
    const supplied = [await suppliedFrom("core.esm", CORE.bytes)];

    const report = checkSupply(supplied, manifest);

    expect(report.status).toBe("incomplete");
    expect(report.missing.map((file) => file.path)).toEqual([EXPANSION.path]);
  });

  it("identifies files by content, not by name", async () => {
    // Installers and operating systems rename freely; the bytes are the identity.
    const manifest = await manifestFrom("Complete edition", [CORE]);
    const renamed = await suppliedFrom("TOTALLY_DIFFERENT.DAT", CORE.bytes);

    expect(checkSupply([renamed], manifest).status).toBe("complete");
  });

  it("rejects a file with the right name but the wrong contents", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE]);
    const impostor = await suppliedFrom("core.esm", bytesFor("not-the-game"));

    const report = checkSupply([impostor], manifest);

    expect(report.status).toBe("incomplete");
    expect(report.unmatched).toHaveLength(1);
  });

  it("reports unrecognised extras without treating them as failures", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE]);
    const supplied = await Promise.all([
      suppliedFrom("core.esm", CORE.bytes),
      suppliedFrom("readme.txt", bytesFor("readme")),
    ]);

    const report = checkSupply(supplied, manifest);

    expect(report.status).toBe("complete");
    expect(report.unmatched.map((file) => file.name)).toEqual(["readme.txt"]);
  });

  it("refuses to judge anything against an unverified manifest", async () => {
    // A manifest with unrecorded hashes would reject every correct file while
    // looking authoritative, so it must not gate uploads at all.
    const unverified: AssetManifest = {
      titleId: TITLE_ID,
      releaseLabel: "Unverified",
      files: [{ path: "Data Files/core.esm", sizeBytes: 0, sha256: PLACEHOLDER_HASH }],
    };
    const supplied = [await suppliedFrom("core.esm", CORE.bytes)];

    expect(checkSupply(supplied, unverified).status).toBe("unverified-manifest");
    expect(isManifestPublishable(unverified)).toBe(false);
    expect(isPlaceholder(unverified.files[0])).toBe(true);
  });

  it("treats an empty manifest as unpublishable rather than trivially satisfied", async () => {
    const empty: AssetManifest = { titleId: TITLE_ID, releaseLabel: "Empty", files: [] };
    expect(isManifestPublishable(empty)).toBe(false);
    expect(checkSupply([], empty).status).toBe("unverified-manifest");
  });

  it("sums the bytes a release requires", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE, EXPANSION]);
    expect(manifestSizeBytes(manifest)).toBe(CORE.bytes.byteLength + EXPANSION.bytes.byteLength);
  });
});

describe("selectBestManifest", () => {
  it("measures the player against the release they actually own", async () => {
    // Ranking by match count, not by list order: a localised owner should be
    // told what the localised release needs.
    const english = await manifestFrom("English", [CORE, EXPANSION]);
    const localised = await manifestFrom("German", [LOCALISED_CORE]);
    const supplied = [await suppliedFrom("core.esm", LOCALISED_CORE.bytes)];

    const report = selectBestManifest(supplied, [english, localised]);

    expect(report?.manifest.releaseLabel).toBe("German");
    expect(report?.status).toBe("complete");
  });

  it("keeps manifest order when nothing distinguishes the releases", async () => {
    const canonical = await manifestFrom("Canonical", [CORE]);
    const alternate = await manifestFrom("Alternate", [EXPANSION]);

    const report = selectBestManifest([], [canonical, alternate]);

    expect(report?.manifest.releaseLabel).toBe("Canonical");
  });

  it("returns null when a title has no supported releases", () => {
    expect(selectBestManifest([], [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

describe("ingestSuppliedFiles", () => {
  async function candidates(
    ...payloads: { name: string; bytes: Uint8Array }[]
  ): Promise<CandidateFile[]> {
    return payloads.map((payload) => ({ name: payload.name, bytes: payload.bytes }));
  }

  it("stores recognised files under the path the engine expects", async () => {
    // The manifest's layout wins over whatever the player's file was called.
    const manifest = await manifestFrom("Complete edition", [CORE]);
    const vault = new InMemoryAssetVault();

    const result = await ingestSuppliedFiles(
      TITLE_ID,
      await candidates({ name: "WEIRDNAME.DAT", bytes: CORE.bytes }),
      [manifest],
      vault,
    );

    expect(result?.stored.map((asset) => asset.path)).toEqual([CORE.path]);
    expect(await vault.read(TITLE_ID, CORE.path)).toEqual(CORE.bytes);
  });

  it("does not store files that belong to no supported release", async () => {
    // Players routinely select a whole folder; storing the rest would burn
    // their storage quota for nothing.
    const manifest = await manifestFrom("Complete edition", [CORE]);
    const vault = new InMemoryAssetVault();

    const result = await ingestSuppliedFiles(
      TITLE_ID,
      await candidates({ name: "manual.pdf", bytes: bytesFor("manual") }),
      [manifest],
      vault,
    );

    expect(result?.stored).toEqual([]);
    expect(result?.ignored).toHaveLength(1);
    expect(await vault.list(TITLE_ID)).toEqual([]);
  });

  it("accumulates files supplied across separate selections", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE, EXPANSION]);
    const vault = new InMemoryAssetVault();

    const first = await ingestSuppliedFiles(
      TITLE_ID,
      await candidates({ name: "core.esm", bytes: CORE.bytes }),
      [manifest],
      vault,
    );
    expect(first?.report.status).toBe("incomplete");

    await ingestSuppliedFiles(
      TITLE_ID,
      await candidates({ name: "expansion.esm", bytes: EXPANSION.bytes }),
      [manifest],
      vault,
    );

    const review = await reviewStoredAssets(TITLE_ID, [manifest], vault);
    expect(review?.status).toBe("complete");
    expect(isPlayable(review)).toBe(true);
  });

  it("stores nothing when the manifest is unverified", async () => {
    const unverified: AssetManifest = {
      titleId: TITLE_ID,
      releaseLabel: "Unverified",
      files: [{ path: "Data Files/core.esm", sizeBytes: 0, sha256: PLACEHOLDER_HASH }],
    };
    const vault = new InMemoryAssetVault();

    const result = await ingestSuppliedFiles(
      TITLE_ID,
      await candidates({ name: "core.esm", bytes: CORE.bytes }),
      [unverified],
      vault,
    );

    expect(result?.report.status).toBe("unverified-manifest");
    expect(result?.stored).toEqual([]);
    expect(await vault.list(TITLE_ID)).toEqual([]);
  });

  it("returns null for a title with no supported releases", async () => {
    const vault = new InMemoryAssetVault();
    const result = await ingestSuppliedFiles(
      TITLE_ID,
      await candidates({ name: "core.esm", bytes: CORE.bytes }),
      [],
      vault,
    );
    expect(result).toBeNull();
  });

  it("surfaces a quota failure distinctly, since the remedy is the player's", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE]);
    const vault = new InMemoryAssetVault(CORE.bytes.byteLength - 1);

    await expect(
      ingestSuppliedFiles(
        TITLE_ID,
        await candidates({ name: "core.esm", bytes: CORE.bytes }),
        [manifest],
        vault,
      ),
    ).rejects.toBeInstanceOf(VaultQuotaError);
  });
});

describe("isPlayable", () => {
  it("requires a complete release, so a partial game never half-boots", async () => {
    const manifest = await manifestFrom("Complete edition", [CORE, EXPANSION]);
    const partial = reviewAgainstManifest(
      [{ path: CORE.path, sizeBytes: CORE.bytes.byteLength, sha256: await sha256Hex(CORE.bytes) }],
      manifest,
    );

    expect(isPlayable(partial)).toBe(false);
    expect(isPlayable(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vault isolation — the legal posture, expressed as tests
// ---------------------------------------------------------------------------

describe("vault isolation", () => {
  it("keeps each title's data separate", async () => {
    const vault = new InMemoryAssetVault();
    await vault.put(
      "title-a",
      { path: "data.esm", sizeBytes: CORE.bytes.byteLength, sha256: await sha256Hex(CORE.bytes) },
      CORE.bytes,
    );

    expect(await vault.read("title-b", "data.esm")).toBeNull();
    expect(await vault.list("title-b")).toEqual([]);
  });

  it("stores identical bytes independently rather than sharing one copy", async () => {
    // Deduplication is exactly what would make the platform a distributor
    // rather than a viewer, so two holders must mean two stored copies.
    const vault = new InMemoryAssetVault();
    const asset = {
      path: "data.esm",
      sizeBytes: CORE.bytes.byteLength,
      sha256: await sha256Hex(CORE.bytes),
    };

    await vault.put("title-a", asset, CORE.bytes);
    await vault.put("title-b", asset, CORE.bytes);
    await vault.clear("title-a");

    // Clearing one holder's copy must not disturb the other's.
    expect(await vault.read("title-b", "data.esm")).toEqual(CORE.bytes);
    expect(await vault.read("title-a", "data.esm")).toBeNull();
  });

  it("clears idempotently", async () => {
    const vault = new InMemoryAssetVault();
    await vault.clear("never-used");
    expect(await vault.list("never-used")).toEqual([]);
  });

  it("exposes no way to enumerate or address data across titles", () => {
    // A content-addressed or global lookup is the mechanism that would turn
    // stored bytes into a distribution signal; the contract must not grow one.
    const surface = Object.getOwnPropertyNames(InMemoryAssetVault.prototype).sort();
    expect(surface).toEqual(["clear", "constructor", "list", "put", "read"]);
  });
});

// ---------------------------------------------------------------------------
// Shipped manifests
// ---------------------------------------------------------------------------

describe("title manifests", () => {
  it("declares manifests only for user-supplied titles", () => {
    for (const title of DEMO_TITLES) {
      if (manifestsForTitle(title.id).length > 0) {
        expect(title.assetSource).toBe("user-supplied");
      }
    }
  });

  it("keeps unverified manifests from gating real files", () => {
    // Every manifest shipped today is a shape example awaiting real digests;
    // none may accept or reject a player's data until those are recorded.
    for (const title of DEMO_TITLES) {
      for (const manifest of manifestsForTitle(title.id)) {
        if (!isManifestPublishable(manifest)) {
          expect(checkSupply([], manifest).status).toBe("unverified-manifest");
        }
      }
    }
  });

  it("addresses every manifest to the title that owns it", () => {
    for (const title of DEMO_TITLES) {
      for (const manifest of manifestsForTitle(title.id)) {
        expect(manifest.titleId).toBe(title.id);
      }
    }
  });

  it("returns no manifests for an unknown title", () => {
    expect(manifestsForTitle("no-such-title")).toEqual([]);
  });
});
