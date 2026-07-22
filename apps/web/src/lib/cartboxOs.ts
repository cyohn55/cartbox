/**
 * The Cartbox handheld OS — a small interactive console rendered onto the centre
 * handheld's screen in the world, driven by the d-pad and A/B/Start.
 *
 * The screen is a grid of self-emissive voxels on the hero handheld (see
 * worldScene.ts), each voxel one pixel. This module owns (1) the pure app state
 * machine — boot → Make·Play·Share menu → the in-OS handheld customizer → done —
 * advanced by {@link osReduce} from button presses, and (2) the renderer that
 * draws the current state into an RGBA framebuffer the component blits onto those
 * voxels. A minimal 3×5 font keeps labels legible at this resolution.
 *
 * The customizer edits the *real* handheld design: the ten recolour regions of
 * {@link HANDHELD_REGIONS} over the 64-colour Pro palette, plus the screen style,
 * phosphor, scanlines and marquee — the same {@link HandheldScheme} + console
 * settings the onboarding page saves. It stays framework-free (no DOM), so the
 * whole flow is unit-testable; the component paints its output, mirrors the
 * choices onto the voxel handheld, and persists them on "PICK".
 */

import {
  HANDHELD_REGIONS,
  proPaletteHex,
  handheldPreset,
  DEFAULT_HANDHELD_PRESET_ID,
  type HandheldScheme,
  type HandheldRegionId,
} from "@cartbox/editor";
import { OS_STYLES, OS_PHOSPHORS, type OsStyleId, type OsPhosphorId } from "../app/console/consoleSettings";

/** Display size in pixels (voxels). Matches the hero handheld's screen grid. */
export const SCREEN_W = 20;
export const SCREEN_H = 26;

/** Seconds of boot animation before the menu appears. */
export const BOOT_TIME = 1.3;

/** A full 3×5 uppercase font ('#' on, ' ' off), so any region label renders. */
const FONT: Record<string, readonly string[]> = {
  A: ["###", "# #", "###", "# #", "# #"], B: ["## ", "# #", "## ", "# #", "## "],
  C: ["###", "#  ", "#  ", "#  ", "###"], D: ["## ", "# #", "# #", "# #", "## "],
  E: ["###", "#  ", "###", "#  ", "###"], F: ["###", "#  ", "###", "#  ", "#  "],
  G: ["###", "#  ", "# #", "# #", "###"], H: ["# #", "# #", "###", "# #", "# #"],
  I: ["###", " # ", " # ", " # ", "###"], J: ["  #", "  #", "  #", "# #", "###"],
  K: ["# #", "## ", "#  ", "## ", "# #"], L: ["#  ", "#  ", "#  ", "#  ", "###"],
  M: ["# #", "###", "###", "# #", "# #"], N: ["# #", "###", "###", "###", "# #"],
  O: ["###", "# #", "# #", "# #", "###"], P: ["###", "# #", "###", "#  ", "#  "],
  Q: ["###", "# #", "# #", "###", "  #"], R: ["###", "# #", "###", "## ", "# #"],
  S: ["###", "#  ", "###", "  #", "###"], T: ["###", " # ", " # ", " # ", " # "],
  U: ["# #", "# #", "# #", "# #", "###"], V: ["# #", "# #", "# #", "# #", " # "],
  W: ["# #", "# #", "###", "###", "# #"], X: ["# #", "# #", " # ", "# #", "# #"],
  Y: ["# #", "# #", "###", " # ", " # "], Z: ["###", "  #", " # ", "#  ", "###"],
};

const BG: readonly [number, number, number] = [10, 14, 26];
const TITLE: readonly [number, number, number] = [120, 70, 180];
const INK: readonly [number, number, number] = [236, 240, 255];

/** The three top-level actions, with the accent colour each is themed in. */
const MENU = [
  { label: "MAKE", accent: [90, 200, 230] as const },
  { label: "PLAY", accent: [120, 220, 140] as const },
  { label: "SHARE", accent: [235, 150, 210] as const },
];

/** How a customizer parameter is edited. */
type ParamKind = "color" | "screen" | "phosphor" | "scanlines" | "marquee";

