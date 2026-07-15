/**
 * Parse Aseprite sprites (`.aseprite` / `.ase`) into palette + flattened RGBA
 * frames the editor can import. The Aseprite format is a little-endian binary
 * container: a 128-byte header, then one block per animation frame, each holding
 * typed chunks (layers, cels, palette). Cel pixels are usually zlib-compressed.
 *
 * The parser is pure — it takes the file bytes and returns plain data — so the
 * UI reads the file and the unit tests drive it the same way. The only platform
 * dependency is `DecompressionStream` (a Web Streams API present in modern
 * browsers and Node >= 18) used to inflate compressed cels.
 *
 * Spec reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
 */

import type { Rgb } from "./paletteImport";

/** Magic numbers that mark a valid Aseprite file and frame. */
const FILE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;

/** Colour depths, in bits per pixel, the format encodes. */
const enum ColorDepth {
  Indexed = 8,
  Grayscale = 16,
  Rgba = 32,
}

/** Chunk type identifiers we read (others are skipped by their declared size). */
const enum ChunkType {
  OldPalette4 = 0x0004,
  OldPalette11 = 0x0011,
  Layer = 0x2004,
  Cel = 0x2005,
  Palette = 0x2019,
}

/** Cel storage variants; we render image cels and skip tilemap cels. */
const enum CelType {
  Raw = 0,
  Linked = 1,
  CompressedImage = 2,
  CompressedTilemap = 3,
}

/** Layer visibility bit and the "reference layer" bit (onion-skin helper). */
const LAYER_FLAG_VISIBLE = 0x01;
const LAYER_FLAG_REFERENCE = 0x40;

/** A single animation frame, flattened to a straight-alpha RGBA bitmap. */
export interface AsepriteFrame {
  /** RGBA bytes, row-major, length `width * height * 4`. */
  readonly pixels: Uint8ClampedArray;
  /** On-screen duration for this frame in milliseconds. */
  readonly durationMs: number;
}

/** The decoded document: canvas size, palette, and every composited frame. */
export interface AsepriteDocument {
  readonly width: number;
  readonly height: number;
  /** Bits per pixel of the source (8 indexed, 16 grayscale, 32 RGBA). */
  readonly colorDepth: number;
  /** Palette as RGB triplets (present for indexed sprites; may be empty). */
  readonly palette: Rgb[];
  /** Number of image/group layers declared in the file. */
  readonly layerCount: number;
  /** Frames in playback order, each pre-composited to RGBA. */
  readonly frames: AsepriteFrame[];
}

/** One layer of a frame, rendered to a full-canvas RGBA bitmap (or null for
 *  group layers, which hold no pixels). Preserves the layer's name and nesting
 *  so callers can pick or recolour individual layers and groups by name. */
export interface AsepriteLayer {
  readonly name: string;
  /** 0 = image, 1 = group, 2 = tilemap. */
  readonly type: number;
  /** Nesting depth; a group's children have a higher child level than it. */
  readonly childLevel: number;
  readonly visible: boolean;
  /** Layer opacity 0..255. */
  readonly opacity: number;
  /** Straight-alpha RGBA for the whole canvas, or null for group layers. */
  readonly pixels: Uint8ClampedArray | null;
}

/** A frame decomposed into its layers (unflattened), in bottom-to-top order. */
export interface AsepriteLayers {
  readonly width: number;
  readonly height: number;
  readonly layers: AsepriteLayer[];
}

/** Sequential little-endian reader over the file bytes with bounds tracking. */
class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  seek(position: number): void {
    this.offset = position;
  }

  skip(count: number): void {
    this.offset += count;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** A slice of `length` raw bytes, advancing past them (no copy). */
  slice(length: number): Uint8Array {
    const start = this.bytes.byteOffset + this.offset;
    const view = new Uint8Array(this.bytes.buffer, start, length);
    this.offset += length;
    return view;
  }
}

/**
 * Inflate zlib-compressed bytes (Aseprite cels) using the Web Streams API so the
 * parser stays free of any Node-specific `zlib` import and runs unchanged in the
 * browser and in tests.
 */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  // Copy into a standalone buffer so the stream owns contiguous, transferable bytes.
  void writer.write(bytes.slice());
  void writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Read an Aseprite STRING: a u16 length prefix followed by UTF-8 bytes. */
