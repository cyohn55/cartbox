/**
 * WasmCartEngine — CartEngine backed by a real TIC-80 cartridge in WASM memory
 * (via the cbx_cart_* shim). This is the "thin memory view" the whole editor was
 * built to sit on: it translates the editor's one-index-per-pixel model to the
 * cartridge's on-disk formats — 4bpp-packed tiles, RGB palette triplets, one
 * byte per map cell, a NUL-terminated code buffer — and nothing else.
 *
 * WASM memory can grow (ALLOW_MEMORY_GROWTH), which replaces the HEAPU8 view
 * object, so we read `module.HEAPU8` fresh on every access. Byte offsets
 * (pointers) stay valid across growth, so the cart's base pointers are cached.
 */

import {
  BANK_COUNT,
  CartEngine,
  MaterialChannel,
  MATERIAL_BANK,
  MATERIAL_LEVELS,
  MUSIC_PATTERNS,
  MUSIC_PATTERN_ROWS,
  PIXELS_PER_TILE,
  SFX_COUNT,
  SFX_MAX_VALUE,
  SFX_TICKS,
  SpritePage,
  TILE_SIZE,
  WAVEFORM_COUNT,
  WAVEFORM_STEPS,
} from "./CartEngine";
import type { EditorModule } from "./wasmModule";
import { loadEditorModule } from "./wasmModule";
import { CLASSIC_MODEL, type ConsoleModelSpec } from "./consoleModel";
import { createTilePixelCodec, type TilePixelCodec } from "./tilePixelCodec";
import { seedDemoCart } from "../model/seed";

/** Cart language id <-> name (from api/lua.c, api/js.c, api/python.c). */
const LANG_BY_ID: Record<number, string> = { 10: "lua", 12: "js", 20: "python" };
const ID_BY_LANG: Record<string, number> = { lua: 10, js: 12, python: 20 };

export class WasmCartEngine implements CartEngine {
  // Bank-dependent base pointers, recomputed on setBank.
  private bank = 0;
  private tilesPtr = 0;
  private spritesPtr = 0;
  private mapPtr = 0;
  private palettePtr = 0;
  private sfxPtr = 0;
  private waveformsPtr = 0;
  private musicPatternsPtr = 0;

  // Bankless: code buffer, element strides, and the fixed normal-bank pointers.
  private readonly codePtr: number;
  private readonly codeCapacity: number;
  private readonly sfxStride: number;
  private readonly waveformStride: number;
  private readonly musicPatternStride: number;
  private readonly musicRowStride: number;
  private readonly materialPtrs: Record<MaterialChannel, { tiles: number; sprites: number }>;

  // Bit-depth-aware tile pixel packing and the model's palette limits.
  private readonly pixelCodec: TilePixelCodec;
  private readonly paletteSize: number;
  private readonly paletteBytes: number;

  constructor(
    private readonly module: EditorModule,
    private readonly cartPtr: number,
    private readonly consoleModel: ConsoleModelSpec = CLASSIC_MODEL,
  ) {
    this.pixelCodec = createTilePixelCodec(consoleModel.tilePixelBits, PIXELS_PER_TILE);
    this.paletteSize = consoleModel.paletteSize;
    this.paletteBytes = consoleModel.paletteSize * 3;
    this.codePtr = module._cbx_cart_code_ptr(cartPtr);
    this.codeCapacity = module._cbx_cart_code_capacity();
    this.sfxStride = module._cbx_cart_sfx_stride();
    this.waveformStride = module._cbx_cart_waveform_stride();
    this.musicPatternStride = module._cbx_cart_music_pattern_stride();
    this.musicRowStride = this.musicPatternStride / MUSIC_PATTERN_ROWS;
    const bankPointers = (bank: number) => ({
      tiles: module._cbx_cart_tiles_ptr(cartPtr, bank),
      sprites: module._cbx_cart_sprites_ptr(cartPtr, bank),
    });
    this.materialPtrs = {
      normal: bankPointers(MATERIAL_BANK.normal),
      height: bankPointers(MATERIAL_BANK.height),
      specular: bankPointers(MATERIAL_BANK.specular),
      roughness: bankPointers(MATERIAL_BANK.roughness),
      emissive: bankPointers(MATERIAL_BANK.emissive),
    };
    this.refreshBankPointers();
  }