interface ParamDef {
  readonly kind: ParamKind;
  /** Short label that fits the tiny screen. */
  readonly short: string;
  /** For colour params, the scheme region recoloured. */
  readonly regionId?: HandheldRegionId;
}

/** Abbreviated labels for the ten recolour regions, in {@link HANDHELD_REGIONS} order. */
const REGION_SHORT: Record<HandheldRegionId, string> = {
  face: "BODY",
  dpadPanel: "DPNL",
  buttonPanel: "BPNL",
  decal: "DECAL",
  text: "TEXT",
  dpad: "DPAD",
  buttonColor: "BTNS",
  dpadArrow: "ARROW",
  buttonLetter: "LTRS",
  shoulderText: "SHLDR",
};

/**
 * The customizer parameters in ‹ › order: the recolour regions first, then the
 * screen style, phosphor, scanlines and marquee — the full onboarding set.
 */
export const PARAMS: readonly ParamDef[] = [
  ...HANDHELD_REGIONS.map((region) => ({ kind: "color" as const, short: REGION_SHORT[region.id], regionId: region.id })),
  { kind: "screen", short: "SCRN" },
  { kind: "phosphor", short: "PHOS" },
  { kind: "scanlines", short: "SCAN" },
  { kind: "marquee", short: "MARQ" },
];

/** The 64-colour Pro palette shown in the swatch grid (5 cols × pages). */
export const PALETTE: readonly string[] = proPaletteHex();
const SWATCH_COLS = 5;
const SWATCH_PER_PAGE = 20;

/** Hex glow of each phosphor preset (mirrors the console tints). */
const PHOSPHOR_HEX: Record<OsPhosphorId, string> = { green: "#6bffb0", amber: "#ffc65e", cyan: "#6bf0ff", red: "#ff6f6f" };
/** Short screen-style labels. */
const STYLE_SHORT: Record<OsStyleId, string> = { pipboy: "PIP", modern: "MOD" };
/** A curated marquee set (id + short label); the client resolves the game on save. */
export const MARQUEE_OPTIONS: readonly { id: string | null; label: string }[] = [
  { id: null, label: "NONE" },
  { id: "anim-pac-man", label: "PAC" },
  { id: "anim-space-invaders", label: "INV" },
  { id: "anim-asteroids", label: "AST" },
  { id: "anim-gamertag", label: "TAG" },
];

/** The player's chosen handheld design (the real scheme + console settings). */
export interface HandheldConfig {
  scheme: HandheldScheme;
  osStyle: OsStyleId;
  osPhosphor: OsPhosphorId;
  osPhosphorColor: string | null;
  osScanlines: boolean;
  marquee: string | null;
}

export const DEFAULT_CONFIG: HandheldConfig = {
  scheme: { ...handheldPreset(DEFAULT_HANDHELD_PRESET_ID).scheme },
  osStyle: "pipboy",
  osPhosphor: "green",
  osPhosphorColor: null,
  osScanlines: true,
  marquee: null,
};

export type OsMode = "menu" | "customize" | "done";
export type CustomizeFocus = "selector" | "panel" | "confirm";
export type OsButton = "up" | "down" | "left" | "right" | "a" | "b" | "start";

export interface OsState {
  readonly mode: OsMode;
  readonly menuIndex: number;
  readonly paramIndex: number;
  readonly focus: CustomizeFocus;
  /** Cursor within the active panel: a global palette index, or a list index. */
  readonly cursor: number;
  readonly config: HandheldConfig;
}

export function initialOsState(): OsState {
  return { mode: "menu", menuIndex: 0, paramIndex: 0, focus: "selector", cursor: 0, config: cloneConfig(DEFAULT_CONFIG) };
}

function cloneConfig(config: HandheldConfig): HandheldConfig {
  return { ...config, scheme: { ...config.scheme } };
}

/** Parse a `#rrggbb` string to an [r, g, b] triple. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The phosphor glow hex the config resolves to (custom colour wins). */
export function phosphorHex(config: HandheldConfig): string {
  return config.osPhosphorColor ?? PHOSPHOR_HEX[config.osPhosphor];
}

const wrapValue = (value: number, count: number): number => ((value % count) + count) % count;