function readString(reader: ByteReader): string {
  const length = reader.u16();
  const bytes = reader.slice(length);
  return new TextDecoder().decode(bytes);
}

/** Scale a 6-bit channel (old 0x0011 palette, 0..63) up to 0..255. */
function scale6BitTo8Bit(value: number): number {
  return Math.round((value * 255) / 63);
}

/** Layer kinds Aseprite declares. */
export const enum AsepriteLayerType {
  Image = 0,
  Group = 1,
  Tilemap = 2,
}

/** Metadata for one layer, used to honour visibility and per-layer opacity, and
 *  to expose the layer tree (name/type/child level) to group-aware callers. */
interface LayerInfo {
  name: string;
  type: AsepriteLayerType;
  /** Nesting depth: children of a group have a higher child level than it. */
  childLevel: number;
  visible: boolean;
  opacity: number;
}

/** A cel's pixel payload placed at an (x, y) offset with its own opacity. */
interface Cel {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  /** Decoded source pixels (RGBA, grayscale pairs, or indices — depth-dependent). */
  pixels: Uint8Array;
  /** When set, this cel reuses the same layer's cel from another frame. */
  linkedFrame?: number;
}

/**
 * Resolve one source pixel to straight-alpha RGBA using the document's colour
 * depth and palette. Transparent-index pixels in indexed mode yield alpha 0.
 */
function pixelToRgba(
  depth: ColorDepth,
  source: Uint8Array,
  sourceIndex: number,
  paletteRgba: Uint8Array,
  transparentIndex: number,
): [number, number, number, number] {
  if (depth === ColorDepth.Rgba) {
    const base = sourceIndex * 4;
    return [source[base] ?? 0, source[base + 1] ?? 0, source[base + 2] ?? 0, source[base + 3] ?? 0];
  }
  if (depth === ColorDepth.Grayscale) {
    const base = sourceIndex * 2;
    const value = source[base] ?? 0;
    return [value, value, value, source[base + 1] ?? 0];
  }
  // Indexed: one byte per pixel, resolved through the RGBA palette.
  const index = source[sourceIndex] ?? 0;
  if (index === transparentIndex) return [0, 0, 0, 0];
  const base = index * 4;
  return [paletteRgba[base] ?? 0, paletteRgba[base + 1] ?? 0, paletteRgba[base + 2] ?? 0, paletteRgba[base + 3] ?? 255];
}

/** Composite a source pixel over a destination pixel (straight-alpha source-over). */
function blendOver(destination: Uint8ClampedArray, destBase: number, srcR: number, srcG: number, srcB: number, srcA: number): void {
  if (srcA <= 0) return;
  const dstA = (destination[destBase + 3] ?? 0) / 255;
  const sa = srcA / 255;
  if (dstA <= 0) {
    destination[destBase] = srcR;
    destination[destBase + 1] = srcG;
    destination[destBase + 2] = srcB;
    destination[destBase + 3] = srcA;
    return;
  }
  const outA = sa + dstA * (1 - sa);
  const mix = (src: number, dst: number) => (src * sa + dst * dstA * (1 - sa)) / outA;
  destination[destBase] = mix(srcR, destination[destBase] ?? 0);
  destination[destBase + 1] = mix(srcG, destination[destBase + 1] ?? 0);
  destination[destBase + 2] = mix(srcB, destination[destBase + 2] ?? 0);
  destination[destBase + 3] = Math.round(outA * 255);
}

/** Read the fixed 128-byte header and validate the magic number. */
function readHeader(reader: ByteReader): {
  frameCount: number;
  width: number;
  height: number;
  colorDepth: ColorDepth;
  transparentIndex: number;
} {
  reader.u32(); // file size (recomputed on write; unused here)
  const magic = reader.u16();
  if (magic !== FILE_MAGIC) {
    throw new Error("Not an Aseprite file (bad header magic).");
  }
  const frameCount = reader.u16();
  const width = reader.u16();
  const height = reader.u16();
  const colorDepth = reader.u16() as ColorDepth;
  reader.u32(); // flags
  reader.u16(); // deprecated speed
  reader.u32(); // reserved 0
  reader.u32(); // reserved 0
  const transparentIndex = reader.u8();
  reader.skip(3); // ignored
  reader.u16(); // number of colours (palette chunk is authoritative)
  reader.skip(2); // pixel width / height ratio
  reader.i16(); // grid x
  reader.i16(); // grid y
  reader.u16(); // grid width
  reader.u16(); // grid height
  reader.skip(84); // reserved
  return { frameCount, width, height, colorDepth, transparentIndex };
}

