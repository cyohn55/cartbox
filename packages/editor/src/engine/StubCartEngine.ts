/**
 * In-memory CartEngine used when the WASM engine is unavailable and by the unit
 * tests. It stores palette indices one byte per pixel (the real engine packs two
 * per byte at 4bpp; the editor never sees that difference because it goes through
 * this interface). Storage is per bank; accessors read and write the current
 * bank, so switching banks changes nothing above this line — exactly like the
 * WASM engine.
 */

import {
  BANK_COUNT,
  MATERIAL_BANK,
  MATERIAL_LEVELS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MUSIC_CHANNELS,
  MUSIC_FRAMES,
  MUSIC_PATTERNS,
  MUSIC_PATTERN_ROWS,
  MUSIC_TRACKS,
  PALETTE_BYTES,
  PIXELS_PER_TILE,
  PALETTE_SIZE,
  SFX_COUNT,
  SFX_LOOP_CHANNELS,
  SFX_MAX_VALUE,
  SFX_TICKS,
  SPRITE_PAGES,
  TILES_PER_PAGE,
  TILE_SIZE,
  WAVEFORM_COUNT,
  WAVEFORM_STEPS,
} from "./CartEngine";
import type { CartEngine, MaterialChannel, SpritePage } from "./CartEngine";
import { CLASSIC_MODEL, type ConsoleModelSpec } from "./consoleModel";
import { seedDemoCart } from "../model/seed";

const PIXELS_PER_BANK = SPRITE_PAGES * TILES_PER_PAGE * PIXELS_PER_TILE;
const MAP_CELLS_PER_BANK = MAP_WIDTH * MAP_HEIGHT;
const SFX_CELLS_PER_BANK = SFX_COUNT * SFX_TICKS;
const SFX_LOOP_CELLS_PER_BANK = SFX_COUNT * SFX_LOOP_CHANNELS;
const MUSIC_CELLS_PER_BANK = MUSIC_PATTERNS * MUSIC_PATTERN_ROWS;
const ARRANGE_CELLS_PER_BANK = MUSIC_TRACKS * MUSIC_FRAMES * MUSIC_CHANNELS;
const WAVEFORM_CELLS_PER_BANK = WAVEFORM_COUNT * WAVEFORM_STEPS;

export class StubCartEngine implements CartEngine {
  private readonly pixels = new Uint8Array(BANK_COUNT * PIXELS_PER_BANK);
  private readonly palette = new Uint8Array(BANK_COUNT * PALETTE_BYTES);
  private readonly map = new Uint8Array(BANK_COUNT * MAP_CELLS_PER_BANK);
  private readonly sfxVolume = new Uint8Array(BANK_COUNT * SFX_CELLS_PER_BANK);
  private readonly sfxWave = new Uint8Array(BANK_COUNT * SFX_CELLS_PER_BANK);
  private readonly sfxLoopStart = new Uint8Array(BANK_COUNT * SFX_LOOP_CELLS_PER_BANK);
  private readonly sfxLoopSize = new Uint8Array(BANK_COUNT * SFX_LOOP_CELLS_PER_BANK);
  private readonly musicNote = new Uint8Array(BANK_COUNT * MUSIC_CELLS_PER_BANK);
  private readonly musicOctave = new Uint8Array(BANK_COUNT * MUSIC_CELLS_PER_BANK);
  private readonly musicSfx = new Uint8Array(BANK_COUNT * MUSIC_CELLS_PER_BANK);
  private readonly musicCommand = new Uint8Array(BANK_COUNT * MUSIC_CELLS_PER_BANK);
  private readonly musicParam = new Uint8Array(BANK_COUNT * MUSIC_CELLS_PER_BANK);
  private readonly framePattern = new Uint8Array(BANK_COUNT * ARRANGE_CELLS_PER_BANK);
  private readonly waveforms = new Uint8Array(BANK_COUNT * WAVEFORM_CELLS_PER_BANK);
  private bank = 0;
  private code = "";
  private language = "lua";

  constructor() {
    seedDemoCart(this);
  }

  model(): ConsoleModelSpec {
    return CLASSIC_MODEL;
  }

  getBank(): number {
    return this.bank;
  }

  setBank(bank: number): void {
    if (bank >= 0 && bank < BANK_COUNT) this.bank = bank;
  }

