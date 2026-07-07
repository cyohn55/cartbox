/**
 * CartEngine — the boundary between the custom Cartbox editor UI and the TIC-80
 * core. This interface is the contract the WASM shim will implement (backed by
 * the cartridge's live memory); `StubCartEngine` implements the same contract
 * in plain JS so the UI is fully functional before the WASM build exists.
 *
 * The numbers below mirror TIC-80's cart layout (see packages/engine/tic80/src/
 * tic.h): sprites are 8x8, a 4-bit palette index per pixel, 256 tiles per page,
 * two pages (background tiles / foreground sprites), and a 16-colour palette.
 * Keeping the same shape here means the WASM implementation is a thin memory
 * view, not a translation layer.
 */

/** Which of the two 256-tile pages a sprite lives on. */
export type SpritePage = 0 | 1;

/** A cart carries BANK_COUNT banks; the editor edits one ("current") at a time. */
export const BANK_COUNT = 8;
/**
 * Normal maps for the primary sprite bank are stored in the last bank's sprite
 * pages — a cart-compatible place to keep per-pixel surface direction without
 * changing the cart format. Costs the top bank; the rest stay game data.
 */
export const NORMAL_BANK = BANK_COUNT - 1;

/**
 * The per-pixel material channels the editor can author. Each is stored in its
 * own sprite bank (counting down from the top), the same cart-compatible scheme
 * as the normal bank — so authoring material costs banks, but the cart format is
 * unchanged. Unused channels leave their bank as ordinary game data.
 */
export type MaterialChannel = "normal" | "height" | "specular" | "roughness" | "emissive";

/** Sprite bank backing each material channel. */
export const MATERIAL_BANK: Record<MaterialChannel, number> = {
  normal: NORMAL_BANK, // BANK_COUNT - 1
  height: BANK_COUNT - 2,
  specular: BANK_COUNT - 3,
  roughness: BANK_COUNT - 4,
  emissive: BANK_COUNT - 5,
};

/**
 * Distinct authoring levels per channel, stored as a 4-bit pixel index (0..15):
 * normals use them as 16 directions; height/specular/roughness/emissive as 16
 * ramp steps (emissive: 0 = unlit, top = full self-illumination).
 */
export const MATERIAL_LEVELS = 16;

export const TILE_SIZE = 8;
export const TILES_PER_PAGE = 256;
export const SPRITE_PAGES = 2;
export const PALETTE_SIZE = 16;
export const PIXELS_PER_TILE = TILE_SIZE * TILE_SIZE;
/** RGB triplets, one per palette entry. */
export const PALETTE_BYTES = PALETTE_SIZE * 3;

/** Map dimensions in tile cells. A "screen" is MAP_SCREEN_WIDTH x _HEIGHT. */
export const MAP_WIDTH = 240;
export const MAP_HEIGHT = 136;
export const MAP_SCREEN_WIDTH = 30;
export const MAP_SCREEN_HEIGHT = 17;

/** Sound effects: SFX_COUNT samples, each a SFX_TICKS-step envelope. */
export const SFX_COUNT = 64;
export const SFX_TICKS = 30;
/** Volume and waveform are 4-bit fields (0..15). */
export const SFX_MAX_VALUE = 15;

/** The 16 shared custom waveforms, each a WAVEFORM_STEPS-step 4-bit curve. */
export const WAVEFORM_COUNT = 16;
export const WAVEFORM_STEPS = 32;
export const WAVEFORM_MAX = 15;

/** Each SFX sample has a loop per envelope channel (wave, volume, chord, pitch). */
export const SFX_LOOP_CHANNELS = 4;

/** Music: MUSIC_PATTERNS patterns, each MUSIC_PATTERN_ROWS rows. */
export const MUSIC_PATTERNS = 60;
export const MUSIC_PATTERN_ROWS = 64;
export const MUSIC_NOTES = 12;
export const MUSIC_OCTAVES = 8;
/** Song arrangement: MUSIC_TRACKS songs, each MUSIC_FRAMES frames x MUSIC_CHANNELS channels. */
export const MUSIC_TRACKS = 8;
export const MUSIC_FRAMES = 16;
export const MUSIC_CHANNELS = 4;
/**
 * Row note-field encoding (see the note enum in tic.h): 0 is an empty row,
 * MUSIC_NOTE_STOP is a note-off, and a pitch p (0..11) is stored as
 * p + MUSIC_NOTE_START.
 */
export const MUSIC_NOTE_STOP = 1;
export const MUSIC_NOTE_START = 4;
/** The 8 per-row effect commands (0 = none). */
export const MUSIC_COMMAND_COUNT = 8;

import type { ConsoleModelSpec } from "./consoleModel";

export interface CartEngine {
  /** The console model this engine implements — the editor reads its dimensions from here. */
  model(): ConsoleModelSpec;

  /** The bank all subsequent accessors read and write (0..BANK_COUNT-1). */
  getBank(): number;

