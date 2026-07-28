/**
 * Unit tests for the Doom (Freedoom) catalog title — Browse Phase 2.
 *
 * These drive the *actual compiled* game (apps/web/public/games/doom, built by
 * scripts/build-doom.mjs) through the Cartbox Game ABI, in the same spirit as
 * wasm-game-runtime.test.ts: a stubbed Doom would prove only that the stub
 * matches the stub. What is being verified is the port — the framebuffer
 * conversion, the clock gating, and the input bridge — not Doom itself, which
 * is vendored verbatim.
 *
 * Booting Doom parses a 27MB IWAD, so the timeouts here are generous and the
 * playing tests share one session rather than booting per assertion.
 *
 * Run with: npx vitest run "Unit Tests/doom-title.test.ts"
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { BUTTON_BITS } from "../apps/web/src/lib/gameInput";
import {
  GameAbiError,
  GameSession,
  type GameModuleFactory,
} from "../apps/web/src/lib/wasmGameRuntime";
import { DEMO_TITLES } from "../apps/web/src/lib/demoTitles";

const GAME_DIRECTORY = fileURLToPath(
  new URL("../apps/web/public/games/doom/", import.meta.url),
);
const GAME_GLUE = `${GAME_DIRECTORY}game.js`;
const GAME_WASM = `${GAME_DIRECTORY}game.wasm`;
const GAME_DATA = `${GAME_DIRECTORY}game.data`;

/** Compiled into doomgeneric by scripts/build-doom.mjs. */
const WIDTH = 320;
const HEIGHT = 200;

const BOOT_TIMEOUT_MS = 120_000;

/**
 * Loads the compiled Doom build.
 *
 * Two escape hatches stand in for the browser's network: `wasmBinary` for the
 * module and `getPreloadedPackage` for the IWAD package. Both hand over bytes
 * the caller already holds, so the test exercises the artefact that actually
 * ships rather than a Node-specific rebuild of it.
 */
async function loadDoomFactory(): Promise<GameModuleFactory> {
  // pathToFileURL, not the raw path: this repository's checkout contains spaces,
  // which make a bare filesystem path an invalid module specifier.
  const imported = (await import(pathToFileURL(GAME_GLUE).href)) as {
    default: GameModuleFactory;
  };
  const wasmBinary = readFileSync(GAME_WASM);
  const packageBytes = readFileSync(GAME_DATA);

  return (options?: Record<string, unknown>) =>
    imported.default({
      ...options,
      wasmBinary,
      getPreloadedPackage: () =>
        packageBytes.buffer.slice(
          packageBytes.byteOffset,
          packageBytes.byteOffset + packageBytes.byteLength,
        ),
      // Doom is chatty on boot; silence it so test output stays readable.
      print: () => {},
      printErr: () => {},
    });
}

const gameIsBuilt = existsSync(GAME_GLUE) && existsSync(GAME_DATA);
const describeGame = gameIsBuilt ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Catalog registration
// ---------------------------------------------------------------------------

describe("doom catalog entry", () => {
  const doom = DEMO_TITLES.find((title) => title.slug === "doom");

  it("is registered as a bundled Tier A title", () => {
    expect(doom).toBeDefined();
    // Tier A is the claim that matters legally: Freedoom's assets are
    // BSD-3-Clause, so both halves of what ships are redistributable. Marking
    // it Tier B or C would misdescribe what the platform is hosting.
    expect(doom?.tier).toBe("A");
    expect(doom?.assetSource).toBe("bundled");
    expect(doom?.runtime).toBe("wasm-app");
  });

  it("declares the resolution the binary is compiled for", () => {
    // A mismatch here is not cosmetic: cartbox_init rejects any other size, so
    // wrong metadata makes the title fail to boot rather than render oddly.
    expect(doom?.width).toBe(WIDTH);
    expect(doom?.height).toBe(HEIGHT);
  });

  it("points at the built bundle", () => {
    expect(doom?.bundleName).toBe("doom");
  });
});

// ---------------------------------------------------------------------------
// The compiled game
// ---------------------------------------------------------------------------