/** The non-colour options for a list-style parameter: label, apply, and current test. */
interface ListOption {
  readonly label: string;
  readonly apply: (config: HandheldConfig) => HandheldConfig;
  readonly current: (config: HandheldConfig) => boolean;
}

function listOptions(param: ParamDef): ListOption[] {
  switch (param.kind) {
    case "screen":
      return OS_STYLES.map((style) => ({
        label: STYLE_SHORT[style.id],
        apply: (config) => ({ ...config, osStyle: style.id }),
        current: (config) => config.osStyle === style.id,
      }));
    case "phosphor":
      return OS_PHOSPHORS.map((phosphor) => ({
        label: phosphor.label.toUpperCase(),
        apply: (config) => ({ ...config, osPhosphor: phosphor.id, osPhosphorColor: null }),
        current: (config) => config.osPhosphor === phosphor.id && !config.osPhosphorColor,
      }));
    case "scanlines":
      return [
        { label: "ON", apply: (config) => ({ ...config, osScanlines: true }), current: (config) => config.osScanlines },
        { label: "OFF", apply: (config) => ({ ...config, osScanlines: false }), current: (config) => !config.osScanlines },
      ];
    case "marquee":
      return MARQUEE_OPTIONS.map((option) => ({
        label: option.label,
        apply: (config) => ({ ...config, marquee: option.id }),
        current: (config) => config.marquee === option.id,
      }));
    default:
      return [];
  }
}

/** Columns and item count of the active panel (colour grid vs. option list). */
function panelShape(param: ParamDef): { cols: number; count: number } {
  return param.kind === "color"
    ? { cols: SWATCH_COLS, count: PALETTE.length }
    : { cols: 1, count: listOptions(param).length };
}

/** Apply the cursor's current choice to the config. */
function applyCursor(state: OsState): HandheldConfig {
  const param = PARAMS[state.paramIndex]!;
  if (param.kind === "color") {
    return { ...state.config, scheme: { ...state.config.scheme, [param.regionId!]: PALETTE[state.cursor]! } };
  }
  return listOptions(param)[state.cursor]!.apply(state.config);
}

/**
 * Advance the OS by one button press. Pure: returns the next state, never mutates
 * the input. The menu steps its highlight and A/Start opens the customizer; the
 * customizer's selector cycles the parameter, its panel moves a cursor over the
 * swatch grid (or option list) and applies with A, and B backs out; the confirm
 * button finishes with A.
 */
export function osReduce(state: OsState, button: OsButton): OsState {
  if (state.mode === "menu") {
    switch (button) {
      case "up":
        return { ...state, menuIndex: wrapValue(state.menuIndex - 1, MENU.length) };
      case "down":
        return { ...state, menuIndex: wrapValue(state.menuIndex + 1, MENU.length) };
      case "a":
      case "start":
        return { ...state, mode: "customize", focus: "selector", cursor: 0 };
      default:
        return state;
    }
  }

  if (state.mode !== "customize") return state;

  if (state.focus === "selector") {
    switch (button) {
      case "left":
        return { ...state, paramIndex: wrapValue(state.paramIndex - 1, PARAMS.length), cursor: 0 };
      case "right":
        return { ...state, paramIndex: wrapValue(state.paramIndex + 1, PARAMS.length), cursor: 0 };
      case "down":
      case "a":
        return { ...state, focus: "panel" };
      case "b":
        return { ...state, mode: "menu" };
      default:
        return state;
    }
  }

  if (state.focus === "panel") {
    const { cols, count } = panelShape(PARAMS[state.paramIndex]!);
    switch (button) {
      case "left":
        return cols > 1 ? { ...state, cursor: Math.max(0, state.cursor - 1) } : state;
      case "right":
        return cols > 1 ? { ...state, cursor: Math.min(count - 1, state.cursor + 1) } : state;
      case "up": {
        const next = state.cursor - cols;
        return next < 0 ? { ...state, focus: "selector" } : { ...state, cursor: next };
      }
      case "down": {
        const next = state.cursor + cols;
        return next >= count ? { ...state, focus: "confirm" } : { ...state, cursor: next };
      }
      case "a":
        return { ...state, config: applyCursor(state) };
      case "b":
        return { ...state, focus: "selector" };
      default:
        return state;
    }
  }

  // focus === "confirm"
  switch (button) {
    case "a":
    case "start":
      return { ...state, mode: "done" };
    case "up":
      return { ...state, focus: "panel" };
    case "b":
      return { ...state, focus: "selector" };
    default:
      return state;
  }
}

