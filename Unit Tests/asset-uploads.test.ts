/**
 * Authoring-side rules for the cart asset store.
 *
 * These are the rules that stand between a file picker and an API that will
 * refuse things. The server is the authority — it recomputes the hash, re-checks
 * the allowlist and re-checks the budget — so nothing here is a security
 * boundary. What these functions decide is whether a creator gets told "no"
 * before or after a 16MB upload, and whether the name their file lands under is
 * one the manifest can actually hold.
 */

import { describe, expect, it } from "vitest";

import {
  assetNameFromFile,
  budgetUsage,
  contentTypeForUpload,
  formatBytes,
  uniqueAssetName,
} from "../apps/web/src/app/edit/[cartId]/assetUploads";
import { isValidAssetName, type AssetRef, type CartAssets } from "../apps/web/src/lib/cartAssetStore";
import { MODELS } from "@cartbox/player";

function assets(entries: Record<string, AssetRef>): CartAssets {
  return { entries };
}

const ref = (hash: string, bytes: number): AssetRef => ({
  hash,
  bytes,
  contentType: "image/png",
});

describe("formatBytes", () => {
  it("uses binary units, so a 660MB disc reads as 660MB", () => {
    // The failure this guards is a cosmetic one that undermines the whole spec:
    // ERA_MODELS.md calls the PS1 budget 660MB, and decimal units would label
    // the very same number 692 MB on screen.
    expect(formatBytes(MODELS.ps1.assetBudgetBytes)).toBe("660 MB");
    expect(formatBytes(16 * 1024 * 1024)).toBe("16 MB");
  });

  it("keeps one decimal only where it carries information", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(900)).toBe("900 B");
    // Above ten the decimal is noise: nobody acts differently on 847.3 MB.
    expect(formatBytes(847.3 * 1024 * 1024)).toBe("847 MB");
  });

  it("does not render a number for a non-number", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("assetNameFromFile", () => {
  it("keeps an ordinary filename as it is", () => {
    expect(assetNameFromFile("hero.png")).toBe("hero.png");
    expect(assetNameFromFile("tiles_2x.webp")).toBe("tiles_2x.webp");
  });

  it("takes the basename, whichever separator the platform used", () => {
    expect(assetNameFromFile("/home/me/art/hero.png")).toBe("hero.png");
    expect(assetNameFromFile("C:\\art\\hero.png")).toBe("hero.png");
  });

  it("collapses dot runs rather than failing on them", () => {
    // `isValidAssetName` refuses any name containing "..", which is traversal-
    // shaped. A real file can legitimately be called "shot..2.png", and the
    // creator should get an upload rather than an error about path traversal.
    expect(assetNameFromFile("shot..2.png")).toBe("shot.2.png");
    expect(isValidAssetName(assetNameFromFile("shot..2.png"))).toBe(true);
  });

  it("strips control characters", () => {
    const nasty = `he${String.fromCharCode(0)}ro${String.fromCharCode(31)}.png`;
    expect(assetNameFromFile(nasty)).toBe("hero.png");
  });

  it("always returns something the manifest accepts", () => {
    // Every path out of this function has to be a valid name, or the panel
    // hands the server something it will reject and blames the creator.
    for (const input of [
      "hero.png",
      "../../../etc/passwd",
      "..",
      "...",
      "",
      "   ",
      "/",
      "\\",
      String.fromCharCode(7),
      "x".repeat(400),
      `${"y".repeat(400)}.png`,
    ]) {
      const name = assetNameFromFile(input);
      expect(isValidAssetName(name), `${JSON.stringify(input)} produced ${JSON.stringify(name)}`).toBe(
        true,
      );
    }
  });

  it("keeps the extension when it has to truncate", () => {
    // The extension is what the content type is read from, so losing it turns a
    // valid PNG into an unsupported type.
    const name = assetNameFromFile(`${"y".repeat(400)}.png`);
    expect(name.endsWith(".png")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(255);
  });
});

describe("uniqueAssetName", () => {
  it("leaves a free name alone", () => {
    expect(uniqueAssetName("hero.png", [])).toBe("hero.png");
    expect(uniqueAssetName("hero.png", ["other.png"])).toBe("hero.png");
  });

  it("suffixes before the extension, not after it", () => {
    // "hero.png-2" would lose the extension, and with it the content type.
    expect(uniqueAssetName("hero.png", ["hero.png"])).toBe("hero-2.png");
    expect(uniqueAssetName("hero.png", ["hero.png", "hero-2.png"])).toBe("hero-3.png");
  });

  it("handles a name with no extension", () => {
    expect(uniqueAssetName("hero", ["hero"])).toBe("hero-2");
  });

  it("never silently overwrites, because assets are immutable", () => {
    // The property that matters. Uploading over an existing name would repoint
    // it at different bytes, which for a published cart means its texture
    // changing underneath the people playing it — exactly what content
    // addressing exists to prevent.
    const taken = ["a.png", "a-2.png", "a-3.png"];
    const chosen = uniqueAssetName("a.png", taken);
    expect(taken).not.toContain(chosen);
    expect(isValidAssetName(chosen)).toBe(true);
  });
});

describe("contentTypeForUpload", () => {
  it("trusts the browser when it names an allowed type", () => {
    expect(contentTypeForUpload("hero.png", "image/png")).toBe("image/png");
  });

  it("falls back to the extension when the browser has no opinion", () => {
    // The case this exists for: browsers routinely give `.glb` an empty type,
    // and the store's allowlist would then refuse it as unsupported — which
    // reads as "this editor does not take models".
    expect(contentTypeForUpload("scene.glb", "")).toBe("model/gltf-binary");
    expect(contentTypeForUpload("music.ogg", "")).toBe("audio/ogg");
    expect(contentTypeForUpload("SHOT.PNG", "")).toBe("image/png");
  });

  it("overrides a browser type the store does not accept", () => {
    // Some platforms report `.glb` as a generic stream. The extension is the
    // better evidence, and the allowlist still has the final say.
    expect(contentTypeForUpload("scene.glb", "application/octet-stream")).toBe("model/gltf-binary");
  });

  it("passes an unknown type through rather than inventing one", () => {
    // So the rejection the creator reads names the file they actually picked.
    expect(contentTypeForUpload("notes.txt", "text/plain")).toBe("text/plain");
  });
});

describe("budgetUsage", () => {
  it("counts a shared asset once", () => {
    // Two names, one stored object: charging twice would bill for storage
    // nobody uses and make the meter disagree with the server's own check.
    const shared = assets({ "a.png": ref("a".repeat(64), 1000), "b.png": ref("a".repeat(64), 1000) });
    expect(budgetUsage(shared, 10_000).usedBytes).toBe(1000);
  });

  it("reports free space and a meter fraction", () => {
    const usage = budgetUsage(assets({ a: ref("a".repeat(64), 2500) }), 10_000);
    expect(usage.freeBytes).toBe(7500);
    expect(usage.fraction).toBeCloseTo(0.25, 10);
  });

  it("shows a cart over budget as full, not as owing bytes", () => {
    const usage = budgetUsage(assets({ a: ref("a".repeat(64), 20_000) }), 10_000);
    expect(usage.freeBytes).toBe(0);
    expect(usage.fraction).toBe(1);
  });

  it("does not produce NaN on a model with no budget", () => {
    // Every cartridge-only model has a zero budget, and a NaN width would make
    // the meter render as an empty bar rather than a full one.
    const usage = budgetUsage({ entries: {} }, 0);
    expect(usage.fraction).toBe(1);
    expect(usage.freeBytes).toBe(0);
  });
});
