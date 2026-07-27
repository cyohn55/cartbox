/**
 * The single value every 2D generator produces: a grid of *class* indices plus
 * the legend naming them.
 *
 * Generators disagree about what they make — terrain has water and snow, a
 * dungeon has rooms and corridors — but they agree on the shape of the answer.
 * Keeping that shape in one type is what lets the editor treat them
 * interchangeably: one panel renders any generator's controls, and one mapping
 * step turns any generator's classes into tiles, pixels, or voxel columns. A
 * generator that is added later needs no new UI and no new apply path.
 *
 * Pure and DOM-free.
 */

import type { Rgb } from "../model/lighting";

/** One entry of a field's legend: what a class index means. */
export interface ClassInfo {
  /** Stable machine id, e.g. `"water"`. Used as a mapping key, never displayed. */
  readonly id: string;
  /** Human label shown beside the class in the editor. */
  readonly label: string;
  /** Representative colour, for the generator preview and voxel extrusion. */
  readonly color: Rgb;
}

/** A generated 2D grid of class indices into {@link ClassField.legend}. */
export interface ClassField {
  readonly width: number;
  readonly height: number;
  /** One class index per cell, row-major (`y * width + x`). */
  readonly classes: Uint8Array;
  readonly legend: readonly ClassInfo[];
}

/** Build a field, filled with class 0, after bounds-checking the dimensions. */
export function createClassField(
  width: number,
  height: number,
  legend: readonly ClassInfo[],
): ClassField {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Class field dimensions must be positive integers, received ${width}x${height}`);
  }
  if (legend.length === 0) throw new RangeError("A class field needs at least one legend entry");
  return { width, height, classes: new Uint8Array(width * height), legend };
}

/** The class index at a cell, or 0 for out-of-bounds reads. */
export function classAt(field: ClassField, x: number, y: number): number {
  if (x < 0 || x >= field.width || y < 0 || y >= field.height) return 0;
  return field.classes[y * field.width + x]!;
}

/** Set a cell's class. Out-of-bounds writes are ignored. */
export function setClassAt(field: ClassField, x: number, y: number, value: number): void {
  if (x < 0 || x >= field.width || y < 0 || y >= field.height) return;
  field.classes[y * field.width + x] = value;
}

/** How many cells carry each class, indexed like the legend. */
export function countByClass(field: ClassField): number[] {
  const counts = new Array<number>(field.legend.length).fill(0);
  for (let i = 0; i < field.classes.length; i += 1) {
    const value = field.classes[i]!;
    if (value < counts.length) counts[value] = counts[value]! + 1;
  }
  return counts;
}

/** The legend index of a class id, or -1 when the legend has no such class. */
export function classIndexOf(legend: readonly ClassInfo[], id: string): number {
  return legend.findIndex((entry) => entry.id === id);
}

/**
 * The field's colours as flat RGBA bytes, for drawing a preview thumbnail. The
 * caller supplies the surface; this stays DOM-free.
 */
export function classFieldToRgba(field: ClassField, out?: Uint8ClampedArray): Uint8ClampedArray {
  const pixels = out ?? new Uint8ClampedArray(field.width * field.height * 4);
  for (let i = 0; i < field.classes.length; i += 1) {
    const info = field.legend[field.classes[i]!] ?? field.legend[0]!;
    pixels[i * 4] = info.color[0];
    pixels[i * 4 + 1] = info.color[1];
    pixels[i * 4 + 2] = info.color[2];
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}