  model(): ConsoleModelSpec {
    return this.consoleModel;
  }

  getBank(): number {
    return this.bank;
  }

  setBank(bank: number): void {
    if (bank >= 0 && bank < BANK_COUNT) {
      this.bank = bank;
      this.refreshBankPointers();
    }
  }

  private refreshBankPointers(): void {
    this.tilesPtr = this.module._cbx_cart_tiles_ptr(this.cartPtr, this.bank);
    this.spritesPtr = this.module._cbx_cart_sprites_ptr(this.cartPtr, this.bank);
    this.mapPtr = this.module._cbx_cart_map_ptr(this.cartPtr, this.bank);
    this.palettePtr = this.module._cbx_cart_palette_ptr(this.cartPtr, this.bank);
    this.sfxPtr = this.module._cbx_cart_sfx_ptr(this.cartPtr, this.bank);
    this.waveformsPtr = this.module._cbx_cart_waveforms_ptr(this.cartPtr, this.bank);
    this.musicPatternsPtr = this.module._cbx_cart_music_patterns_ptr(this.cartPtr, this.bank);
  }

  private heap(): Uint8Array {
    return this.module.HEAPU8;
  }

  private tileBaseOffset(page: SpritePage, tile: number): number {
    const base = page === 0 ? this.tilesPtr : this.spritesPtr;
    return base + tile * this.pixelCodec.bytesPerTile;
  }