// --- Rendering -------------------------------------------------------------

function put(data: Uint8ClampedArray, x: number, y: number, rgb: readonly [number, number, number]): void {
  if (x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H) return;
  const i = (y * SCREEN_W + x) * 4;
  data[i] = rgb[0];
  data[i + 1] = rgb[1];
  data[i + 2] = rgb[2];
  data[i + 3] = 255;
}

function rect(data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, rgb: readonly [number, number, number]): void {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) put(data, x, y, rgb);
}

function outline(data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, rgb: readonly [number, number, number]): void {
  for (let x = x0; x < x1; x += 1) {
    put(data, x, y0, rgb);
    put(data, x, y1 - 1, rgb);
  }
  for (let y = y0; y < y1; y += 1) {
    put(data, x0, y, rgb);
    put(data, x1 - 1, y, rgb);
  }
}

function textWidth(word: string): number {
  return word.length * 4 - 1;
}

function text(data: Uint8ClampedArray, x: number, y: number, word: string, rgb: readonly [number, number, number]): void {
  let cursor = x;
  for (const char of word) {
    const glyph = FONT[char];
    if (glyph) {
      for (let gy = 0; gy < 5; gy += 1) {
        const glyphRow = glyph[gy]!;
        for (let gx = 0; gx < 3; gx += 1) if (glyphRow[gx] === "#") put(data, cursor + gx, y + gy, rgb);
      }
    }
    cursor += 4;
  }
}

function textCentred(data: Uint8ClampedArray, y: number, word: string, rgb: readonly [number, number, number]): void {
  text(data, Math.max(0, Math.floor((SCREEN_W - textWidth(word)) / 2)), y, word, rgb);
}

function dim(rgb: readonly [number, number, number], factor: number): [number, number, number] {
  return [Math.round(rgb[0] * factor), Math.round(rgb[1] * factor), Math.round(rgb[2] * factor)];
}

function cartridge(data: Uint8ClampedArray, cx: number, cy: number, rgb: readonly [number, number, number]): void {
  rect(data, cx, cy, cx + 7, cy + 6, rgb);
  rect(data, cx + 2, cy, cx + 5, cy + 1, dim(rgb, 0.6));
  rect(data, cx + 1, cy + 2, cx + 6, cy + 4, BG);
}

function renderBoot(data: Uint8ClampedArray, seconds: number): void {
  const progress = seconds / BOOT_TIME;
  cartridge(data, SCREEN_W / 2 - 3, SCREEN_H / 2 - 3, dim([120, 220, 240], 0.4 + progress * 0.6));
  const sweepY = Math.floor(progress * SCREEN_H);
  rect(data, 0, sweepY, SCREEN_W, sweepY + 1, [120, 220, 240]);
}

function renderMenu(data: Uint8ClampedArray, state: OsState, blinkOn: boolean): void {
  rect(data, 0, 0, SCREEN_W, 6, TITLE);
  cartridge(data, 1, 0, [150, 230, 250]);
  rect(data, 9, 2, SCREEN_W - 1, 4, dim(INK, 0.85));
  MENU.forEach((item, index) => {
    const rowTop = 8 + index * 6;
    if (index === state.menuIndex) {
      rect(data, 1, rowTop - 1, SCREEN_W - 1, rowTop + 6, dim(item.accent, 0.3));
      if (blinkOn) rect(data, SCREEN_W - 3, rowTop + 1, SCREEN_W - 1, rowTop + 4, item.accent);
    }
    textCentred(data, rowTop, item.label, index === state.menuIndex ? INK : dim(item.accent, 0.75));
  });
}

