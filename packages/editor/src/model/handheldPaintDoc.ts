/**
 * Layered RGBA paint document — the model behind the in-app handheld pixel
 * editor. A handheld skin can be drawn freely (like Aseprite) rather than only
 * recoloured by region; that free-form art is a stack of straight-alpha RGBA
 * layers over the shared canvas, flattened to a single bitmap when saved.
 *
 * This module is pure (no DOM): it owns the document shape, source-over
 * compositing, a colour flood fill, per-rectangle snapshots for undo/redo, and
 * (de)serialisation for the localStorage working copy. The React editor draws on
 * top of it and the console renders the flattened result. Stroke geometry
 * (lines, shapes, brush stamps) lives with the sprite editor's tools and is
 * shared from there — this model only needs pixels and layers.
 */

/** A single straight-alpha RGBA layer covering the whole document. */
export interface PaintLayer {
  /** Stable id used as a React key and for layer lookups. */
  readonly id: string;
  /** Human label shown in the layers panel. */
  name: string;
  /** Whether the layer contributes to the composite. */
  visible: boolean;
  /** Layer opacity, 0..1, multiplied into the layer's own alpha. */
  opacity: number;
  /** Straight-alpha RGBA pixels, length `width * height * 4`. */
  pixels: Uint8ClampedArray;
}

/** An ordered stack of layers (index 0 is the bottom) over a fixed canvas. */
export interface PaintDoc {
  readonly width: number;
  readonly height: number;
  /** Bottom-to-top; the last layer paints over the others. */
  layers: PaintLayer[];
  /** The layer edits currently target. */
  activeId: string;
}

/** An RGBA colour, each channel 0..255. */
export type Rgba = readonly [number, number, number, number];

/** An axis-aligned pixel rectangle (used for undo snapshots and dirty regions). */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Upper bound on layers, to keep a multi-megabyte-per-layer document sane. */
export const MAX_PAINT_LAYERS = 8;

/** Largest Euclidean distance between two 8-bit RGBA colours. */
const MAX_RGBA_DISTANCE = Math.sqrt(4 * 255 * 255);

let layerCounter = 0;

/** A process-unique layer id (not persisted; ids are regenerated on load). */
function nextLayerId(): string {
  layerCounter += 1;
  return `layer-${layerCounter}`;
}

/** A blank, fully transparent layer for the given canvas. */
export function createLayer(width: number, height: number, name: string): PaintLayer {
  return { id: nextLayerId(), name, visible: true, opacity: 1, pixels: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Seed a one-layer document from a flattened RGBA bitmap (e.g. the current
 * region-recoloured skin render). The bitmap is copied, so later edits never
 * mutate the caller's buffer.
 */
export function docFromRgba(rgba: Uint8ClampedArray, width: number, height: number, name = "Base"): PaintDoc {
  const layer: PaintLayer = { id: nextLayerId(), name, visible: true, opacity: 1, pixels: rgba.slice() };
  return { width, height, layers: [layer], activeId: layer.id };
}

/** The layer edits currently target, or null if the active id is stale. */
export function activeLayer(doc: PaintDoc): PaintLayer | null {
  return doc.layers.find((layer) => layer.id === doc.activeId) ?? null;
}

/**
 * Flatten the visible layers bottom-to-top into one straight-alpha RGBA bitmap,
 * honouring each layer's opacity. This is the render the console shows and what
 * gets uploaded on save.
 */
export function compositeDoc(doc: PaintDoc): Uint8ClampedArray {
  const out = new Uint8ClampedArray(doc.width * doc.height * 4);
  const pixels = doc.width * doc.height;
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const src = layer.pixels;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const base = pixel * 4;
      const sourceAlpha = ((src[base + 3] ?? 0) / 255) * layer.opacity;
      if (sourceAlpha <= 0) continue;
      const destAlpha = (out[base + 3] ?? 0) / 255;
      const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
      if (outAlpha <= 0) continue;
      out[base] = ((src[base] ?? 0) * sourceAlpha + (out[base] ?? 0) * destAlpha * (1 - sourceAlpha)) / outAlpha;
      out[base + 1] = ((src[base + 1] ?? 0) * sourceAlpha + (out[base + 1] ?? 0) * destAlpha * (1 - sourceAlpha)) / outAlpha;
      out[base + 2] = ((src[base + 2] ?? 0) * sourceAlpha + (out[base + 2] ?? 0) * destAlpha * (1 - sourceAlpha)) / outAlpha;
      out[base + 3] = Math.round(outAlpha * 255);
    }
  }
  return out;
}

// --- Layer stack operations (structural; return a new doc, share pixel buffers) ---

/** Replace one layer's entry, keeping the rest of the stack. */
function withLayers(doc: PaintDoc, layers: PaintLayer[], activeId = doc.activeId): PaintDoc {
  return { width: doc.width, height: doc.height, layers, activeId };
}