describeGame("doom through the Cartbox Game ABI", () => {
  let factory: GameModuleFactory;
  let session: GameSession;

  beforeAll(async () => {
    factory = await loadDoomFactory();
    session = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });
  }, BOOT_TIMEOUT_MS);

  /** Advances the game, holding `buttons` for the duration. */
  function run(frames: number, buttons = 0): void {
    for (let index = 0; index < frames; index++) {
      session.setInput(buttons);
      session.tick(1 / 35);
    }
  }

  function summarise(frame: Uint8Array) {
    let opaque = 0;
    let nonBlack = 0;
    let red = 0;
    let blue = 0;
    for (let index = 0; index < frame.length; index += 4) {
      if (frame[index + 3] === 255) opaque++;
      if (frame[index] || frame[index + 1] || frame[index + 2]) nonBlack++;
      red += frame[index];
      blue += frame[index + 2];
    }
    return { pixels: frame.length / 4, opaque, nonBlack, red, blue };
  }

  it("rejects a resolution it was not compiled for", async () => {
    // doomgeneric's resolution is a compile-time constant, so the honest
    // response to a mismatch is a refusal the host reports by name — not a
    // silently torn or half-filled framebuffer.
    await expect(
      GameSession.start(factory, { width: 640, height: 400 }),
    ).rejects.toBeInstanceOf(GameAbiError);
  }, BOOT_TIMEOUT_MS);

  it("renders a fully opaque frame", () => {
    run(200);
    const { pixels, opaque } = summarise(session.frame());

    // doomgeneric never writes an alpha byte, leaving it zero. Without the
    // backend forcing it to 255 the whole canvas would be transparent.
    expect(opaque).toBe(pixels);
  }, BOOT_TIMEOUT_MS);

  it("renders actual image content rather than a blank buffer", () => {
    run(50);
    const { pixels, nonBlack } = summarise(session.frame());
    expect(nonBlack).toBeGreaterThan(pixels * 0.5);
  }, BOOT_TIMEOUT_MS);

  it("emits RGBA rather than doomgeneric's native BGRA", () => {
    run(50);
    const { red, blue } = summarise(session.frame());

    // doomgeneric packs B|G<<8|R<<16 — byte order B,G,R — despite calling the
    // mode "rgba8888". Doom's palette is heavily brown and red, so a frame with
    // more blue than red means the backend stopped swapping the channels and
    // the canvas is showing a blue-tinted image.
    expect(red).toBeGreaterThan(blue);
  }, BOOT_TIMEOUT_MS);

  it("holds the frame steady for deltas shorter than one tic", () => {
    run(30);
    const before = Uint8Array.from(session.frame());

    // Doom runs at a fixed 35Hz and TryRunTics always runs at least one tic, so
    // ticking it once per host frame would run the game at the display's
    // refresh rate. Sub-tic deltas must accumulate instead of advancing.
    session.setInput(0);
    session.tick(0.001);

    expect(Uint8Array.from(session.frame())).toEqual(before);
  }, BOOT_TIMEOUT_MS);

  it("routes button presses into the engine", () => {
    run(120);
    const beforeMenu = Uint8Array.from(session.frame());

    // SELECT is bound to Escape, which opens Doom's main menu — the cheapest
    // observable proof that a host button reached the engine.
    run(20, BUTTON_BITS.select);
    run(20);

    expect(Uint8Array.from(session.frame())).not.toEqual(beforeMenu);
  }, BOOT_TIMEOUT_MS);

  it("reports a non-negative score", () => {
    // Doom has no score, so the port surfaces the console player's kill count.
    const score = session.score();
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
  }, BOOT_TIMEOUT_MS);

  it("reports no save state until the player saves in-game", () => {
    // Saves are Doom's own .dsg files archived out of the virtual filesystem.
    // Until the player uses the in-game save menu there is genuinely nothing to
    // persist, and inventing an empty blob would make the host store noise.
    expect(session.save()).toBeNull();
  }, BOOT_TIMEOUT_MS);

  it("rejects a save blob it does not recognise", () => {
    // Saves outlive game updates, so refusing an unknown blob is the documented
    // ABI behaviour — booting a corrupt state would be far worse.
    expect(session.load(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  }, BOOT_TIMEOUT_MS);

  it("rejects a save archive whose entry runs past the buffer", () => {
    // Correct magic and version, then a name length that overruns the blob.
    const blob = new Uint8Array(16);
    const view = new DataView(blob.buffer);
    view.setUint32(0, 0x4d444243, true); // "CBDM"
    view.setUint32(4, 1, true); // version
    view.setUint32(8, 1, true); // one entry
    view.setUint32(12, 0xffff, true); // absurd name length

    expect(session.load(blob)).toBe(false);
  }, BOOT_TIMEOUT_MS);
});