  /** Switch the active bank. Out-of-range values are ignored. */
  setBank(bank: number): void;

  /** Read one tile's 64 palette indices (row-major). Reuses `out` when given. */
  readTile(page: SpritePage, tile: number, out?: Uint8Array): Uint8Array;

  /** Palette index (0..15) of a single pixel. */
  getPixel(page: SpritePage, tile: number, x: number, y: number): number;

  /** Paint one pixel with a palette index; out-of-range writes are ignored. */
  setPixel(page: SpritePage, tile: number, x: number, y: number, colorIndex: number): void;

  /** Read the whole palette as RGB triplets (length PALETTE_BYTES). */
  getPalette(out?: Uint8Array): Uint8Array;

  /** Replace one palette entry. Channel values are clamped to 0..255. */
  setPaletteColor(index: number, red: number, green: number, blue: number): void;

  /** Tile index (0..255) stamped at a map cell; 0 for out-of-range reads. */
  getMapCell(x: number, y: number): number;

  /** Stamp a tile index onto a map cell; out-of-range writes are ignored. */
  setMapCell(x: number, y: number, tile: number): void;

  /** The cart's source code. */
  getCode(): string;

  /** Replace the cart's source code. */
  setCode(text: string): void;

  /** The scripting language id (e.g. "lua", "js", "python"). */
  getLanguage(): string;

  /** Set the scripting language id. */
  setLanguage(language: string): void;

  /** Volume (0..15) of an SFX sample at one envelope tick. */
  getSfxVolume(sample: number, tick: number): number;

  /** Set the volume (0..15) of an SFX sample at one envelope tick. */
  setSfxVolume(sample: number, tick: number, value: number): void;

  /** Waveform index (0..15) an SFX sample plays at one envelope tick. */
  getSfxWave(sample: number, tick: number): number;

  /** Set the waveform index (0..15) at one envelope tick. */
  setSfxWave(sample: number, tick: number, value: number): void;

  /** Amplitude (0..15) of a custom waveform at one step. */
  getWaveformSample(waveform: number, step: number): number;

  /** Set the amplitude (0..15) of a custom waveform at one step. */
  setWaveformSample(waveform: number, step: number, value: number): void;

  /** Loop start (0..15) of an SFX envelope channel (0=wave,1=volume,2=chord,3=pitch). */
  getSfxLoopStart(sample: number, channel: number): number;

  /** Set the loop start (0..15) of an SFX envelope channel. */
  setSfxLoopStart(sample: number, channel: number, value: number): void;

  /** Loop size (0..15; 0 = no loop) of an SFX envelope channel. */
  getSfxLoopSize(sample: number, channel: number): number;

  /** Set the loop size (0..15) of an SFX envelope channel. */
  setSfxLoopSize(sample: number, channel: number, value: number): void;

  /** Raw note field of a music pattern row (0 empty, 1 stop, 4..15 pitch). */
  getMusicNoteField(pattern: number, row: number): number;

  /** Set the raw note field of a music pattern row. */
  setMusicNoteField(pattern: number, row: number, value: number): void;

  /** Octave (0..7) of a music pattern row. */
  getMusicOctave(pattern: number, row: number): number;

  /** Set the octave (0..7) of a music pattern row. */
  setMusicOctave(pattern: number, row: number, value: number): void;

  /** SFX id (0..63) a music pattern row triggers. */
  getMusicSfx(pattern: number, row: number): number;

  /** Set the SFX id (0..63) a music pattern row triggers. */
  setMusicSfx(pattern: number, row: number, value: number): void;

  /** Effect command (0..7) on a music pattern row. */
  getMusicCommand(pattern: number, row: number): number;

  /** Set the effect command (0..7) on a music pattern row. */
  setMusicCommand(pattern: number, row: number, value: number): void;

  /** Effect parameter (0..255, the XY nibbles) on a music pattern row. */
  getMusicParam(pattern: number, row: number): number;

  /** Set the effect parameter (0..255) on a music pattern row. */
  setMusicParam(pattern: number, row: number, value: number): void;

  /** Pattern id a track's channel plays on a frame (0..63). */
  getMusicFramePattern(track: number, frame: number, channel: number): number;

  /** Set the pattern id a track's channel plays on a frame. */
  setMusicFramePattern(track: number, frame: number, channel: number, id: number): void;

  /** Normal-direction index (0..15) for a pixel of a primary-bank sprite. */
  getNormal(page: SpritePage, tile: number, x: number, y: number): number;

  /** Set the normal-direction index (0..15) for a sprite pixel. */
  setNormal(page: SpritePage, tile: number, x: number, y: number, direction: number): void;

  /** Value (0..MATERIAL_LEVELS-1) of a material channel for a primary-bank sprite pixel. */
  getMaterial(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number): number;

  /** Set a material-channel value (0..MATERIAL_LEVELS-1) for a sprite pixel. */
  setMaterial(channel: MaterialChannel, page: SpritePage, tile: number, x: number, y: number, value: number): void;
}