/**
 * Add a new transparent layer directly above the active layer and select it.
 * At the layer cap the document is returned unchanged.
 */
export function addLayer(doc: PaintDoc, name?: string): PaintDoc {
  if (doc.layers.length >= MAX_PAINT_LAYERS) return doc;
  const layer = createLayer(doc.width, doc.height, name ?? `Layer ${doc.layers.length + 1}`);
  const activeIndex = doc.layers.findIndex((entry) => entry.id === doc.activeId);
  const insertAt = activeIndex < 0 ? doc.layers.length : activeIndex + 1;
  const layers = doc.layers.slice();
  layers.splice(insertAt, 0, layer);
  return withLayers(doc, layers, layer.id);
}

/**
 * Remove a layer. The last layer is never removed (a document always has one);
 * if the active layer goes, selection falls to the nearest remaining layer.
 */
export function removeLayer(doc: PaintDoc, id: string): PaintDoc {
  if (doc.layers.length <= 1) return doc;
  const index = doc.layers.findIndex((layer) => layer.id === id);
  if (index < 0) return doc;
  const layers = doc.layers.slice();
  layers.splice(index, 1);
  const activeId = doc.activeId === id ? (layers[Math.min(index, layers.length - 1)]?.id ?? layers[0]!.id) : doc.activeId;
  return withLayers(doc, layers, activeId);
}

/** Move a layer to a new stack index (clamped), preserving the active layer. */
export function reorderLayer(doc: PaintDoc, id: string, toIndex: number): PaintDoc {
  const from = doc.layers.findIndex((layer) => layer.id === id);
  if (from < 0) return doc;
  const target = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
  if (target === from) return doc;
  const layers = doc.layers.slice();
  const [moved] = layers.splice(from, 1);
  layers.splice(target, 0, moved!);
  return withLayers(doc, layers);
}

/** Patch a layer's visibility, opacity, or name; unknown ids are a no-op. */
export function setLayerProps(doc: PaintDoc, id: string, patch: Partial<Pick<PaintLayer, "visible" | "opacity" | "name">>): PaintDoc {
  const layers = doc.layers.map((layer) =>
    layer.id === id
      ? {
          ...layer,
          ...(patch.visible === undefined ? {} : { visible: patch.visible }),
          ...(patch.opacity === undefined ? {} : { opacity: Math.max(0, Math.min(1, patch.opacity)) }),
          ...(patch.name === undefined ? {} : { name: patch.name }),
        }
      : layer,
  );
  return withLayers(doc, layers);
}

/** Select which layer edits target; unknown ids are a no-op. */
export function setActiveLayer(doc: PaintDoc, id: string): PaintDoc {
  return doc.layers.some((layer) => layer.id === id) ? withLayers(doc, doc.layers, id) : doc;
}

// --- Pixel operations (mutate a layer's buffer in place, like the sprite editor) ---

/** Write one straight-alpha RGBA pixel into a layer buffer (bounds-checked). */
export function setLayerPixel(layer: PaintLayer, width: number, height: number, x: number, y: number, color: Rgba): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const base = (y * width + x) * 4;
  layer.pixels[base] = color[0];
  layer.pixels[base + 1] = color[1];
  layer.pixels[base + 2] = color[2];
  layer.pixels[base + 3] = color[3];
}

/** Read one straight-alpha RGBA pixel from a layer buffer, or transparent black. */
export function getLayerPixel(layer: PaintLayer, width: number, x: number, y: number): Rgba {
  const base = (y * width + x) * 4;
  return [layer.pixels[base] ?? 0, layer.pixels[base + 1] ?? 0, layer.pixels[base + 2] ?? 0, layer.pixels[base + 3] ?? 0];
}

/** Squared RGBA distance, avoiding a sqrt in the flood-fill inner loop. */
function colorDistanceSquared(a: Rgba, b: Rgba): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  const da = a[3] - b[3];
  return dr * dr + dg * dg + db * db + da * da;
}

/**
 * Flood fill the contiguous (4-connected) region of a layer that matches the
 * seed pixel's colour, painting it `color`. `tolerance` (0..1) widens the match
 * to nearby colours; an optional `inMask` predicate confines the fill (e.g. to a
 * region silhouette). Mutates the layer buffer in place; returns the pixel
 * count changed (0 when the seed is out of bounds/mask or already the target).
 */