  readTile(page: SpritePage, tile: number, out?: Uint8Array): Uint8Array {
    const target = out ?? new Uint8Array(PIXELS_PER_TILE);
    for (let pixel = 0; pixel < PIXELS_PER_TILE; pixel += 1) {
      target[pixel] = this.getPixel(page, tile, pixel % TILE_SIZE, Math.floor(pixel / TILE_SIZE));
    }
    return target;
  }

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    if (!this.inTile(x, y)) return 0;
    return this.pixelCodec.read(this.heap(), this.tileBaseOffset(page, tile), y * TILE_SIZE + x);
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, colorIndex: number): void {
    if (!this.inTile(x, y) || colorIndex < 0 || colorIndex >= this.paletteSize) return;
    this.pixelCodec.write(this.heap(), this.tileBaseOffset(page, tile), y * TILE_SIZE + x, colorIndex);
  }

  getPalette(out?: Uint8Array): Uint8Array {
    const target = out ?? new Uint8Array(this.paletteBytes);
    target.set(this.heap().subarray(this.palettePtr, this.palettePtr + this.paletteBytes));
    return target;
  }

  setPaletteColor(index: number, red: number, green: number, blue: number): void {
    if (index < 0 || index >= this.paletteSize) return;
    const clamp = (value: number) => Math.max(0, Math.min(255, value | 0));
    const heap = this.heap();
    const base = this.palettePtr + index * 3;
    heap[base] = clamp(red);
    heap[base + 1] = clamp(green);
    heap[base + 2] = clamp(blue);
  }

  getMapCell(x: number, y: number): number {
    if (!this.inMap(x, y)) return 0;
    return this.heap()[this.mapPtr + y * this.consoleModel.mapWidth + x] ?? 0;
  }

  setMapCell(x: number, y: number, tile: number): void {
    if (!this.inMap(x, y) || tile < 0 || tile > 0xff) return;
    this.heap()[this.mapPtr + y * this.consoleModel.mapWidth + x] = tile;
  }

  getCode(): string {
    const heap = this.heap();
    const limit = this.codePtr + this.codeCapacity;
    let end = this.codePtr;
    while (end < limit && heap[end] !== 0) end += 1;
    // slice(), not subarray(): the Emscripten heap grows, and TextDecoder
    // refuses views over resizable ArrayBuffers (Chrome 149+). Copying the
    // code bytes detaches them from the growable memory.
    return new TextDecoder().decode(heap.slice(this.codePtr, end));
  }

  setCode(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const length = Math.min(bytes.length, this.codeCapacity - 1);
    const heap = this.heap();
    heap.set(bytes.subarray(0, length), this.codePtr);
    heap[this.codePtr + length] = 0;
  }

  getLanguage(): string {
    return LANG_BY_ID[this.module._cbx_cart_get_lang(this.cartPtr)] ?? "lua";
  }

  setLanguage(language: string): void {
    this.module._cbx_cart_set_lang(this.cartPtr, ID_BY_LANG[language] ?? 10);
  }

  // Each SFX envelope tick is two packed bytes; byte 0 holds volume (low nibble)
  // and waveform (high nibble). See tic_sample in tic.h.
  private sfxByteOffset(sample: number, tick: number): number {
    return this.sfxPtr + sample * this.sfxStride + tick * 2;
  }

  getSfxVolume(sample: number, tick: number): number {
    if (!inSfxRange(sample, tick)) return 0;
    return (this.heap()[this.sfxByteOffset(sample, tick)] ?? 0) & 0x0f;
  }

  setSfxVolume(sample: number, tick: number, value: number): void {
    if (!inSfxRange(sample, tick)) return;
    const heap = this.heap();
    const offset = this.sfxByteOffset(sample, tick);
    heap[offset] = ((heap[offset] ?? 0) & 0xf0) | (clampSfx(value) & 0x0f);
  }

  getSfxWave(sample: number, tick: number): number {
    if (!inSfxRange(sample, tick)) return 0;
    return ((this.heap()[this.sfxByteOffset(sample, tick)] ?? 0) >> 4) & 0x0f;
  }

  setSfxWave(sample: number, tick: number, value: number): void {
    if (!inSfxRange(sample, tick)) return;
    const heap = this.heap();
    const offset = this.sfxByteOffset(sample, tick);
    heap[offset] = ((heap[offset] ?? 0) & 0x0f) | ((clampSfx(value) & 0x0f) << 4);
  }

  // Material channels live in their bank's sprite pages, stored in tiles like
  // pixels (same bit depth), but the value is a direction/ramp index, not colour.
  private materialTileBaseOffset(channel: MaterialChannel, page: SpritePage, tile: number): number {
    const ptr = this.materialPtrs[channel];
    const base = page === 0 ? ptr.tiles : ptr.sprites;
    return base + tile * this.pixelCodec.bytesPerTile;
  }

  getNormal(page: SpritePage, tile: number, x: number, y: number): number {
    return this.getMaterial("normal", page, tile, x, y);
  }

  setNormal(page: SpritePage, tile: number, x: number, y: number, direction: number): void {
    this.setMaterial("normal", page, tile, x, y, direction);
  }

  getMaterial(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number): number {
    if (!this.inTile(x, y)) return 0;
    return this.pixelCodec.read(this.heap(), this.materialTileBaseOffset(channel, page, tile), y * TILE_SIZE + x);
  }

  setMaterial(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number, value: number): void {
    if (!this.inTile(x, y) || value < 0 || value >= MATERIAL_LEVELS) return;
    this.pixelCodec.write(this.heap(), this.materialTileBaseOffset(channel, page, tile), y * TILE_SIZE + x, value);
  }

  getMusicFramePattern(track: number, frame: number, channel: number): number {
    return this.module._cbx_cart_music_pattern_id(this.cartPtr, this.bank, track, frame, channel);
  }

  setMusicFramePattern(track: number, frame: number, channel: number, id: number): void {
    this.module._cbx_cart_music_set_pattern_id(this.cartPtr, this.bank, track, frame, channel, id);
  }

  getSfxLoopStart(sample: number, channel: number): number {
    return this.module._cbx_cart_sfx_loop_start(this.cartPtr, this.bank, sample, channel);
  }

  setSfxLoopStart(sample: number, channel: number, value: number): void {
    this.module._cbx_cart_sfx_set_loop_start(this.cartPtr, this.bank, sample, channel, value);
  }

  getSfxLoopSize(sample: number, channel: number): number {
    return this.module._cbx_cart_sfx_loop_size(this.cartPtr, this.bank, sample, channel);
  }

  setSfxLoopSize(sample: number, channel: number, value: number): void {
    this.module._cbx_cart_sfx_set_loop_size(this.cartPtr, this.bank, sample, channel, value);
  }

  // Waveform steps pack two per byte (even step low nibble), like SFX.
  private waveformByteOffset(waveform: number, step: number): number {
    return this.waveformsPtr + waveform * this.waveformStride + (step >> 1);
  }

  getWaveformSample(waveform: number, step: number): number {
    if (!inWaveformRange(waveform, step)) return 0;
    const byte = this.heap()[this.waveformByteOffset(waveform, step)] ?? 0;
    return step & 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
  }

  setWaveformSample(waveform: number, step: number, value: number): void {
    if (!inWaveformRange(waveform, step)) return;
    const heap = this.heap();
    const offset = this.waveformByteOffset(waveform, step);
    const byte = heap[offset] ?? 0;
    heap[offset] = step & 1 ? (byte & 0x0f) | ((clampSfx(value) & 0x0f) << 4) : (byte & 0xf0) | (clampSfx(value) & 0x0f);
  }

  // A music row is three packed bytes (tic_track_row in tic.h):
  //   byte 0: note:4 | param1:4
  //   byte 1: param2:4 | command:3 | sfxhi:1
  //   byte 2: sfxlow:5 | octave:3
  private musicRowOffset(pattern: number, row: number): number {
    return this.musicPatternsPtr + pattern * this.musicPatternStride + row * this.musicRowStride;
  }

  getMusicNoteField(pattern: number, row: number): number {
    if (!inMusicRange(pattern, row)) return 0;
    return (this.heap()[this.musicRowOffset(pattern, row)] ?? 0) & 0x0f;
  }

  setMusicNoteField(pattern: number, row: number, value: number): void {
    if (!inMusicRange(pattern, row)) return;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row);
    heap[offset] = ((heap[offset] ?? 0) & 0xf0) | (value & 0x0f);
  }

  getMusicOctave(pattern: number, row: number): number {
    if (!inMusicRange(pattern, row)) return 0;
    return ((this.heap()[this.musicRowOffset(pattern, row) + 2] ?? 0) >> 5) & 0x07;
  }

  setMusicOctave(pattern: number, row: number, value: number): void {
    if (!inMusicRange(pattern, row)) return;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row) + 2;
    heap[offset] = ((heap[offset] ?? 0) & 0x1f) | ((value & 0x07) << 5);
  }

  getMusicSfx(pattern: number, row: number): number {
    if (!inMusicRange(pattern, row)) return 0;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row);
    const sfxHigh = ((heap[offset + 1] ?? 0) >> 7) & 0x01;
    const sfxLow = (heap[offset + 2] ?? 0) & 0x1f;
    return (sfxHigh << 5) | sfxLow;
  }

  setMusicSfx(pattern: number, row: number, value: number): void {
    if (!inMusicRange(pattern, row)) return;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row);
    heap[offset + 1] = ((heap[offset + 1] ?? 0) & 0x7f) | (((value >> 5) & 0x01) << 7);
    heap[offset + 2] = ((heap[offset + 2] ?? 0) & 0xe0) | (value & 0x1f);
  }

  getMusicCommand(pattern: number, row: number): number {
    if (!inMusicRange(pattern, row)) return 0;
    return ((this.heap()[this.musicRowOffset(pattern, row) + 1] ?? 0) >> 4) & 0x07;
  }

  setMusicCommand(pattern: number, row: number, value: number): void {
    if (!inMusicRange(pattern, row)) return;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row) + 1;
    // 0x8F preserves sfxhi (bit 7) and param2 (bits 0-3).
    heap[offset] = ((heap[offset] ?? 0) & 0x8f) | ((value & 0x07) << 4);
  }

  getMusicParam(pattern: number, row: number): number {
    if (!inMusicRange(pattern, row)) return 0;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row);
    const paramX = ((heap[offset] ?? 0) >> 4) & 0x0f; // byte 0 high nibble
    const paramY = (heap[offset + 1] ?? 0) & 0x0f; // byte 1 low nibble
    return (paramX << 4) | paramY;
  }

  setMusicParam(pattern: number, row: number, value: number): void {
    if (!inMusicRange(pattern, row)) return;
    const heap = this.heap();
    const offset = this.musicRowOffset(pattern, row);
    heap[offset] = ((heap[offset] ?? 0) & 0x0f) | (((value >> 4) & 0x0f) << 4); // preserve note
    heap[offset + 1] = ((heap[offset + 1] ?? 0) & 0xf0) | (value & 0x0f); // preserve command + sfxhi
  }

  /** Replace the whole cartridge from serialised .tic bytes. */
  loadTic(bytes: Uint8Array): void {
    const buffer = this.module._malloc(bytes.length);
    this.module.HEAPU8.set(bytes, buffer);
    this.module._cbx_cart_load(this.cartPtr, buffer, bytes.length);
    this.module._free(buffer);
  }

  /** Serialise the current cartridge to .tic bytes for the player/marketplace. */
  saveTic(): Uint8Array {
    const capacity = this.module._cbx_cart_bytesize();
    const out = this.module._malloc(capacity);
    const size = this.module._cbx_cart_save(this.cartPtr, out);
    const bytes = this.module.HEAPU8.slice(out, out + size);
    this.module._free(out);
    return new Uint8Array(bytes);
  }

  /** Frees the underlying cartridge. The engine is unusable afterwards. */
  dispose(): void {
    this.module._cbx_cart_delete(this.cartPtr);
  }

  private inTile(x: number, y: number): boolean {
    return x >= 0 && x < TILE_SIZE && y >= 0 && y < TILE_SIZE;
  }

  private inMap(x: number, y: number): boolean {
    return x >= 0 && x < this.consoleModel.mapWidth && y >= 0 && y < this.consoleModel.mapHeight;
  }
}

