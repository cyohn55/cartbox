/**
 * WasmCartEngine tests — the real proof that the editor's CartEngine boundary
 * sits correctly on top of the TIC-80 WASM cartridge. These load the actual
 * built engine (packages/engine/dist/tic80.js) and assert on observable
 * behaviour: 4bpp pixel packing, palette/map/code round-trips, and — the
 * headline — that edits survive .tic serialisation and reload.
 *
 * Skips itself (with a warning) if the engine has not been built yet, so the
 * suite still runs on a machine without the WASM toolchain.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createWasmCartEngine,
  loadEditorModule,
  type EditorModule,
  type WasmCartEngine,
} from "@cartbox/editor";
import { createConsole, getModel, loadEngineModule } from "@cartbox/player";

const enginePath = fileURLToPath(
  new URL("../packages/engine/dist/tic80.js", import.meta.url),
);
const built = existsSync(enginePath);
const suite = built ? describe : describe.skip;
if (!built) {
  console.warn(`[wasm-cart-engine] engine not built at ${enginePath}; skipping. Run npm run engine:build:wasm.`);
}

suite("WasmCartEngine over the real TIC-80 WASM cart", () => {
  let module: EditorModule;

  beforeAll(async () => {
    module = await loadEditorModule(pathToFileURL(enginePath).href);
  }, 30000);

  const fresh = (): WasmCartEngine => createWasmCartEngine(module);

  it("packs two 4bpp pixels into one byte without cross-talk", () => {
    const engine = fresh();
    // (0,0) and (1,0) share a byte (low and high nibble).
    engine.setPixel(0, 7, 0, 0, 5);
    engine.setPixel(0, 7, 1, 0, 10);
    expect(engine.getPixel(0, 7, 0, 0)).toBe(5);
    expect(engine.getPixel(0, 7, 1, 0)).toBe(10);
    expect(engine.getPixel(0, 7, 2, 0)).toBe(0);
  });

  it("keeps the tiles and sprites pages independent", () => {
    const engine = fresh();
    engine.setPixel(0, 3, 4, 4, 6);
    engine.setPixel(1, 3, 4, 4, 9);
    expect(engine.getPixel(0, 3, 4, 4)).toBe(6);
    expect(engine.getPixel(1, 3, 4, 4)).toBe(9);
  });

  it("round-trips palette, map, code, and language", () => {
    const engine = fresh();
    engine.setPaletteColor(2, 200, 100, 50);
    expect(Array.from(engine.getPalette().slice(6, 9))).toEqual([200, 100, 50]);

    engine.setMapCell(40, 20, 3);
    expect(engine.getMapCell(40, 20)).toBe(3);

    engine.setCode("x=42\n");
    expect(engine.getCode()).toBe("x=42\n");

    engine.setLanguage("js");
    expect(engine.getLanguage()).toBe("js");
  });

  it("packs SFX volume and waveform into the same byte without cross-talk", () => {
    const engine = fresh();
    // Volume (low nibble) and waveform (high nibble) share a byte per tick.
    engine.setSfxVolume(9, 4, 13);
    engine.setSfxWave(9, 4, 6);
    expect(engine.getSfxVolume(9, 4)).toBe(13);
    expect(engine.getSfxWave(9, 4)).toBe(6);
  });

  it("packs adjacent waveform steps into one byte without cross-talk", () => {
    const engine = fresh();
    engine.setWaveformSample(4, 6, 15); // even step, low nibble
    engine.setWaveformSample(4, 7, 3); // odd step, high nibble (same byte)
    expect(engine.getWaveformSample(4, 6)).toBe(15);
    expect(engine.getWaveformSample(4, 7)).toBe(3);
  });

  it("packs 6-bit channel patterns across a frame and serialises them", () => {
    const source = fresh();
    // Four channels, 6 bits each, packed across the frame's 3 bytes.
    source.setMusicFramePattern(2, 5, 0, 1);
    source.setMusicFramePattern(2, 5, 1, 22);
    source.setMusicFramePattern(2, 5, 2, 40);
    source.setMusicFramePattern(2, 5, 3, 63);
    expect(source.getMusicFramePattern(2, 5, 0)).toBe(1);
    expect(source.getMusicFramePattern(2, 5, 1)).toBe(22);
    expect(source.getMusicFramePattern(2, 5, 2)).toBe(40);
    expect(source.getMusicFramePattern(2, 5, 3)).toBe(63);

    const restored = fresh();
    restored.loadTic(source.saveTic());
    expect(restored.getMusicFramePattern(2, 5, 2)).toBe(40);
    expect(restored.getMusicFramePattern(2, 5, 3)).toBe(63);
  });

  it("packs an SFX loop's start and size into one byte and serialises them", () => {
    const source = fresh();
    // Channel 1 (volume). start (low nibble) and size (high nibble) share a byte.
    source.setSfxLoopStart(3, 1, 5);
    source.setSfxLoopSize(3, 1, 9);
    expect(source.getSfxLoopStart(3, 1)).toBe(5);
    expect(source.getSfxLoopSize(3, 1)).toBe(9);

    const restored = fresh();
    restored.loadTic(source.saveTic());
    expect(restored.getSfxLoopStart(3, 1)).toBe(5);
    expect(restored.getSfxLoopSize(3, 1)).toBe(9);
  });

  it("packs a music row's note, octave, 6-bit SFX, command, and param independently", () => {
    const engine = fresh();
    // All five fields share the same three bytes; set them and confirm none
    // clobbers another (SFX 42 exercises the sfxhi/sfxlow split; param 0xAB the
    // two nibbles in bytes 0 and 1).
    engine.setMusicNoteField(7, 3, 9);
    engine.setMusicOctave(7, 3, 5);
    engine.setMusicSfx(7, 3, 42);
    engine.setMusicCommand(7, 3, 6);
    engine.setMusicParam(7, 3, 0xab);
    expect(engine.getMusicNoteField(7, 3)).toBe(9);
    expect(engine.getMusicOctave(7, 3)).toBe(5);
    expect(engine.getMusicSfx(7, 3)).toBe(42);
    expect(engine.getMusicCommand(7, 3)).toBe(6);
    expect(engine.getMusicParam(7, 3)).toBe(0xab);
  });

  it("opens seeded from the demo cart", () => {
    const engine = fresh();
    expect(engine.getCode()).toContain("function TIC()");
    expect(engine.getLanguage()).toBe("lua");
  });

  it("isolates banks and survives a save/reload on a non-zero bank", () => {
    const source = fresh();
    source.setBank(0);
    source.setPixel(0, 8, 0, 0, 5);
    source.setBank(3);
    source.setPixel(0, 8, 0, 0, 12);
    expect(source.getPixel(0, 8, 0, 0)).toBe(12);
    source.setBank(0);
    expect(source.getPixel(0, 8, 0, 0)).toBe(5); // bank 0 untouched by bank 3

    const restored = fresh();
    restored.loadTic(source.saveTic());
    restored.setBank(3);
    expect(restored.getPixel(0, 8, 0, 0)).toBe(12);
  });

  it("stores normals in the normal bank and serialises them", () => {
    const source = fresh();
    source.setNormal(0, 9, 3, 4, 6);
    expect(source.getNormal(0, 9, 3, 4)).toBe(6);
    expect(source.getPixel(0, 9, 3, 4)).toBe(0); // current (game) bank untouched

    const restored = fresh();
    restored.loadTic(source.saveTic());
    expect(restored.getNormal(0, 9, 3, 4)).toBe(6);
  });

  it("survives a .tic save and reload", () => {
    // Pixels, map, and code are the substantive cart data and round-trip
    // through .tic serialisation. Language is intentionally not asserted here:
    // TIC-80 carries a text cart's language in its `-- script:` header comment,
    // and its binary CHUNK_LANG save path has an upstream bug (the buffer
    // pointer is not advanced), so the field does not survive serialisation.
    // Header-driven language is handled when wiring save/publish.
    const source = fresh();
    source.setPixel(0, 12, 2, 3, 11);
    source.setMapCell(5, 6, 7);
    source.setSfxVolume(2, 0, 14);
    source.setMusicNoteField(1, 0, 8);
    source.setMusicOctave(1, 0, 3);
    source.setCode("-- title: saved\n-- script: lua\ncls(9)\n");

    const bytes = source.saveTic();
    expect(bytes.length).toBeGreaterThan(0);

    const restored = fresh();
    restored.loadTic(bytes);
    expect(restored.getPixel(0, 12, 2, 3)).toBe(11);
    expect(restored.getMapCell(5, 6)).toBe(7);
    expect(restored.getSfxVolume(2, 0)).toBe(14);
    expect(restored.getMusicNoteField(1, 0)).toBe(8);
    expect(restored.getMusicOctave(1, 0)).toBe(3);
    expect(restored.getCode()).toContain("cls(9)");
  });

  it("round-trips every subsystem through one .tic save and reload", () => {
    const source = fresh();
    source.setPixel(0, 4, 1, 1, 5); // tiles page
    source.setPixel(1, 4, 2, 2, 9); // sprites page
    source.setBank(3);
    source.setPixel(0, 4, 1, 1, 12); // another bank
    source.setBank(0);
    source.setPaletteColor(7, 33, 66, 99);
    source.setMapCell(20, 20, 42);
    source.setCode("-- all\ncls(3)\n");
    source.setSfxVolume(5, 3, 11);
    source.setSfxWave(5, 3, 4);
    source.setSfxLoopStart(5, 1, 2);
    source.setSfxLoopSize(5, 1, 7);
    source.setWaveformSample(2, 10, 13);
    source.setMusicNoteField(1, 8, 9);
    source.setMusicOctave(1, 8, 5);
    source.setMusicSfx(1, 8, 33);
    source.setMusicCommand(1, 8, 6);
    source.setMusicParam(1, 8, 0xab);
    source.setMusicFramePattern(2, 4, 3, 17);
    source.setNormal(0, 4, 3, 3, 8);

    const restored = fresh();
    restored.loadTic(source.saveTic());
    expect(restored.getPixel(0, 4, 1, 1)).toBe(5);
    expect(restored.getPixel(1, 4, 2, 2)).toBe(9);
    restored.setBank(3);
    expect(restored.getPixel(0, 4, 1, 1)).toBe(12);
    restored.setBank(0);
    expect(Array.from(restored.getPalette().slice(21, 24))).toEqual([33, 66, 99]);
    expect(restored.getMapCell(20, 20)).toBe(42);
    expect(restored.getCode()).toContain("cls(3)");
    expect(restored.getSfxVolume(5, 3)).toBe(11);
    expect(restored.getSfxWave(5, 3)).toBe(4);
    expect(restored.getSfxLoopStart(5, 1)).toBe(2);
    expect(restored.getSfxLoopSize(5, 1)).toBe(7);
    expect(restored.getWaveformSample(2, 10)).toBe(13);
    expect(restored.getMusicNoteField(1, 8)).toBe(9);
    expect(restored.getMusicOctave(1, 8)).toBe(5);
    expect(restored.getMusicSfx(1, 8)).toBe(33);
    expect(restored.getMusicCommand(1, 8)).toBe(6);
    expect(restored.getMusicParam(1, 8)).toBe(0xab);
    expect(restored.getMusicFramePattern(2, 4, 3)).toBe(17);
    expect(restored.getNormal(0, 4, 3, 3)).toBe(8);
  });

  it("runs the edited cart in the player and renders a frame", async () => {
    // The Run path end to end: serialise the seeded cart and run those exact
    // bytes through the player runtime, then confirm the framebuffer is not a
    // flat colour (the demo draws rings, a sprite, and text).
    const bytes = fresh().saveTic();
    const playerModule = await loadEngineModule(pathToFileURL(enginePath).href);
    const console_ = createConsole(playerModule, getModel("classic"));

    expect(console_.loadCartridge(bytes)).toBe(true);
    for (let frame = 0; frame < 30; frame += 1) console_.tick(0);

    const framebuffer = console_.readFramebuffer();
    const firstByte = framebuffer[0];
    expect(framebuffer.some((value) => value !== firstByte)).toBe(true);

    console_.dispose();
  }, 30000);
});