/** Parse a 0x2004 layer chunk into the running layer list. */
function readLayerChunk(reader: ByteReader): LayerInfo {
  const flags = reader.u16();
  const type = reader.u16() as AsepriteLayerType; // 0 image, 1 group, 2 tilemap
  const childLevel = reader.u16();
  reader.u16(); // default width (ignored)
  reader.u16(); // default height (ignored)
  reader.u16(); // blend mode (only Normal is composited faithfully)
  const opacity = reader.u8();
  reader.skip(3); // reserved
  const name = readString(reader);
  const referenceOnly = (flags & LAYER_FLAG_REFERENCE) !== 0;
  return {
    name,
    type,
    childLevel,
    visible: (flags & LAYER_FLAG_VISIBLE) !== 0 && !referenceOnly,
    opacity,
  };
}

/** Parse a 0x2005 cel chunk (raw or compressed image, or a link to another frame). */
async function readCelChunk(reader: ByteReader, chunkEnd: number): Promise<{ layerIndex: number; cel: Cel }> {
  const layerIndex = reader.u16();
  const x = reader.i16();
  const y = reader.i16();
  const opacity = reader.u8();
  const celType = reader.u16() as CelType;
  reader.i16(); // z-index
  reader.skip(5); // reserved

  if (celType === CelType.Linked) {
    const linkedFrame = reader.u16();
    return { layerIndex, cel: { x, y, width: 0, height: 0, opacity, pixels: new Uint8Array(0), linkedFrame } };
  }

  const width = reader.u16();
  const height = reader.u16();
  const payload = reader.slice(chunkEnd - reader.position);
  let pixels: Uint8Array;
  if (celType === CelType.Raw) {
    pixels = payload;
  } else if (celType === CelType.CompressedImage) {
    pixels = await inflate(payload);
  } else {
    // Compressed tilemap: not composited here; treat as empty so nothing draws.
    pixels = new Uint8Array(0);
  }
  return { layerIndex, cel: { x, y, width, height, opacity, pixels } };
}

/** Parse a 0x2019 palette chunk, updating the RGBA palette in place. Returns the
 *  count of defined entries (highest index + 1) so callers can trim the palette. */
function readPaletteChunk(reader: ByteReader, paletteRgba: Uint8Array): number {
  reader.u32(); // new size (palette is pre-sized to 256)
  const first = reader.u32();
  const last = reader.u32();
  reader.skip(8); // reserved
  for (let index = first; index <= last; index += 1) {
    const flags = reader.u16();
    const red = reader.u8();
    const green = reader.u8();
    const blue = reader.u8();
    const alpha = reader.u8();
    if (index < 256) {
      const base = index * 4;
      paletteRgba[base] = red;
      paletteRgba[base + 1] = green;
      paletteRgba[base + 2] = blue;
      paletteRgba[base + 3] = alpha;
    }
    if (flags & 0x01) readString(reader); // colour name
  }
  return Math.min(last + 1, 256);
}

/** Parse a legacy 0x0004 / 0x0011 palette chunk (packets of skip + colour runs).
 *  Returns the count of defined entries so callers can trim the palette. */
function readOldPaletteChunk(reader: ByteReader, paletteRgba: Uint8Array, sixBit: boolean): number {
  const packets = reader.u16();
  let index = 0;
  for (let packet = 0; packet < packets; packet += 1) {
    index += reader.u8(); // entries to skip from the previous packet
    let count = reader.u8();
    if (count === 0) count = 256;
    for (let entry = 0; entry < count; entry += 1) {
      const red = reader.u8();
      const green = reader.u8();
      const blue = reader.u8();
      if (index < 256) {
        const base = index * 4;
        paletteRgba[base] = sixBit ? scale6BitTo8Bit(red) : red;
        paletteRgba[base + 1] = sixBit ? scale6BitTo8Bit(green) : green;
        paletteRgba[base + 2] = sixBit ? scale6BitTo8Bit(blue) : blue;
        paletteRgba[base + 3] = 255;
      }
      index += 1;
    }
  }
  return Math.min(index, 256);
}

