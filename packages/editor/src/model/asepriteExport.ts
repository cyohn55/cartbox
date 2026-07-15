/**
 * Encode a single-frame indexed sprite back into the Aseprite (`.aseprite`)
 * binary format, so a sheet imported and edited in Cartbox can be written out
 * and reopened in Aseprite (a true round trip). We emit the minimum a valid file
 * needs: header, one frame, a colour-profile chunk, both palette chunk forms
 * (legacy + current, matching what Aseprite itself writes), one normal layer,
 * and one zlib-compressed image cel.
 *
 * Pure and DOM-free — its only platform dependency is `CompressionStream`, the
 * Web Streams counterpart to the parser's `DecompressionStream`.
 *
 * Spec reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
 */

import type { Rgb } from "./paletteImport";

const FILE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const COLOR_DEPTH_INDEXED = 8;
const COLOR_DEPTH_RGBA = 32;
const MAX_PALETTE = 256;

/** Chunk type identifiers we write. */
const CHUNK_COLOR_PROFILE = 0x2007;
const CHUNK_OLD_PALETTE = 0x0004;
const CHUNK_PALETTE = 0x2019;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;

/** An indexed image to write: palette plus one index per pixel, row-major. */
export interface AsepriteExportImage {
  readonly width: number;
  readonly height: number;
  /** Palette as RGB triplets (max 256 entries; alpha is written as opaque). */
  readonly palette: ReadonlyArray<Rgb>;
  /** Palette index per pixel, length `width * height`. */
  readonly indices: Uint8Array;
  /** Palette index treated as transparent (default 0). */
  readonly transparentIndex?: number;
  /** Optional layer name shown in Aseprite (default "Layer 1"). */
  readonly layerName?: string;
  /** Optional frame duration in milliseconds (default 100). */
  readonly durationMs?: number;
}

/** A growable little-endian byte buffer with just the primitives we emit. */
class ByteWriter {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  i16(value: number): void {
    this.u16(value & 0xffff);
  }

  u32(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  }

  zeros(count: number): void {
    for (let index = 0; index < count; index += 1) this.bytes.push(0);
  }

  raw(data: Uint8Array): void {
    for (const byte of data) this.bytes.push(byte);
  }

  /** Overwrite a previously reserved u32 (used to patch size fields). */
  patchU32(offset: number, value: number): void {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >> 8) & 0xff;
    this.bytes[offset + 2] = (value >> 16) & 0xff;
    this.bytes[offset + 3] = (value >> 24) & 0xff;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Deflate (zlib) bytes for cel storage using the Web Streams API — the mirror of
 * the parser's inflate — so no Node-specific `zlib` import is needed.
 */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
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

/** Serialise one chunk (6-byte size+type header, then its body) into `writer`. */
function writeChunk(writer: ByteWriter, type: number, body: Uint8Array): void {
  writer.u32(body.length + 6);
  writer.u16(type);
  writer.raw(body);
}

/** Aseprite STRING: u16 length prefix then UTF-8 bytes. */
function encodeString(text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text);
  const out = new Uint8Array(utf8.length + 2);
  out[0] = utf8.length & 0xff;
  out[1] = (utf8.length >> 8) & 0xff;
  out.set(utf8, 2);
  return out;
}

/** Body of the sRGB colour-profile chunk (0x2007). */
function colorProfileBody(): Uint8Array {
  const body = new ByteWriter();
  body.u16(1); // type: sRGB
  body.u16(0); // flags
  body.u32(0); // fixed-point gamma (unused for sRGB)
  body.zeros(8); // reserved
  return body.toUint8Array();
}

/** Body of the modern palette chunk (0x2019). */
function paletteBody(palette: ReadonlyArray<Rgb>, count: number): Uint8Array {
  const body = new ByteWriter();
  body.u32(count); // new palette size
  body.u32(0); // first index to change
  body.u32(count - 1); // last index to change
  body.zeros(8); // reserved
  for (let index = 0; index < count; index += 1) {
    const [red, green, blue] = palette[index] ?? [0, 0, 0];
    body.u16(0); // entry flags (no name)
    body.u8(red);
    body.u8(green);
    body.u8(blue);
    body.u8(255); // alpha (opaque)
  }
  return body.toUint8Array();
}

