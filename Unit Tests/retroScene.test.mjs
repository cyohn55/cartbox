/**
 * Unit tests for the retro-arcade backdrop: the pixel-art sprite painter
 * (apps/web/src/lib/retroSprites.ts) and the scene builder that composes them
 * (buildRetroScene in apps/web/src/lib/litBackdrop.ts).
 *
 * Every assertion is derived from the modules' own inputs/outputs — sprite pixel
 * counts, buffer sizes, relit brightness — never hard-coded pixel values. The
 * modules are dep-free (no DOM, no WASM editor barrel), so they load directly
 * under the TS hook.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/retroScene.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sprites = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/retroSprites.ts")).href
);
const backdrop = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/litBackdrop.ts")).href
);

const { INKS, TRANSPARENT, GHOST, GAMEPAD, spriteWidth, spriteHeight, stampSprite } = sprites;
const { NORMAL_DIRECTION_COUNT, buildRetroScene, renderBackdropFrame } = backdrop;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** A blank paint surface mirroring the channels stampSprite writes. */
function blankTarget(width, height) {
  const count = width * height;
  return {
    width,
    height,
    albedo: new Uint8ClampedArray(count * 3),
    heightField: new Float32Array(count),
    specular: new Float32Array(count),
    roughness: new Float32Array(count),
    emissive: new Float32Array(count),
    emissiveColor: new Uint8ClampedArray(count * 3),
  };
}

/** How many opaque (paintable) cells a sprite defines — the source of truth. */
function opaqueCells(sprite) {
  let total = 0;
  for (const row of sprite.rows) {
    for (const glyph of row) {
      if (glyph !== TRANSPARENT && glyph !== " " && INKS[glyph]) total += 1;
    }
  }
  return total;
}

// 1. Every sprite is rectangular-safe: each row fits within the reported width,
//    and both dimensions are positive.
{
  const all = [GHOST, GAMEPAD, sprites.ARCADE, sprites.CONSOLE, sprites.CARTRIDGE,
    sprites.INVADER, sprites.ROBOT, sprites.STAR, sprites.HEART, sprites.COIN];
  let ok = true;
  for (const s of all) {
    if (spriteWidth(s) <= 0 || spriteHeight(s) <= 0) ok = false;
    for (const row of s.rows) if (row.length > spriteWidth(s)) ok = false;
  }
  check("all sprites report positive, consistent dimensions", ok);
}

// 2. Stamping fully in-bounds paints exactly the sprite's opaque-cell count
//    (transparent characters leave the surface untouched).
{
  const target = blankTarget(64, 64);
  const painted = stampSprite(target, GHOST, 10, 10, 1);
  check("stamp paints exactly the opaque-cell count", painted === opaqueCells(GHOST));
}

// 3. A transparent sprite cell leaves the underlying pixel untouched. GHOST's
//    top-left corner is transparent, so the pixel under it stays zeroed.
{
  const target = blankTarget(64, 64);
  const ox = 10;
  const oy = 10;
  stampSprite(target, GHOST, ox, oy, 1);
  const corner = (oy + 0) * target.width + (ox + 0); // row 0, col 0 is "."
  check("transparent cell leaves the wall pixel untouched", target.heightField[corner] === 0);
}

// 4. Integer scale multiplies painted area by scale² (nearest-neighbour upscale).
{
  const a = blankTarget(96, 96);
  const b = blankTarget(96, 96);
  const one = stampSprite(a, GAMEPAD, 5, 5, 1);
  const four = stampSprite(b, GAMEPAD, 5, 5, 2);
  check("scale 2 paints 4× the pixels of scale 1", four === one * 4);
}

// 5. Stamping partly off the buffer clips instead of throwing or overflowing.
{
  const target = blankTarget(20, 20);
  const painted = stampSprite(target, sprites.ARCADE, -4, -4, 2);
  check("off-buffer stamp clips safely", painted >= 0 && painted <= opaqueCells(sprites.ARCADE) * 4);
}

// 6. buildRetroScene aligns every channel buffer to the pixel grid.
const W = 130;
const H = 80;
const scene = buildRetroScene(W, H);
check(
  "scene channel buffers are aligned to the grid",
  scene.albedo.length === W * H * 3 &&
    scene.normalIdx.length === W * H &&
    scene.heightField.length === W * H &&
    scene.specular.length === W * H &&
    scene.emissive.length === W * H &&
    scene.emissiveColor.length === W * H * 3,
);

// 7. The builder is deterministic — identical inputs rebuild identical albedo.
{
  const again = buildRetroScene(W, H);
  check(
    "scene rebuilds identically",
    Buffer.compare(Buffer.from(scene.albedo), Buffer.from(again.albedo)) === 0,
  );
}

// 8. Normal indices stay within the 16-direction domain.
{
  let inRange = true;
  for (let i = 0; i < scene.normalIdx.length; i += 1) {
    if (scene.normalIdx[i] < 0 || scene.normalIdx[i] >= NORMAL_DIRECTION_COUNT) inRange = false;
  }
  check("normal indices are within 0..15", inRange);
}

// 9. The scene actually raises geometry off the flat wall — some pixels sit well
//    above the background plane, i.e. props were stamped.
{
  let raised = 0;
  for (let i = 0; i < scene.heightField.length; i += 1) {
    if (scene.heightField[i] > 0.5) raised += 1;
  }
  check("props raise geometry above the flat wall", raised > 0);
}

// 10. The scene carries self-emissive glow (screens, LEDs, stars).
{
  let emissive = 0;
  for (let i = 0; i < scene.emissive.length; i += 1) if (scene.emissive[i] > 0) emissive += 1;
  check("scene has emissive pixels", emissive > 0);
}

// 11. Relighting produces a full-size RGBA frame, and an emissive pixel keeps its
//     glow even when the light is far and low (it carries its own light).
{
  let ei = -1;
  for (let i = 0; i < scene.emissive.length; i += 1) {
    if (scene.emissive[i] > 0) { ei = i; break; }
  }
  const frame = renderBackdropFrame(scene, { x: -300, y: -300, z: 1 });
  const litMax = Math.max(frame[ei * 4], frame[ei * 4 + 1], frame[ei * 4 + 2]);
  const emisMax = Math.max(
    scene.emissiveColor[ei * 3],
    scene.emissiveColor[ei * 3 + 1],
    scene.emissiveColor[ei * 3 + 2],
  ) * scene.emissive[ei];
  check(
    "relit frame is full size and emissive glow survives shadow",
    frame.length === W * H * 4 && litMax >= emisMax - 1,
  );
}

console.log(`retroScene: ${passed}/${passed} checks passed`);