/** The swatch grid for a colour parameter, with the cursor and page dots. */
function renderSwatchGrid(data: Uint8ClampedArray, state: OsState, active: boolean): void {
  const page = Math.floor(state.cursor / SWATCH_PER_PAGE);
  const pages = Math.ceil(PALETTE.length / SWATCH_PER_PAGE);
  const cursorInPage = state.cursor - page * SWATCH_PER_PAGE;
  const gridX = 0;
  const gridY = 7;
  const cell = 3;
  const gap = 1;
  for (let i = 0; i < SWATCH_PER_PAGE; i += 1) {
    const global = page * SWATCH_PER_PAGE + i;
    if (global >= PALETTE.length) break;
    const c = i % SWATCH_COLS;
    const r = Math.floor(i / SWATCH_COLS);
    const x = gridX + c * (cell + gap);
    const y = gridY + r * (cell + gap);
    rect(data, x, y, x + cell, y + cell, hexToRgb(PALETTE[global]!));
    if (i === cursorInPage) outline(data, x - 1, y - 1, x + cell + 1, y + cell + 1, active ? INK : dim(INK, 0.5));
  }
  // Page dots so the player knows more colours exist.
  for (let p = 0; p < pages; p += 1) put(data, SCREEN_W - pages + p, SCREEN_H - 6, p === page ? INK : dim(INK, 0.4));
}

/** A windowed list of options (up to three) for a non-colour parameter. */
function renderOptionList(data: Uint8ClampedArray, state: OsState, param: ParamDef, active: boolean): void {
  const options = listOptions(param);
  const accent = hexToRgb(phosphorHex(state.config));
  const windowSize = Math.min(3, options.length);
  const startIndex = Math.max(0, Math.min(state.cursor - 1, options.length - windowSize));
  for (let row = 0; row < windowSize; row += 1) {
    const index = startIndex + row;
    const option = options[index]!;
    const y = 8 + row * 6;
    if (index === state.cursor) rect(data, 0, y - 1, SCREEN_W, y + 6, dim(active ? INK : accent, 0.28));
    if (option.current(state.config)) rect(data, 1, y + 1, 3, y + 4, accent); // current-choice marker
    text(data, 5, y, option.label, index === state.cursor ? INK : dim(INK, 0.7));
  }
}

function renderCustomize(data: Uint8ClampedArray, state: OsState): void {
  const param = PARAMS[state.paramIndex]!;
  const accent = hexToRgb(phosphorHex(state.config));

  // Parameter selector: arrow bars flanking the short label.
  rect(data, 0, 0, SCREEN_W, 6, dim(TITLE, 0.8));
  const selectorLit = state.focus === "selector";
  rect(data, 0, 2, 2, 5, selectorLit ? accent : dim(INK, 0.4));
  rect(data, SCREEN_W - 2, 2, SCREEN_W, 5, selectorLit ? accent : dim(INK, 0.4));
  textCentred(data, 1, param.short, INK);
  if (selectorLit) outline(data, 0, 0, SCREEN_W, 6, accent);

  if (param.kind === "color") renderSwatchGrid(data, state, state.focus === "panel");
  else renderOptionList(data, state, param, state.focus === "panel");

  // Confirm button.
  const buttonTop = SCREEN_H - 5;
  const chosen = state.focus === "confirm";
  rect(data, 1, buttonTop, SCREEN_W - 1, SCREEN_H - 1, chosen ? accent : dim(accent, 0.35));
  textCentred(data, buttonTop, "PICK", chosen ? BG : INK);
}

function renderDone(data: Uint8ClampedArray, state: OsState): void {
  rect(data, 0, 0, SCREEN_W, SCREEN_H, dim(hexToRgb(phosphorHex(state.config)), 0.3));
  textCentred(data, 6, "GO", INK);
  cartridge(data, SCREEN_W / 2 - 3, 12, hexToRgb(state.config.scheme.face));
}

/**
 * Render the OS display for the given state and clock into `data`
 * (`SCREEN_W*SCREEN_H*4`). Before {@link BOOT_TIME} the boot sweep plays; after
 * that the current mode is drawn. The buffer is fully overwritten each call.
 */
export function renderOsApp(data: Uint8ClampedArray, state: OsState, seconds: number): void {
  rect(data, 0, 0, SCREEN_W, SCREEN_H, BG);
  if (seconds < BOOT_TIME && state.mode === "menu") {
    renderBoot(data, seconds);
    return;
  }
  if (state.mode === "menu") renderMenu(data, state, seconds % 0.7 < 0.45);
  else if (state.mode === "customize") renderCustomize(data, state);
  else renderDone(data, state);
}
