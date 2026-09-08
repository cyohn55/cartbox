/**
 * The content-addressed cart asset store.
 *
 * This is the format that lets a cart carry more than a cartridge holds, so
 * the properties worth pinning are the ones a storage bill and a security
 * review depend on: dedup by hash actually dedups, a model's budget is
 * enforced, and nothing unsafe survives parsing.
 *
 * Note the deliberate asymmetry with `assetVault.ts`, which stores
 * player-supplied Tier C files and *refuses* content addressing for legal
 * reasons. These tests are about the creator-upload case only.
 */

import { describe, expect, it } from "vitest";

import {
  ALLOWED_ASSET_TYPES,
  EMPTY_CART_ASSETS,
  MAX_ASSET_BYTES,
  assetKey,
  cartAssetBytes,
  cartAssetHashes,
  checkAssetUpload,
  claimedHashAgrees,
  describeRejection,
  hashAsset,
  isValidAssetName,
  isValidHash,
  parseCartAssets,
  serializeCartAssets,
  withAsset,
  withoutAsset,
  type AssetRef,
  type CartAssets,
} from "@/lib/cartAssetStore";
import { MODELS } from "@cartbox/player";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function ref(hash: string, bytes: number, contentType = "image/png"): AssetRef {
  return { hash, bytes, contentType };
}

function assets(entries: Record<string, AssetRef>): CartAssets {
  return { entries };
}

