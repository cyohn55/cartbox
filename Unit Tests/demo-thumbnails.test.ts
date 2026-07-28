/**
 * Demo cart cover-art tests.
 *
 * The static demo build has no render worker, so each demo cart's cover is a
 * PNG baked into public/demo/thumbs/ by scripts/bake-demo-thumbs.mjs. These
 * tests assert the two halves stay wired: the demo feed advertises a cover URL
 * for every cart (no more null thumbnails), and every advertised cover actually
 * exists on disk. They drive the real buildDemoFeed / demoThumbUrl the app uses.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildDemoFeed } from "../apps/web/src/lib/demoFeed";
import { DEMO_CARTS, demoThumbUrl } from "../apps/web/src/lib/demoCatalog";

/** Resolves a public asset URL to its file under apps/web/public. */
function publicAssetPath(url: string): string {
  const relative = url.replace(/^\//, "");
  return fileURLToPath(new URL(`../apps/web/public/${relative}`, import.meta.url));
}

describe("demo cart cover art", () => {
  it("advertises a thumbnail for every cart in the demo feed", () => {
    const cartItems = buildDemoFeed().filter((item) => item.kind === "cart");
    expect(cartItems.length).toBe(DEMO_CARTS.length);
    for (const item of cartItems) {
      expect(item.cart?.thumbUrl).toBe(demoThumbUrl(item.cart!.id));
      expect(item.cart?.thumbUrl).toMatch(/\/demo\/thumbs\/.+\.png$/);
    }
  });

  it("has a baked PNG on disk for every catalog cart", () => {
    for (const cart of DEMO_CARTS) {
      const path = publicAssetPath(demoThumbUrl(cart.id));
      expect(existsSync(path), `missing baked thumbnail for ${cart.title} (${path})`).toBe(true);
    }
  });
});