export function floodFillRgba(
  layer: PaintLayer,
  width: number,
  height: number,
  startX: number,
  startY: number,
  color: Rgba,
  tolerance = 0,
  inMask?: (x: number, y: number) => boolean,
): number {
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return 0;
  if (inMask && !inMask(startX, startY)) return 0;
  const target = getLayerPixel(layer, width, startX, startY);
  if (target[0] === color[0] && target[1] === color[1] && target[2] === color[2] && target[3] === color[3]) return 0;
  const threshold = tolerance <= 0 ? 0 : (tolerance * MAX_RGBA_DISTANCE) ** 2;
  const matches = (x: number, y: number): boolean => {
    const pixel = getLayerPixel(layer, width, x, y);
    return threshold === 0
      ? pixel[0] === target[0] && pixel[1] === target[1] && pixel[2] === target[2] && pixel[3] === target[3]
      : colorDistanceSquared(pixel, target) <= threshold;
  };

  let changed = 0;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [startY * width + startX];
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (visited[index]) continue;
    const x = index % width;
    const y = (index - x) / width;
    if (inMask && !inMask(x, y)) continue;
    if (!matches(x, y)) continue;
    visited[index] = 1;
    setLayerPixel(layer, width, height, x, y, color);
    changed += 1;
    if (x + 1 < width) stack.push(index + 1);
    if (x - 1 >= 0) stack.push(index - 1);
    if (y + 1 < height) stack.push(index + width);
    if (y - 1 >= 0) stack.push(index - width);
  }
  return changed;
}

// --- Rectangular snapshots (the unit of undo/redo, so history stays small) ---

/** Clamp a rectangle to the canvas, returning null if it falls entirely outside. */
export function clampRect(rect: PixelRect, width: number, height: number): PixelRect | null {
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  const right = Math.max(0, Math.min(width, rect.x + rect.width));
  const bottom = Math.max(0, Math.min(height, rect.y + rect.height));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Copy a rectangle of a layer's pixels out (for an undo snapshot). */
export function snapshotRect(layer: PaintLayer, width: number, rect: PixelRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row += 1) {
    const srcStart = ((rect.y + row) * width + rect.x) * 4;
    out.set(layer.pixels.subarray(srcStart, srcStart + rect.width * 4), row * rect.width * 4);
  }
  return out;
}

/** Write a previously snapshotted rectangle back into a layer (undo/redo apply). */
export function blitRect(layer: PaintLayer, width: number, rect: PixelRect, pixels: Uint8ClampedArray): void {
  for (let row = 0; row < rect.height; row += 1) {
    const destStart = ((rect.y + row) * width + rect.x) * 4;
    layer.pixels.set(pixels.subarray(row * rect.width * 4, (row + 1) * rect.width * 4), destStart);
  }
}

// --- Serialisation for the localStorage working copy ---

interface SerializedLayer {
  name: string;
  visible: boolean;
  opacity: number;
  /** base64 of the straight-alpha RGBA bytes. */
  data: string;
}

interface SerializedDoc {
  width: number;
  height: number;
  activeIndex: number;
  layers: SerializedLayer[];
}

/** base64-encode raw bytes (btoa is available in browsers and modern Node). */
function bytesToBase64(bytes: Uint8ClampedArray): string {
  let binary = "";
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Decode base64 back to raw bytes. */
function base64ToBytes(base64: string): Uint8ClampedArray {
  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Serialise a document to a JSON-safe object (layer pixels as base64). */
export function serializeDoc(doc: PaintDoc): SerializedDoc {
  return {
    width: doc.width,
    height: doc.height,
    activeIndex: Math.max(0, doc.layers.findIndex((layer) => layer.id === doc.activeId)),
    layers: doc.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      data: bytesToBase64(layer.pixels),
    })),
  };
}

/**
 * Rebuild a document from a serialised object, validating shape and dimensions.
 * Returns null when the payload is malformed or its layers don't match the
 * expected canvas size, so a corrupt working copy can never crash the editor.
 */
export function deserializeDoc(input: unknown, width: number, height: number): PaintDoc | null {
  const source = input as Partial<SerializedDoc> | null;
  if (!source || source.width !== width || source.height !== height || !Array.isArray(source.layers) || source.layers.length === 0) {
    return null;
  }
  const expectedLength = width * height * 4;
  const layers: PaintLayer[] = [];
  for (const entry of source.layers.slice(0, MAX_PAINT_LAYERS)) {
    if (!entry || typeof entry.data !== "string") return null;
    let pixels: Uint8ClampedArray;
    try {
      pixels = base64ToBytes(entry.data);
    } catch {
      return null;
    }
    if (pixels.length !== expectedLength) return null;
    layers.push({
      id: nextLayerId(),
      name: typeof entry.name === "string" ? entry.name : "Layer",
      visible: entry.visible !== false,
      opacity: typeof entry.opacity === "number" ? Math.max(0, Math.min(1, entry.opacity)) : 1,
      pixels,
    });
  }
  const activeIndex = typeof source.activeIndex === "number" ? Math.max(0, Math.min(layers.length - 1, source.activeIndex)) : layers.length - 1;
  return { width, height, layers, activeId: layers[activeIndex]!.id };
}
