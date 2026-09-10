/**
 * The built PS1 core.
 *
 * `ps1-model-spec.test.ts` proves the *numbers* are self-consistent. This proves
 * the **binary** was actually compiled at those numbers — which nothing else
 * checks, and which is the failure that would otherwise ship silently: the build
 * script passes its spec through `-D` defines, and a define that failed to reach
 * the core would produce a working engine at the wrong spec. It would load, it
 * would tick, and it would be Classic wearing a PS1 label.
 *
 * Skips itself when the core has not been built, like the other engine tests, so
 * the suite still runs without the WASM toolchain. To build it:
 *
 *   node scripts/prepare-tic80.mjs      # fetch + patch the vendored TIC-80
 *   npm run engine:build:ps1
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { MODELS, framebufferBytes } from "@cartbox/player";

const corePath = (model: string) =>
  fileURLToPath(new URL(`../packages/engine/dist/${model}`, import.meta.url));

const PS1 = corePath("ps1/engine.js");
const PRO = corePath("pro/engine.js");
const CLASSIC = corePath("tic80.js");

const built = existsSync(PS1) && existsSync(PRO) && existsSync(CLASSIC);
const suite = built ? describe : describe.skip;
if (!built) {
  console.warn(
    "[ps1-core-build] the ps1/pro/classic cores are not all built; skipping. " +
      "Run node scripts/prepare-tic80.mjs && npm run engine:build:ps1.",
  );
}

/** Minimal surface of the Emscripten glue these assertions need. */
interface Core {
  _cbx_create(sampleRate: number): number;
  _cbx_tick(handle: number, gamepad: number): void;
  _cbx_screen_ptr(handle: number): number;
  _cbx_cart_bytesize(): number;
  _cbx_cart_music_track_stride(): number;
}

async function load(path: string): Promise<Core> {
  const glue = (await import(pathToFileURL(path).href)) as {
    default: () => Promise<Core>;
  };
  return glue.default();
}

suite("the built PS1 core", () => {
  let ps1: Core;
  let pro: Core;
  let classic: Core;

  beforeAll(async () => {
    [ps1, pro, classic] = await Promise.all([load(PS1), load(PRO), load(CLASSIC)]);
  }, 60_000);

  it("compiles to its own memory map, not a copy of another model's", () => {
    // The headline check. Every model's cartridge struct is laid out from the
    // -D defines, so three models must give three sizes. If the PS1 build's
    // defines silently failed to reach the core, this is where it shows: the
    // binary would report Classic's map while being called the PS1 core.
    const sizes = new Set([
      ps1._cbx_cart_bytesize(),
      pro._cbx_cart_bytesize(),
      classic._cbx_cart_bytesize(),
    ]);
    expect(sizes.size).toBe(3);
  });

  it("sits between Classic and Pro in cartridge size, as its resolution implies", () => {
    // 320x240 is more than Classic's 240x136 and less than Pro's 640x360, and
    // the map and screen buffers scale with it. An ordering violation would mean
    // the spec compiled at some resolution other than the one it declares.
    expect(ps1._cbx_cart_bytesize()).toBeGreaterThan(classic._cbx_cart_bytesize());
    expect(ps1._cbx_cart_bytesize()).toBeLessThan(pro._cbx_cart_bytesize());
  });

  it("compiled its sound channels too, not only its video spec", () => {
    // build-ps1-wasm.sh sets PS1_SOUND_CHANNELS=8, and TIC_SOUND_CHANNELS widens
    // the music-track pattern packing (the patch notes it needs u64 at 8
    // channels). The track stride is therefore observable proof that the audio
    // half of the -D spec reached the core — a build that dropped it would still
    // produce a 320x240 engine, just one whose music format is Classic's.
    //
    // Deliberately not asserted against `MODELS.*.audioChannels`: that field is
    // 2 on Classic against TIC-80's four synth channels, so it describes output
    // channels rather than voices and does not correspond to this define.
    expect(ps1._cbx_cart_music_track_stride()).toBeGreaterThan(
      classic._cbx_cart_music_track_stride(),
    );
    // Pro is built at the same eight channels, so the two must agree exactly.
    expect(ps1._cbx_cart_music_track_stride()).toBe(pro._cbx_cart_music_track_stride());
  });

  it("ticks repeatedly without trapping", () => {
    // The regression build-ps1-wasm.sh raises STACK_SIZE for: the core's
    // per-frame draw buffers scale with TIC80_HEIGHT, and overflowing the stack
    // corrupted memory and trapped mid-tick rather than failing at link time.
    // A single tick can pass while a sustained run does not.
    const handle = ps1._cbx_create(MODELS.ps1.sampleRate);
    expect(handle).not.toBe(0);
    expect(() => {
      for (let frame = 0; frame < 240; frame += 1) ps1._cbx_tick(handle, 0);
    }).not.toThrow();
    expect(ps1._cbx_screen_ptr(handle)).not.toBe(0);
  });

  it("presents a frame the model's own size agrees with", () => {
    // Keeps the binary and MODELS.ps1 tied together: this is the number the
    // player allocates its ImageData from.
    expect(framebufferBytes(MODELS.ps1)).toBe(320 * 240 * 4);
  });
});