/**
 * Composite the visible cels of one frame onto a fresh RGBA bitmap, in layer
 * order (lowest layer first), honouring per-layer and per-cel opacity.
 */
function compositeFrame(
  width: number,
  height: number,
  depth: ColorDepth,
  layers: LayerInfo[],
  celsByLayer: Map<number, Cel>,
  paletteRgba: Uint8Array,
  transparentIndex: number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    const cel = celsByLayer.get(layerIndex);
    if (!layer?.visible || !cel || cel.width === 0 || cel.height === 0) continue;
    const layerAlpha = layer.opacity / 255;
    const celAlpha = cel.opacity / 255;
    for (let cy = 0; cy < cel.height; cy += 1) {
      const canvasY = cel.y + cy;
      if (canvasY < 0 || canvasY >= height) continue;
      for (let cx = 0; cx < cel.width; cx += 1) {
        const canvasX = cel.x + cx;
        if (canvasX < 0 || canvasX >= width) continue;
        const [red, green, blue, alpha] = pixelToRgba(
          depth,
          cel.pixels,
          cy * cel.width + cx,
          paletteRgba,
          transparentIndex,
        );
        const effectiveAlpha = alpha * layerAlpha * celAlpha;
        blendOver(pixels, (canvasY * width + canvasX) * 4, red, green, blue, effectiveAlpha);
      }
    }
  }
  return pixels;
}

/** Everything decoded from the file, before any flattening decision. */
interface ParsedAsepriteFile {
  width: number;
  height: number;
  colorDepth: ColorDepth;
  transparentIndex: number;
  paletteRgba: Uint8Array;
  paletteCount: number;
  layers: LayerInfo[];
  /** Resolved cels per frame, keyed by layer index (links already followed). */
  frameCels: Map<number, Cel>[];
  durations: number[];
}

/**
 * Read the whole Aseprite container into layers + per-frame cels, without
 * flattening — the shared core behind both the flatten (`parseAseprite`) and the
 * layer-exposing (`parseAsepriteLayers`) entry points. Rejects non-Aseprite
 * input; unknown chunks are skipped by their declared size.
 */
async function readAsepriteFile(bytes: Uint8Array): Promise<ParsedAsepriteFile> {
  const reader = new ByteReader(bytes);
  const { frameCount, width, height, colorDepth, transparentIndex } = readHeader(reader);

  // Palette starts opaque black; chunks overwrite the entries they define.
  const paletteRgba = new Uint8Array(256 * 4).fill(0);
  for (let index = 0; index < 256; index += 1) paletteRgba[index * 4 + 3] = 255;
  let paletteCount = 0;

  const layers: LayerInfo[] = [];
  const frameCels: Map<number, Cel>[] = [];
  const durations: number[] = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameStart = reader.position;
    const frameSize = reader.u32();
    const frameEnd = frameStart + frameSize;
    const magic = reader.u16();
    if (magic !== FRAME_MAGIC) {
      throw new Error(`Corrupt Aseprite frame ${frame} (bad frame magic).`);
    }
    const oldChunkCount = reader.u16();
    const durationMs = reader.u16();
    reader.skip(2); // reserved
    const newChunkCount = reader.u32();
    const chunkCount = newChunkCount !== 0 ? newChunkCount : oldChunkCount;

    const celsByLayer = new Map<number, Cel>();
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const chunkStart = reader.position;
      const chunkSize = reader.u32();
      const chunkEnd = chunkStart + chunkSize;
      const chunkType = reader.u16() as ChunkType;

      if (chunkType === ChunkType.Layer) {
        layers.push(readLayerChunk(reader));
      } else if (chunkType === ChunkType.Cel) {
        const { layerIndex, cel } = await readCelChunk(reader, chunkEnd);
        const resolved =
          cel.linkedFrame !== undefined ? frameCels[cel.linkedFrame]?.get(layerIndex) : undefined;
        const effective = resolved ? { ...resolved, x: cel.x, y: cel.y, opacity: cel.opacity } : cel;
        celsByLayer.set(layerIndex, effective);
      } else if (chunkType === ChunkType.Palette) {
        paletteCount = Math.max(paletteCount, readPaletteChunk(reader, paletteRgba));
      } else if (chunkType === ChunkType.OldPalette4) {
        paletteCount = Math.max(paletteCount, readOldPaletteChunk(reader, paletteRgba, false));
      } else if (chunkType === ChunkType.OldPalette11) {
        paletteCount = Math.max(paletteCount, readOldPaletteChunk(reader, paletteRgba, true));
      }

      // Always advance by the chunk's declared size so unknown chunks are skipped.
      reader.seek(chunkEnd);
    }

    frameCels[frame] = celsByLayer;
    durations[frame] = durationMs;
    reader.seek(frameEnd);
  }

  return { width, height, colorDepth, transparentIndex, paletteRgba, paletteCount, layers, frameCels, durations };
}

