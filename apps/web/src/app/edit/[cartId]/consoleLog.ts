/**
 * The playtest console's log (ENGINE_ROADMAP.md, Phase 5): the cart's `trace()`
 * output and its runtime errors, newest last. Pure.
 *
 * A cart that errors in `TIC` errors again every frame, so a message that
 * repeats the one before it bumps that entry's count instead of adding a line.
 */

import { errorStack, type ErrorFrame } from "@cartbox/player";

import { errorLineFrom } from "./codeTools";

export interface ConsoleEntry {
  readonly id: number;
  readonly kind: "trace" | "error";
  /** As printed (an error's first line is its message, then its call stack). */
  readonly text: string;
  /** The frame it first came in. */
  readonly frame: number;
  /** TIC-80 palette index the cart traced in (traces only). */
  readonly color: number;
  /** How many times in a row it came. */
  readonly count: number;
  /** The cart line an error names, and its call stack (errors only). */
  readonly line: number | null;
  readonly stack: readonly ErrorFrame[];
}

/** Entries kept; older ones fall off the top. */
export const CONSOLE_LIMIT = 500;

let nextId = 1;

/** Add a trace or error to the log. */
export function appendConsole(log: readonly ConsoleEntry[], kind: ConsoleEntry["kind"], text: string, frame: number, color = 15): ConsoleEntry[] {
  const last = log.at(-1);
  if (last && last.kind === kind && last.text === text && last.color === color) {
    return [...log.slice(0, -1), { ...last, count: last.count + 1 }];
  }
  const firstLine = text.split("\n", 1)[0] ?? text;
  const entry: ConsoleEntry = {
    id: nextId++,
    kind,
    text,
    frame,
    color,
    count: 1,
    line: kind === "error" ? errorLineFrom(firstLine) : null,
    stack: kind === "error" ? errorStack(text) : [],
  };
  const next = [...log, entry];
  return next.length > CONSOLE_LIMIT ? next.slice(next.length - CONSOLE_LIMIT) : next;
}

/** The Sweetie 16 palette (TIC-80's default), for trace colours. */
const SWEETIE_16 = ["#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179", "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57"];

/** A readable CSS colour for a trace colour: the palette's, except the dark ones (default text). */
export function traceColor(color: number): string | undefined {
  if ([0, 1, 7, 8, 15].includes(color)) return undefined;
  return SWEETIE_16[color];
}