  readTile(page: SpritePage, tile: number, out?: Uint8Array): Uint8Array {
    const target = out ?? new Uint8Array(PIXELS_PER_TILE);
    const base = this.pixelBase(page, tile);
    target.set(this.pixels.subarray(base, base + PIXELS_PER_TILE));
    return target;
  }

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    if (!this.inTile(x, y)) return 0;
    return this.pixels[this.pixelBase(page, tile) + y * TILE_SIZE + x] ?? 0;
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, colorIndex: number): void {
    if (!this.inTile(x, y) || colorIndex < 0 || colorIndex >= PALETTE_SIZE) return;
    this.pixels[this.pixelBase(page, tile) + y * TILE_SIZE + x] = colorIndex;
  }

  getPalette(out?: Uint8Array): Uint8Array {
    const target = out ?? new Uint8Array(PALETTE_BYTES);
    const base = this.bank * PALETTE_BYTES;
    target.set(this.palette.subarray(base, base + PALETTE_BYTES));
    return target;
  }

  setPaletteColor(index: number, red: number, green: number, blue: number): void {
    if (index < 0 || index >= PALETTE_SIZE) return;
    const clamp = (value: number) => Math.max(0, Math.min(255, value | 0));
    const base = this.bank * PALETTE_BYTES + index * 3;
    this.palette[base] = clamp(red);
    this.palette[base + 1] = clamp(green);
    this.palette[base + 2] = clamp(blue);
  }

  getMapCell(x: number, y: number): number {
    if (!this.inMap(x, y)) return 0;
    return this.map[this.bank * MAP_CELLS_PER_BANK + y * MAP_WIDTH + x] ?? 0;
  }

  setMapCell(x: number, y: number, tile: number): void {
    if (!this.inMap(x, y) || tile < 0 || tile >= TILES_PER_PAGE) return;
    this.map[this.bank * MAP_CELLS_PER_BANK + y * MAP_WIDTH + x] = tile;
  }

  getCode(): string {
    return this.code;
  }

  setCode(text: string): void {
    this.code = text;
  }

  getLanguage(): string {
    return this.language;
  }

  setLanguage(language: string): void {
    this.language = language;
  }

  getSfxVolume(sample: number, tick: number): number {
    if (!this.inSfx(sample, tick)) return 0;
    return this.sfxVolume[this.sfxIndex(sample, tick)] ?? 0;
  }

  setSfxVolume(sample: number, tick: number, value: number): void {
    if (!this.inSfx(sample, tick)) return;
    this.sfxVolume[this.sfxIndex(sample, tick)] = clampNibble(value);
  }

  getSfxWave(sample: number, tick: number): number {
    if (!this.inSfx(sample, tick)) return 0;
    return this.sfxWave[this.sfxIndex(sample, tick)] ?? 0;
  }

  setSfxWave(sample: number, tick: number, value: number): void {
    if (!this.inSfx(sample, tick)) return;
    this.sfxWave[this.sfxIndex(sample, tick)] = clampNibble(value);
  }

  getSfxLoopStart(sample: number, channel: number): number {
    if (!this.inSfxLoop(sample, channel)) return 0;
    return this.sfxLoopStart[this.sfxLoopIndex(sample, channel)] ?? 0;
  }

  setSfxLoopStart(sample: number, channel: number, value: number): void {
    if (!this.inSfxLoop(sample, channel)) return;
    this.sfxLoopStart[this.sfxLoopIndex(sample, channel)] = value & 0x0f;
  }

  getSfxLoopSize(sample: number, channel: number): number {
    if (!this.inSfxLoop(sample, channel)) return 0;
    return this.sfxLoopSize[this.sfxLoopIndex(sample, channel)] ?? 0;
  }

  setSfxLoopSize(sample: number, channel: number, value: number): void {
    if (!this.inSfxLoop(sample, channel)) return;
    this.sfxLoopSize[this.sfxLoopIndex(sample, channel)] = value & 0x0f;
  }

  getWaveformSample(waveform: number, step: number): number {
    if (!this.inWaveform(waveform, step)) return 0;
    return this.waveforms[this.waveformIndex(waveform, step)] ?? 0;
  }

  setWaveformSample(waveform: number, step: number, value: number): void {
    if (!this.inWaveform(waveform, step)) return;
    this.waveforms[this.waveformIndex(waveform, step)] = clampNibble(value);
  }

  getMusicNoteField(pattern: number, row: number): number {
    if (!this.inMusic(pattern, row)) return 0;
    return this.musicNote[this.musicIndex(pattern, row)] ?? 0;
  }

  setMusicNoteField(pattern: number, row: number, value: number): void {
    if (!this.inMusic(pattern, row)) return;
    this.musicNote[this.musicIndex(pattern, row)] = value & 0x0f;
  }

  getMusicOctave(pattern: number, row: number): number {
    if (!this.inMusic(pattern, row)) return 0;
    return this.musicOctave[this.musicIndex(pattern, row)] ?? 0;
  }

  setMusicOctave(pattern: number, row: number, value: number): void {
    if (!this.inMusic(pattern, row)) return;
    this.musicOctave[this.musicIndex(pattern, row)] = value & 0x07;
  }

  getMusicSfx(pattern: number, row: number): number {
    if (!this.inMusic(pattern, row)) return 0;
    return this.musicSfx[this.musicIndex(pattern, row)] ?? 0;
  }

  setMusicSfx(pattern: number, row: number, value: number): void {
    if (!this.inMusic(pattern, row)) return;
    this.musicSfx[this.musicIndex(pattern, row)] = value & 0x3f;
  }

  getMusicCommand(pattern: number, row: number): number {
    if (!this.inMusic(pattern, row)) return 0;
    return this.musicCommand[this.musicIndex(pattern, row)] ?? 0;
  }

  setMusicCommand(pattern: number, row: number, value: number): void {
    if (!this.inMusic(pattern, row)) return;
    this.musicCommand[this.musicIndex(pattern, row)] = value & 0x07;
  }

  getMusicParam(pattern: number, row: number): number {
    if (!this.inMusic(pattern, row)) return 0;
    return this.musicParam[this.musicIndex(pattern, row)] ?? 0;
  }

  setMusicParam(pattern: number, row: number, value: number): void {
    if (!this.inMusic(pattern, row)) return;
    this.musicParam[this.musicIndex(pattern, row)] = value & 0xff;
  }

  getNormal(page: SpritePage, tile: number, x: number, y: number): number {
    return this.getMaterial("normal", page, tile, x, y);
  }

  setNormal(page: SpritePage, tile: number, x: number, y: number, direction: number): void {
    this.setMaterial("normal", page, tile, x, y, direction);
  }

  getMaterial(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number): number {
    if (!this.inTile(x, y)) return 0;
    return this.pixels[this.materialIndex(channel, page, tile, x, y)] ?? 0;
  }

  setMaterial(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number, value: number): void {
    if (!this.inTile(x, y) || value < 0 || value >= MATERIAL_LEVELS) return;
    this.pixels[this.materialIndex(channel, page, tile, x, y)] = value;
  }

  private materialIndex(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number): number {
    const clampedTile = Math.max(0, Math.min(TILES_PER_PAGE - 1, tile));
    return (
      MATERIAL_BANK[channel] * PIXELS_PER_BANK +
      (page * TILES_PER_PAGE + clampedTile) * PIXELS_PER_TILE +
      y * TILE_SIZE +
      x
    );
  }

  getMusicFramePattern(track: number, frame: number, channel: number): number {
    if (!this.inArrange(track, frame, channel)) return 0;
    return this.framePattern[this.arrangeIndex(track, frame, channel)] ?? 0;
  }

  setMusicFramePattern(track: number, frame: number, channel: number, id: number): void {
    if (!this.inArrange(track, frame, channel)) return;
    this.framePattern[this.arrangeIndex(track, frame, channel)] = id & 0x3f;
  }

  private pixelBase(page: SpritePage, tile: number): number {
    const clampedTile = Math.max(0, Math.min(TILES_PER_PAGE - 1, tile));
    return this.bank * PIXELS_PER_BANK + (page * TILES_PER_PAGE + clampedTile) * PIXELS_PER_TILE;
  }

  private sfxIndex(sample: number, tick: number): number {
    return this.bank * SFX_CELLS_PER_BANK + sample * SFX_TICKS + tick;
  }

  private musicIndex(pattern: number, row: number): number {
    return this.bank * MUSIC_CELLS_PER_BANK + pattern * MUSIC_PATTERN_ROWS + row;
  }

  private waveformIndex(waveform: number, step: number): number {
    return this.bank * WAVEFORM_CELLS_PER_BANK + waveform * WAVEFORM_STEPS + step;
  }

  private sfxLoopIndex(sample: number, channel: number): number {
    return this.bank * SFX_LOOP_CELLS_PER_BANK + sample * SFX_LOOP_CHANNELS + channel;
  }

  private inSfxLoop(sample: number, channel: number): boolean {
    return sample >= 0 && sample < SFX_COUNT && channel >= 0 && channel < SFX_LOOP_CHANNELS;
  }

  private arrangeIndex(track: number, frame: number, channel: number): number {
    return (
      this.bank * ARRANGE_CELLS_PER_BANK +
      track * (MUSIC_FRAMES * MUSIC_CHANNELS) +
      frame * MUSIC_CHANNELS +
      channel
    );
  }

  private inArrange(track: number, frame: number, channel: number): boolean {
    return (
      track >= 0 &&
      track < MUSIC_TRACKS &&
      frame >= 0 &&
      frame < MUSIC_FRAMES &&
      channel >= 0 &&
      channel < MUSIC_CHANNELS
    );
  }

  private inWaveform(waveform: number, step: number): boolean {
    return waveform >= 0 && waveform < WAVEFORM_COUNT && step >= 0 && step < WAVEFORM_STEPS;
  }

  private inTile(x: number, y: number): boolean {
    return x >= 0 && x < TILE_SIZE && y >= 0 && y < TILE_SIZE;
  }

  private inMap(x: number, y: number): boolean {
    return x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT;
  }

  private inSfx(sample: number, tick: number): boolean {
    return sample >= 0 && sample < SFX_COUNT && tick >= 0 && tick < SFX_TICKS;
  }

  private inMusic(pattern: number, row: number): boolean {
    return pattern >= 0 && pattern < MUSIC_PATTERNS && row >= 0 && row < MUSIC_PATTERN_ROWS;
  }
}

/** Clamp a value into the 4-bit range shared by SFX volume and waveform. */
function clampNibble(value: number): number {
  return Math.max(0, Math.min(SFX_MAX_VALUE, value | 0));
}