/** Build the trimmed RGB palette (the defined entries) from a parsed file. */
function extractPalette(file: ParsedAsepriteFile): Rgb[] {
  const palette: Rgb[] = [];
  for (let index = 0; index < file.paletteCount; index += 1) {
    const base = index * 4;
    palette.push([file.paletteRgba[base] ?? 0, file.paletteRgba[base + 1] ?? 0, file.paletteRgba[base + 2] ?? 0]);
  }
  return palette;
}

/**
 * Decode an Aseprite file into its palette and per-frame RGBA composites.
 * Rejects files that are not Aseprite; unrecognised chunks are skipped safely by
 * their declared size, so unsupported features degrade rather than throw.
 */
export async function parseAseprite(bytes: Uint8Array): Promise<AsepriteDocument> {
  const file = await readAsepriteFile(bytes);
  const frames: AsepriteFrame[] = file.frameCels.map((celsByLayer, index) => ({
    pixels: compositeFrame(
      file.width,
      file.height,
      file.colorDepth,
      file.layers,
      celsByLayer,
      file.paletteRgba,
      file.transparentIndex,
    ),
    durationMs: file.durations[index] ?? 0,
  }));

  return {
    width: file.width,
    height: file.height,
    colorDepth: file.colorDepth,
    // Any sprite can carry a palette; it is most meaningful for indexed sources.
    palette: extractPalette(file),
    layerCount: file.layers.length,
    frames,
  };
}

/** Render one layer's cel onto a fresh full-canvas straight-alpha RGBA bitmap. */
function renderLayerPixels(
  file: ParsedAsepriteFile,
  layerIndex: number,
  celsByLayer: Map<number, Cel>,
): Uint8ClampedArray | null {
  const cel = celsByLayer.get(layerIndex);
  if (!cel || cel.width === 0 || cel.height === 0) return null;
  const pixels = new Uint8ClampedArray(file.width * file.height * 4);
  for (let cy = 0; cy < cel.height; cy += 1) {
    const canvasY = cel.y + cy;
    if (canvasY < 0 || canvasY >= file.height) continue;
    for (let cx = 0; cx < cel.width; cx += 1) {
      const canvasX = cel.x + cx;
      if (canvasX < 0 || canvasX >= file.width) continue;
      const [red, green, blue, alpha] = pixelToRgba(
        file.colorDepth,
        cel.pixels,
        cy * cel.width + cx,
        file.paletteRgba,
        file.transparentIndex,
      );
      const base = (canvasY * file.width + canvasX) * 4;
      pixels[base] = red;
      pixels[base + 1] = green;
      pixels[base + 2] = blue;
      pixels[base + 3] = alpha;
    }
  }
  return pixels;
}

/**
 * Decode an Aseprite file into its individual layers (unflattened) for one
 * frame, each rendered to a full-canvas RGBA bitmap and tagged with its name and
 * nesting. Group layers carry `pixels: null`. This is what group-aware callers
 * (e.g. the handheld-skin extractor) use to pick and recolour layers by name.
 */
export async function parseAsepriteLayers(bytes: Uint8Array, frameIndex = 0): Promise<AsepriteLayers> {
  const file = await readAsepriteFile(bytes);
  const celsByLayer = file.frameCels[frameIndex] ?? new Map<number, Cel>();
  const layers: AsepriteLayer[] = file.layers.map((info, layerIndex) => ({
    name: info.name,
    type: info.type,
    childLevel: info.childLevel,
    visible: info.visible,
    opacity: info.opacity,
    pixels: info.type === AsepriteLayerType.Group ? null : renderLayerPixels(file, layerIndex, celsByLayer),
  }));
  return { width: file.width, height: file.height, layers };
}