/** Body of the legacy palette chunk (0x0004) Aseprite still writes for compat. */
function oldPaletteBody(palette: ReadonlyArray<Rgb>, count: number): Uint8Array {
  const body = new ByteWriter();
  body.u16(1); // one packet
  body.u8(0); // skip 0 entries
  body.u8(count === MAX_PALETTE ? 0 : count); // 0 encodes a full 256 run
  for (let index = 0; index < count; index += 1) {
    const [red, green, blue] = palette[index] ?? [0, 0, 0];
    body.u8(red);
    body.u8(green);
    body.u8(blue);
  }
  return body.toUint8Array();
}

/** Body of the single normal layer chunk (0x2004). */
function layerBody(name: string): Uint8Array {
  const body = new ByteWriter();
  body.u16(0x01); // flags: visible
  body.u16(0); // type: normal image
  body.u16(0); // child level
  body.u16(0); // default width (ignored)
  body.u16(0); // default height (ignored)
  body.u16(0); // blend mode: normal
  body.u8(255); // opacity
  body.zeros(3); // reserved
  body.raw(encodeString(name));
  return body.toUint8Array();
}

/** Body of the compressed image cel chunk (0x2005) covering the whole canvas. */
function celBody(layerIndex: number, width: number, height: number, compressed: Uint8Array): Uint8Array {
  const body = new ByteWriter();
  body.u16(layerIndex);
  body.i16(0); // x
  body.i16(0); // y
  body.u8(255); // opacity
  body.u16(2); // cel type: compressed image
  body.i16(0); // z-index
  body.zeros(5); // reserved
  body.u16(width);
  body.u16(height);
  body.raw(compressed);
  return body.toUint8Array();
}

/**
 * Encode an indexed image into a valid one-frame `.aseprite` file. Throws on
 * dimensions that disagree with the index count so callers fail loudly rather
 * than emitting a corrupt file.
 */
export async function encodeAseprite(image: AsepriteExportImage): Promise<Uint8Array> {
  const { width, height, indices } = image;
  if (indices.length !== width * height) {
    throw new Error(`Index count ${indices.length} does not match ${width}x${height} canvas.`);
  }
  const paletteCount = Math.min(Math.max(image.palette.length, 1), MAX_PALETTE);
  const transparentIndex = image.transparentIndex ?? 0;
  const layerName = image.layerName ?? "Layer 1";
  const durationMs = image.durationMs ?? 100;

  const compressed = await deflate(indices);

  const chunks: Array<{ type: number; body: Uint8Array }> = [
    { type: CHUNK_COLOR_PROFILE, body: colorProfileBody() },
    { type: CHUNK_OLD_PALETTE, body: oldPaletteBody(image.palette, paletteCount) },
    { type: CHUNK_PALETTE, body: paletteBody(image.palette, paletteCount) },
    { type: CHUNK_LAYER, body: layerBody(layerName) },
    { type: CHUNK_CEL, body: celBody(0, width, height, compressed) },
  ];

  const writer = new ByteWriter();

  // --- Header (128 bytes) ---
  const fileSizeOffset = writer.length;
  writer.u32(0); // file size (patched below)
  writer.u16(FILE_MAGIC);
  writer.u16(1); // frame count
  writer.u16(width);
  writer.u16(height);
  writer.u16(COLOR_DEPTH_INDEXED);
  writer.u32(1); // flags: layer opacity is valid
  writer.u16(0); // deprecated speed
  writer.u32(0); // reserved
  writer.u32(0); // reserved
  writer.u8(transparentIndex);
  writer.zeros(3); // ignored
  writer.u16(paletteCount);
  writer.u8(1); // pixel width ratio
  writer.u8(1); // pixel height ratio
  writer.i16(0); // grid x
  writer.i16(0); // grid y
  writer.u16(16); // grid width
  writer.u16(16); // grid height
  writer.zeros(84); // reserved

  // --- Frame header (16 bytes) ---
  const frameSizeOffset = writer.length;
  writer.u32(0); // bytes in frame (patched below)
  writer.u16(FRAME_MAGIC);
  writer.u16(chunks.length); // old chunk count
  writer.u16(durationMs);
  writer.zeros(2); // reserved
  writer.u32(chunks.length); // new chunk count

  for (const chunk of chunks) writeChunk(writer, chunk.type, chunk.body);

  writer.patchU32(frameSizeOffset, writer.length - frameSizeOffset);
  writer.patchU32(fileSizeOffset, writer.length);

  return writer.toUint8Array();
}

