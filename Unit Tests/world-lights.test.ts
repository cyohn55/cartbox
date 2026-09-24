/**
 * cartbox.light3d: world-space point lights for a first-person 3D scene. They
 * share the mailbox's light records with the 2D lights but use the spare kind
 * code, carry signed fixed-point world coordinates, and are kept out of the 2D
 * relight — and the Lua SDK writes exactly what the host decodes.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeLights, decodeWorldLights, injectSdk, readCartCode } from "@cartbox/player";
import { codeChunks } from "@cartbox/player";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

describe.skipIf(!existsSync(ENGINE))("cartbox.light3d through the real engine", () => {
  it("decodes signed, fractional world positions, and hides them from the 2D relight", async () => {
    const lua = `function TIC()
  cartbox.clearlights()
  cartbox.light(40, 30, 20, 255, 0, 0, 12, 1)
  cartbox.light3d(-6.5, 1.25, 7.75, 5, 120, 255, 150, 2)
end`;
    const tic = injectSdk(codeChunks(new TextEncoder().encode(lua)));
    expect(readCartCode(tic)).toContain("light3d");
    const factory = (await import(pathToFileURL(ENGINE).href)).default;
    const mod = await factory();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    mod._cbx_tick(h, 0);
    const words = new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice();
    mod._cbx_delete(h);

    const world = decodeWorldLights(words);
    expect(world).toHaveLength(1);
    expect(world[0]!.position).toEqual([-6.5, 1.25, 7.75]);
    expect(world[0]!.range).toBe(5);
    expect(world[0]!.color[1]).toBeCloseTo(2, 5); // 255/255 × intensity 2

    const flat = decodeLights(words);
    expect(flat).toHaveLength(1); // only the 2D light
    expect(flat[0]!.x).toBe(40);
  });
});
