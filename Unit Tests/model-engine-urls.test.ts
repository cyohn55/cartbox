/**
 * Every model's default engine URL points at an engine that actually ships.
 *
 * The regression this pins: two models carried default `engineUrl`s that no
 * file ever answered — `classic` pointed at `/engine/classic/tic80.js` (the
 * classic core lives at `/engine/tic80.js`, with no `/classic/` subdirectory)
 * and `voxel` at `/engine/voxel/engine.js` (no voxel core is built). The web
 * app hid this by overriding every URL via ENGINE_URL_BY_MODEL, so a caller
 * that mounted a cart on the model's own default — the documented fallback of
 * `PlayerOptions.engineUrl` — got a 404 that surfaced as a bare load failure.
 *
 * Static assets are served from apps/web/public, so `/engine/x.js` resolves to
 * apps/web/public/engine/x.js. This walks the models and asserts the file is
 * there, which would have caught both bugs at their source.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { MODELS, type ModelId } from "@cartbox/player";

/** Maps a root-relative engine URL to its file under the web app's public dir. */
function publicAssetPath(url: string): string {
  return fileURLToPath(new URL(`../apps/web/public${url}`, import.meta.url));
}

describe("model default engine URLs", () => {
  const ids = Object.keys(MODELS) as ModelId[];

  it.each(ids)("%s resolves to an engine file that ships", (id) => {
    const url = MODELS[id].engineUrl;
    // Defaults are root-relative asset paths; a bare or absolute URL would mean
    // the file-existence check below is meaningless, so pin the shape too.
    expect(url.startsWith("/engine/")).toBe(true);
    expect(url.endsWith(".js")).toBe(true);
    expect(existsSync(publicAssetPath(url))).toBe(true);
  });
});