describe("hashAsset", () => {
  it("produces the standard SHA-256 hex digest", async () => {
    // The known digest of the empty input — proves this is real SHA-256 and not
    // some project-local scheme, which matters because the hash is the storage
    // key and a change to it silently orphans everything already stored.
    expect(await hashAsset(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes the view's own bytes, not its backing buffer", async () => {
    // A Uint8Array can be a window onto a larger buffer. Digesting the buffer
    // would give two different slices the same key and cross-wire their content.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = backing.subarray(0, 4);
    const second = backing.subarray(4, 8);
    expect(await hashAsset(first)).not.toBe(await hashAsset(second));
    expect(await hashAsset(first)).toBe(await hashAsset(new Uint8Array([1, 2, 3, 4])));
  });

  it("gives identical bytes an identical key, which is what makes dedup work", async () => {
    const a = await hashAsset(new Uint8Array([9, 9, 9]));
    const b = await hashAsset(new Uint8Array([9, 9, 9]));
    expect(a).toBe(b);
    expect(assetKey(a)).toBe(`assets/${a}`);
  });
});

describe("cartAssetBytes", () => {
  it("counts a shared asset once, however many names point at it", () => {
    // Two names, one stored object. Charging twice would bill a cart for
    // storage nobody uses, and would make a budget unpredictable to a creator.
    const shared = assets({ "a.png": ref(HASH_A, 1000), "b.png": ref(HASH_A, 1000) });
    expect(cartAssetBytes(shared)).toBe(1000);
    expect(cartAssetHashes(shared)).toEqual([HASH_A]);
  });

  it("sums distinct assets", () => {
    expect(cartAssetBytes(assets({ a: ref(HASH_A, 100), b: ref(HASH_B, 250) }))).toBe(350);
  });

  it("is zero for an empty manifest", () => {
    expect(cartAssetBytes(EMPTY_CART_ASSETS)).toBe(0);
  });
});

describe("parseCartAssets", () => {
  it("round-trips a manifest through serialisation", () => {
    const original = assets({ "tiles.png": ref(HASH_A, 4096) });
    expect(parseCartAssets(serializeCartAssets(original))).toEqual(original);
  });

  it("returns null when there is no manifest to speak of", () => {
    expect(parseCartAssets(null)).toBeNull();
    expect(parseCartAssets(undefined)).toBeNull();
    expect(parseCartAssets("")).toBeNull();
    expect(parseCartAssets("{not json")).toBeNull();
    expect(parseCartAssets({})).toBeNull();
  });

  it("drops a malformed entry instead of failing the whole cart", () => {
    // Matches every other sidecar: one bad entry costs that asset, not the cart.
    const parsed = parseCartAssets({
      entries: {
        good: ref(HASH_A, 10),
        badHash: { hash: "nope", bytes: 10, contentType: "image/png" },
        badBytes: { hash: HASH_B, bytes: -1, contentType: "image/png" },
        badType: { hash: HASH_B, bytes: 10, contentType: "image/svg+xml" },
        notAnObject: 42,
      },
    })!;
    expect(Object.keys(parsed.entries)).toEqual(["good"]);
  });

  it("rejects an entry claiming to be larger than the per-asset cap", () => {
    const parsed = parseCartAssets({
      entries: { huge: { hash: HASH_A, bytes: MAX_ASSET_BYTES + 1, contentType: "image/png" } },
    })!;
    expect(parsed.entries).toEqual({});
  });

  it("drops unsafe names", () => {
    // Names reach URLs and logs. Traversal and separators never survive.
    const parsed = parseCartAssets({
      entries: {
        "ok-name_1.png": ref(HASH_A, 10),
        "../escape.png": ref(HASH_B, 10),
        "dir/file.png": ref(HASH_B, 10),
        "back\\slash.png": ref(HASH_B, 10),
        "": ref(HASH_B, 10),
      },
    })!;
    expect(Object.keys(parsed.entries)).toEqual(["ok-name_1.png"]);
  });
});

describe("isValidAssetName", () => {
  it("accepts ordinary asset names", () => {
    expect(isValidAssetName("hero.png")).toBe(true);
    expect(isValidAssetName("tiles_2x.webp")).toBe(true);
  });

  it("rejects traversal, separators, control characters and oversized names", () => {
    expect(isValidAssetName("..")).toBe(false);
    expect(isValidAssetName("a/b")).toBe(false);
    expect(isValidAssetName("a\\b")).toBe(false);
    expect(isValidAssetName("a\u0000b")).toBe(false);
    expect(isValidAssetName("a\u007fb")).toBe(false);
    expect(isValidAssetName("x".repeat(256))).toBe(false);
    expect(isValidAssetName("")).toBe(false);
  });
});

describe("isValidHash", () => {
  it("requires 64 lowercase hex characters", () => {
    expect(isValidHash(HASH_A)).toBe(true);
    expect(isValidHash(HASH_A.toUpperCase())).toBe(false);
    expect(isValidHash("a".repeat(63))).toBe(false);
    expect(isValidHash(123)).toBe(false);
  });
});

describe("checkAssetUpload", () => {
  const budget = 10_000;

  it("accepts an asset that fits", () => {
    expect(checkAssetUpload("t.png", HASH_A, 500, "image/png", EMPTY_CART_ASSETS, budget)).toBeNull();
  });

  it("rejects a type outside the allowlist", () => {
    // An asset store that takes arbitrary bytes is a file host. SVG in
    // particular is a script vector no texture path can consume anyway.
    const rejection = checkAssetUpload("x.svg", HASH_A, 10, "image/svg+xml", EMPTY_CART_ASSETS, budget)!;
    expect(rejection.reason).toBe("type");
    expect(ALLOWED_ASSET_TYPES).not.toContain("image/svg+xml");
  });

  it("rejects empty and oversized assets", () => {
    expect(checkAssetUpload("a", HASH_A, 0, "image/png", EMPTY_CART_ASSETS, budget)!.reason).toBe("empty");
    expect(
      checkAssetUpload("a", HASH_A, MAX_ASSET_BYTES + 1, "image/png", EMPTY_CART_ASSETS, budget)!.reason,
    ).toBe("too-large");
  });

  it("rejects an unsafe name before anything else", () => {
    expect(checkAssetUpload("../x", HASH_A, 10, "image/png", EMPTY_CART_ASSETS, budget)!.reason).toBe("name");
  });

  it("enforces the model's budget across the whole manifest", () => {
    const existing = assets({ big: ref(HASH_A, 9_000) });
    expect(checkAssetUpload("n", HASH_B, 500, "image/png", existing, budget)).toBeNull();
    const rejection = checkAssetUpload("n", HASH_B, 2_000, "image/png", existing, budget)!;
    expect(rejection.reason).toBe("over-budget");
    expect(describeRejection(rejection)).toContain("11000");
  });

  it("charges nothing for an asset the cart already references", () => {
    // This is what makes re-saving a cart free: the bytes are already stored, so
    // re-adding them must not push a cart at its limit over the edge.
    const full = assets({ big: ref(HASH_A, budget) });
    expect(checkAssetUpload("same-again", HASH_A, budget, "image/png", full, budget)).toBeNull();
  });

  it("refuses every asset on a model with no budget", () => {
    // Cartridge-only models must not silently acquire an asset store.
    expect(checkAssetUpload("t.png", HASH_A, 1, "image/png", EMPTY_CART_ASSETS, 0)!.reason).toBe("over-budget");
  });
});

describe("claimedHashAgrees", () => {
  it("accepts an upload that sends no hash", () => {
    // The hash is always recomputed server-side; claiming one is optional.
    expect(claimedHashAgrees(undefined, HASH_A)).toBe(true);
    expect(claimedHashAgrees(null, HASH_A)).toBe(true);
    expect(claimedHashAgrees("", HASH_A)).toBe(true);
  });

  it("accepts a hash matching the bytes", () => {
    expect(claimedHashAgrees(HASH_A, HASH_A)).toBe(true);
  });

  it("rejects a hash that disagrees with the bytes", () => {
    // The security-relevant case. If a claimed hash were trusted as the storage
    // key, a caller could overwrite another creator's asset, or point a cart at
    // bytes that were never uploaded. Here a mismatch fails the request rather
    // than being silently corrected, because it means one side is confused.
    expect(claimedHashAgrees(HASH_B, HASH_A)).toBe(false);
    expect(claimedHashAgrees("not-a-hash", HASH_A)).toBe(false);
    expect(claimedHashAgrees(HASH_A.toUpperCase(), HASH_A)).toBe(false);
    expect(claimedHashAgrees(42, HASH_A)).toBe(false);
  });
});

describe("withAsset / withoutAsset", () => {
  it("adds, replaces and removes without mutating the original", () => {
    const original = assets({ a: ref(HASH_A, 10) });
    const added = withAsset(original, "b", ref(HASH_B, 20));
    expect(Object.keys(original.entries)).toEqual(["a"]);
    expect(cartAssetBytes(added)).toBe(30);

    const replaced = withAsset(added, "a", ref(HASH_B, 20));
    expect(cartAssetBytes(replaced)).toBe(20); // both names now share one asset

    expect(Object.keys(withoutAsset(added, "a").entries)).toEqual(["b"]);
  });
});

describe("shipping models", () => {
  it("are cartridge-only, except the era model that cannot be", () => {
    // This test existed to make the first non-zero budget a deliberate decision
    // rather than a default. It fired when PS1 arrived, which is the point:
    // geometry and textures do not fit in a cartridge at any resolution, so a
    // 3D era model is exactly the case that has to break the rule.
    for (const model of Object.values(MODELS)) {
      if (model.id === "ps1") {
        expect(model.assetBudgetBytes).toBeGreaterThan(0);
        continue;
      }
      expect(model.assetBudgetBytes, model.id).toBe(0);
    }
  });
});