/** One straight-alpha RGBA layer for a multi-layer RGBA `.aseprite` export. */
export interface AsepriteRgbaLayer {
  readonly name: string;
  readonly visible: boolean;
  /** Layer opacity, 0..255. */
  readonly opacity: number;
  /** Straight-alpha RGBA pixels, length `width * height * 4`. */
  readonly pixels: Uint8ClampedArray;
}

/** Body of an RGBA normal layer chunk (0x2004) with its own visibility/opacity. */
function rgbaLayerBody(name: string, visible: boolean, opacity: number): Uint8Array {
  const body = new ByteWriter();
  body.u16(visible ? 0x01 : 0x00); // flags: visible bit
  body.u16(0); // type: normal image
  body.u16(0); // child level
  body.u16(0); // default width (ignored)
  body.u16(0); // default height (ignored)
  body.u16(0); // blend mode: normal
  body.u8(Math.max(0, Math.min(255, Math.round(opacity))));
  body.zeros(3); // reserved
  body.raw(encodeString(name));
  return body.toUint8Array();
}

/**
 * Encode straight-alpha RGBA layers into a valid one-frame RGBA `.aseprite`
 * file — one normal layer plus one full-canvas compressed cel per input layer,
 * bottom-first. Unlike {@link encodeAseprite}, this preserves full colour and
 * layer structure (no palette quantisation), so free-form art drawn in Cartbox
 * reopens faithfully in Aseprite. Throws if any layer's size disagrees with the
 * canvas, so callers fail loudly rather than writing a corrupt file.
 */
export async function encodeAsepriteRgba(
  layers: ReadonlyArray<AsepriteRgbaLayer>,
  width: number,
  height: number,
  durationMs = 100,
): Promise<Uint8Array> {
  if (layers.length === 0) {
    throw new Error("An RGBA .aseprite needs at least one layer.");
  }
  const expected = width * height * 4;
  for (const layer of layers) {
    if (layer.pixels.length !== expected) {
      throw new Error(`Layer "${layer.name}" has ${layer.pixels.length} bytes, expected ${expected} for ${width}x${height}.`);
    }
  }

  // All layer chunks first (bottom-to-top), then a cel per layer referencing it.
  const chunks: Array<{ type: number; body: Uint8Array }> = [{ type: CHUNK_COLOR_PROFILE, body: colorProfileBody() }];
  for (const layer of layers) {
    chunks.push({ type: CHUNK_LAYER, body: rgbaLayerBody(layer.name, layer.visible, layer.opacity) });
  }
  for (let index = 0; index < layers.length; index += 1) {
    const compressed = await deflate(Uint8Array.from(layers[index]!.pixels));
    chunks.push({ type: CHUNK_CEL, body: celBody(index, width, height, compressed) });
  }

  const writer = new ByteWriter();

  // --- Header (128 bytes) ---
  const fileSizeOffset = writer.length;
  writer.u32(0); // file size (patched below)
  writer.u16(FILE_MAGIC);
  writer.u16(1); // frame count
  writer.u16(width);
  writer.u16(height);
  writer.u16(COLOR_DEPTH_RGBA);
  writer.u32(1); // flags: layer opacity is valid
  writer.u16(0); // deprecated speed
  writer.u32(0); // reserved
  writer.u32(0); // reserved
  writer.u8(0); // transparent index (unused in RGBA)
  writer.zeros(3); // ignored
  writer.u16(0); // palette size (none for RGBA)
  writer.u8(1); // pixel width ratio
  writer.u8(1); // pixel height ratio
  writer.i16(0); // grid x
  writer.i16(0); // grid y
  writer.u16(16); // grid width
  writer.u16(16); // grid height
  writer.zeros(84); // reserved

  // --- Frame header (16 bytes) ---
  const frameSizeOffset = writer.length;
  writer.u32(0); // bytes in frame (patched below)
  writer.u16(FRAME_MAGIC);
  writer.u16(chunks.length); // old chunk count
  writer.u16(durationMs);
  writer.zeros(2); // reserved
  writer.u32(chunks.length); // new chunk count

  for (const chunk of chunks) writeChunk(writer, chunk.type, chunk.body);

  writer.patchU32(frameSizeOffset, writer.length - frameSizeOffset);
  writer.patchU32(fileSizeOffset, writer.length);

  return writer.toUint8Array();
}