function inSfxRange(sample: number, tick: number): boolean {
  return sample >= 0 && sample < SFX_COUNT && tick >= 0 && tick < SFX_TICKS;
}

function clampSfx(value: number): number {
  return Math.max(0, Math.min(SFX_MAX_VALUE, value | 0));
}

function inMusicRange(pattern: number, row: number): boolean {
  return pattern >= 0 && pattern < MUSIC_PATTERNS && row >= 0 && row < MUSIC_PATTERN_ROWS;
}

function inWaveformRange(waveform: number, step: number): boolean {
  return waveform >= 0 && waveform < WAVEFORM_COUNT && step >= 0 && step < WAVEFORM_STEPS;
}

/** Creates a fresh, demo-seeded cart engine from an already-loaded module. */
export function createWasmCartEngine(
  module: EditorModule,
  model: ConsoleModelSpec = CLASSIC_MODEL,
): WasmCartEngine {
  const cartPtr = module._cbx_cart_create();
  if (cartPtr === 0) {
    throw new Error("engine: cbx_cart_create returned null");
  }
  const engine = new WasmCartEngine(module, cartPtr, model);
  seedDemoCart(engine);
  return engine;
}

/**
 * Loads the engine module from a URL and returns a ready cart engine. The model
 * must match the binary at engineUrl (e.g. the Pro core with PRO_MODEL); it sets
 * the geometry every editor surface reads (palette size, canvas, sound).
 */
export async function loadWasmCartEngine(
  engineUrl: string,
  model: ConsoleModelSpec = CLASSIC_MODEL,
): Promise<WasmCartEngine> {
  const module = await loadEditorModule(engineUrl);
  return createWasmCartEngine(module, model);
}
