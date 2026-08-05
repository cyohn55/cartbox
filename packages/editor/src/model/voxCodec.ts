/**
 * A reader and writer for the MagicaVoxel `.vox` format — the de-facto
 * interchange format for voxel art, and the natural export/import companion to
 * the true-3D {@link VoxelGrid} sculptor (whose interaction already mirrors
 * MagicaVoxel).
 *
 * The format is a small RIFF-like tree: an eight-byte header, then a single
 * `MAIN` chunk whose children carry the model. Each chunk is
 * `id(4) contentBytes(i32) childrenBytes(i32) content children`. This codec
 * handles the three chunks that describe a single model — `SIZE`, `XYZI`, and
 * the optional `RGBA` palette — and skips every scene-graph, material, and
 * layer chunk, which the editor's grid has no representation for.
 *
 * Two format details drive the mapping:
 *
 * 1. **Up axis.** MagicaVoxel is Z-up; a {@link VoxelGrid} is Y-up (see
 *    {@link voxelGridToModel}). The codec swaps Y and Z on the way in and out.
 *    The swap is its own inverse, so an export→import round-trip reproduces the
 *    grid exactly.
 * 2. **Palette indexing.** A voxel stores a colour index 1..255; the `RGBA`
 *    chunk's entry `p` (0-based) maps to index `p + 1`. Both the parsed palette
 *    and {@link DEFAULT_VOX_PALETTE} are exposed here indexed *by colour index*
 *    (entry 0 unused) so the two paths read identically.
 *
 * Lossy by design on export: `.vox` has no per-voxel emissive or per-face
 * texture, so a cell's emissive strength and material (see {@link VoxelCell})
 * are dropped — only geometry and RGB colour survive. Colours are quantised to
 * the format's 255-entry palette; sculpts drawn from the cart's fixed palette
 * fit well within that, and any overflow snaps to the nearest palette colour.
 *
 * Pure and DOM-free (operates on `Uint8Array`), so the same code serves the
 * editor's file buttons and the unit tests.
 */

import { VoxelGrid, MAX_VOXEL_GRID_DIM } from "./VoxelGrid";

/** ASCII "VOX " — the four magic bytes every file opens with. */
const MAGIC = 0x20584f56; // little-endian 'V','O','X',' '
/** The format version this codec writes; MagicaVoxel has emitted 150 for years. */
const VERSION = 150;
/** Bytes in a chunk's fixed header: id + contentBytes + childrenBytes. */
const CHUNK_HEADER_BYTES = 12;
/** Palette entries in an `RGBA` chunk, and colour indices in the format. */
const PALETTE_ENTRIES = 256;
/** The largest colour index a voxel record can carry (index 0 is empty). */
const MAX_COLOR_INDEX = 255;

const fourCC = (text: string): number =>
  text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24);

const CHUNK_MAIN = fourCC("MAIN");
const CHUNK_SIZE = fourCC("SIZE");
const CHUNK_XYZI = fourCC("XYZI");
const CHUNK_RGBA = fourCC("RGBA");

/**
 * MagicaVoxel's built-in palette, used only for a file that omits its own `RGBA`
 * chunk (MagicaVoxel itself always writes one, so this is a rare fallback path).
 * Each entry packs one colour as `0xAABBGGRR` — red in the low byte — and the
 * array is indexed directly by a voxel's colour index, with entry 0 reserved as
 * empty. Transcribed from the reference `ogt_vox` implementation.
 */
export const DEFAULT_VOX_PALETTE: readonly number[] = [
  0x00000000, 0xffffffff, 0xffccffff, 0xff99ffff, 0xff66ffff, 0xff33ffff, 0xff00ffff, 0xffffccff,
  0xffccccff, 0xff99ccff, 0xff66ccff, 0xff33ccff, 0xff00ccff, 0xffff99ff, 0xffcc99ff, 0xff9999ff,
  0xff6699ff, 0xff3399ff, 0xff0099ff, 0xffff66ff, 0xffcc66ff, 0xff9966ff, 0xff6666ff, 0xff3366ff,
  0xff0066ff, 0xffff33ff, 0xffcc33ff, 0xff9933ff, 0xff6633ff, 0xff3333ff, 0xff0033ff, 0xffff00ff,
  0xffcc00ff, 0xff9900ff, 0xff6600ff, 0xff3300ff, 0xff0000ff, 0xffffffcc, 0xffccffcc, 0xff99ffcc,
  0xff66ffcc, 0xff33ffcc, 0xff00ffcc, 0xffffcccc, 0xffcccccc, 0xff99cccc, 0xff66cccc, 0xff33cccc,
  0xff00cccc, 0xffff99cc, 0xffcc99cc, 0xff9999cc, 0xff6699cc, 0xff3399cc, 0xff0099cc, 0xffff66cc,
  0xffcc66cc, 0xff9966cc, 0xff6666cc, 0xff3366cc, 0xff0066cc, 0xffff33cc, 0xffcc33cc, 0xff9933cc,
  0xff6633cc, 0xff3333cc, 0xff0033cc, 0xffff00cc, 0xffcc00cc, 0xff9900cc, 0xff6600cc, 0xff3300cc,
  0xff0000cc, 0xffffff99, 0xffccff99, 0xff99ff99, 0xff66ff99, 0xff33ff99, 0xff00ff99, 0xffffcc99,
  0xffcccc99, 0xff99cc99, 0xff66cc99, 0xff33cc99, 0xff00cc99, 0xffff9999, 0xffcc9999, 0xff999999,
  0xff669999, 0xff339999, 0xff009999, 0xffff6699, 0xffcc6699, 0xff996699, 0xff666699, 0xff336699,
  0xff006699, 0xffff3399, 0xffcc3399, 0xff993399, 0xff663399, 0xff333399, 0xff003399, 0xffff0099,
  0xffcc0099, 0xff990099, 0xff660099, 0xff330099, 0xff000099, 0xffffff66, 0xffccff66, 0xff99ff66,
  0xff66ff66, 0xff33ff66, 0xff00ff66, 0xffffcc66, 0xffcccc66, 0xff99cc66, 0xff66cc66, 0xff33cc66,
  0xff00cc66, 0xffff9966, 0xffcc9966, 0xff999966, 0xff669966, 0xff339966, 0xff009966, 0xffff6666,
  0xffcc6666, 0xff996666, 0xff666666, 0xff336666, 0xff006666, 0xffff3366, 0xffcc3366, 0xff993366,
  0xff663366, 0xff333366, 0xff003366, 0xffff0066, 0xffcc0066, 0xff990066, 0xff660066, 0xff330066,
  0xff000066, 0xffffff33, 0xffccff33, 0xff99ff33, 0xff66ff33, 0xff33ff33, 0xff00ff33, 0xffffcc33,
  0xffcccc33, 0xff99cc33, 0xff66cc33, 0xff33cc33, 0xff00cc33, 0xffff9933, 0xffcc9933, 0xff999933,
  0xff669933, 0xff339933, 0xff009933, 0xffff6633, 0xffcc6633, 0xff996633, 0xff666633, 0xff336633,
  0xff006633, 0xffff3333, 0xffcc3333, 0xff993333, 0xff663333, 0xff333333, 0xff003333, 0xffff0033,
  0xffcc0033, 0xff990033, 0xff660033, 0xff330033, 0xff000033, 0xffffff00, 0xffccff00, 0xff99ff00,
  0xff66ff00, 0xff33ff00, 0xff00ff00, 0xffffcc00, 0xffcccc00, 0xff99cc00, 0xff66cc00, 0xff33cc00,
  0xff00cc00, 0xffff9900, 0xffcc9900, 0xff999900, 0xff669900, 0xff339900, 0xff009900, 0xffff6600,
  0xffcc6600, 0xff996600, 0xff666600, 0xff336600, 0xff006600, 0xffff3300, 0xffcc3300, 0xff993300,
  0xff663300, 0xff333300, 0xff003300, 0xffff0000, 0xffcc0000, 0xff990000, 0xff660000, 0xff330000,
  0xff0000ee, 0xff0000dd, 0xff0000bb, 0xff0000aa, 0xff000088, 0xff000077, 0xff000055, 0xff000044,
  0xff000022, 0xff000011, 0xff00ee00, 0xff00dd00, 0xff00bb00, 0xff00aa00, 0xff008800, 0xff007700,
  0xff005500, 0xff004400, 0xff002200, 0xff001100, 0xffee0000, 0xffdd0000, 0xffbb0000, 0xffaa0000,
  0xff880000, 0xff770000, 0xff550000, 0xff440000, 0xff220000, 0xff110000, 0xffeeeeee, 0xffdddddd,
  0xffbbbbbb, 0xffaaaaaa, 0xff888888, 0xff777777, 0xff555555, 0xff444444, 0xff222222, 0xff111111,
];

/** A palette as `256 × RGBA` bytes, indexed by voxel colour index (entry 0 unused). */
type Palette = Uint8Array;

/** Build the default palette as flat RGBA bytes, decoding each `0xAABBGGRR` word. */
function defaultPalette(): Palette {
  const bytes = new Uint8Array(PALETTE_ENTRIES * 4);
  for (let index = 0; index < PALETTE_ENTRIES; index += 1) {
    const packed = DEFAULT_VOX_PALETTE[index]!;
    bytes[index * 4] = packed & 0xff;
    bytes[index * 4 + 1] = (packed >> 8) & 0xff;
    bytes[index * 4 + 2] = (packed >> 16) & 0xff;
    bytes[index * 4 + 3] = (packed >> 24) & 0xff;
  }
  return bytes;
}

// --- Parsing --------------------------------------------------------------

/** The dimensions and voxels gathered from a file's chunks before assembly. */
interface ParsedModel {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** Flat `(x, y, z, colorIndex)` records, four bytes each. */
  voxels: Uint8Array;
  /** RGBA-per-colour-index, or the default palette when the file carried none. */
  palette: Palette;
}

function assertVoxDim(dim: number): void {
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_VOXEL_GRID_DIM) {
    throw new RangeError(`.vox model dimension must be an integer in 1..${MAX_VOXEL_GRID_DIM}, received ${dim}`);
  }
}

/**
 * Read a file's chunk tree into a {@link ParsedModel}. Reads the first `SIZE`
 * and `XYZI` (a single model — the overwhelmingly common case for a hand-made
 * asset) and the `RGBA` palette if present. Every read is bounds-checked against
 * the buffer, since the bytes are untrusted (they arrive from a user's file).
 */
function parseChunks(view: DataView, bytes: Uint8Array): ParsedModel {
  let sizeX = 0;
  let sizeY = 0;
  let sizeZ = 0;
  let voxels: Uint8Array | null = null;
  let palette: Palette | null = null;

  // Walk the children of MAIN. `end` is the exclusive byte after the last child.
  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + CHUNK_HEADER_BYTES <= end) {
      const id = view.getInt32(offset, true);
      const contentBytes = view.getInt32(offset + 4, true);
      const childrenBytes = view.getInt32(offset + 8, true);
      const contentStart = offset + CHUNK_HEADER_BYTES;
      const childrenStart = contentStart + contentBytes;
      const next = childrenStart + childrenBytes;
      // A declared span that runs past the buffer means the file is truncated or
      // malformed; stop rather than read out of bounds.
      if (contentBytes < 0 || childrenBytes < 0 || next > end) return;

      if (id === CHUNK_SIZE && sizeX === 0 && contentBytes >= 12) {
        sizeX = view.getInt32(contentStart, true);
        sizeY = view.getInt32(contentStart + 4, true);
        sizeZ = view.getInt32(contentStart + 8, true);
      } else if (id === CHUNK_XYZI && !voxels && contentBytes >= 4) {
        const count = view.getInt32(contentStart, true);
        const recordsStart = contentStart + 4;
        // Trust the record region, not the declared count, so a lying header
        // can't drive a read past the chunk's own content.
        const available = Math.floor((contentBytes - 4) / 4);
        const safeCount = Math.max(0, Math.min(count, available));
        voxels = bytes.subarray(recordsStart, recordsStart + safeCount * 4);
      } else if (id === CHUNK_RGBA && !palette && contentBytes >= PALETTE_ENTRIES * 4) {
        palette = new Uint8Array(PALETTE_ENTRIES * 4);
        // Per the format, RGBA entry p maps to colour index p + 1; index 0 stays
        // empty, so a voxel's colour index reads its palette entry directly.
        for (let p = 0; p < MAX_COLOR_INDEX; p += 1) {
          const src = contentStart + p * 4;
          const dst = (p + 1) * 4;
          palette![dst] = bytes[src]!;
          palette![dst + 1] = bytes[src + 1]!;
          palette![dst + 2] = bytes[src + 2]!;
          palette![dst + 3] = bytes[src + 3]!;
        }
      }
      offset = next;
    }
  };

  // The top-level MAIN chunk holds everything as children.
  const mainId = view.getInt32(8, true);
  if (mainId !== CHUNK_MAIN) throw new Error("Not a MagicaVoxel file: missing MAIN chunk");
  const mainContentBytes = view.getInt32(12, true);
  const mainChildrenStart = 8 + CHUNK_HEADER_BYTES + mainContentBytes;
  walk(mainChildrenStart, bytes.length);

  if (sizeX === 0) throw new Error("MagicaVoxel file has no SIZE chunk");
  assertVoxDim(sizeX);
  assertVoxDim(sizeY);
  assertVoxDim(sizeZ);
  return { sizeX, sizeY, sizeZ, voxels: voxels ?? new Uint8Array(0), palette: palette ?? defaultPalette() };
}

/**
 * Decode a `.vox` file into a {@link VoxelGrid}. The grid is sized to the file's
 * model with Y and Z swapped (Z-up → Y-up); voxels outside the declared size, or
 * carrying an empty colour index, are skipped defensively. Emissive is 0 and no
 * materials are set — the format carries neither. Throws on a non-`.vox` or
 * malformed file.
 */
export function parseVox(bytes: Uint8Array): VoxelGrid {
  if (bytes.length < 8) throw new Error("File is too short to be a MagicaVoxel .vox");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Not a MagicaVoxel file: bad magic bytes");

  const { sizeX, sizeY, sizeZ, voxels, palette } = parseChunks(view, bytes);
  // Z-up (vox) → Y-up (grid): grid X = vox X, grid Y = vox Z, grid Z = vox Y.
  const grid = new VoxelGrid(sizeX, sizeZ, sizeY);
  for (let record = 0; record + 4 <= voxels.length; record += 4) {
    const vx = voxels[record]!;
    const vy = voxels[record + 1]!;
    const vz = voxels[record + 2]!;
    const colorIndex = voxels[record + 3]!;
    if (colorIndex === 0 || vx >= sizeX || vy >= sizeY || vz >= sizeZ) continue;
    const entry = colorIndex * 4;
    grid.set(vx, vz, vy, palette[entry]!, palette[entry + 1]!, palette[entry + 2]!);
  }
  return grid;
}

// --- Encoding -------------------------------------------------------------

/** A voxel colour flattened for palette lookup, plus its final palette index. */
interface QuantizedGrid {
  /** Flat `(x, y, z, colorIndex)` records, four bytes each. */
  voxels: Uint8Array;
  /** The distinct colours actually used, in index order (index 1 = colours[0]). */
  colors: Array<[number, number, number]>;
}

const packRgb = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;

/** Squared RGB distance — cheap and monotonic, all a nearest-colour search needs. */
function colorDistanceSq(r: number, g: number, b: number, to: readonly [number, number, number]): number {
  const dr = r - to[0];
  const dg = g - to[1];
  const db = b - to[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Assign every filled cell a palette index, building the palette from the
 * distinct colours in the sculpt. A sculpt painted from the cart's fixed palette
 * has far fewer than 255 colours, so each maps to its own entry; if a grid
 * somehow exceeds the format's 255-colour limit, the overflow snaps to the
 * nearest colour already in the palette so no voxel is lost.
 */
function quantizeGrid(grid: VoxelGrid): QuantizedGrid {
  const colors: Array<[number, number, number]> = [];
  const indexByColor = new Map<number, number>();
  const records: number[] = [];

  // Z-up target: vox X = grid X, vox Y = grid Z, vox Z = grid Y.
  grid.forEachFilled((x, y, z, cell) => {
    const key = packRgb(cell.r, cell.g, cell.b);
    let paletteIndex = indexByColor.get(key);
    if (paletteIndex === undefined) {
      if (colors.length < MAX_COLOR_INDEX) {
        colors.push([cell.r, cell.g, cell.b]);
        paletteIndex = colors.length; // 1-based colour index
        indexByColor.set(key, paletteIndex);
      } else {
        // Palette is full — reuse the closest existing colour.
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < colors.length; i += 1) {
          const distance = colorDistanceSq(cell.r, cell.g, cell.b, colors[i]!);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        paletteIndex = best + 1;
        indexByColor.set(key, paletteIndex);
      }
    }
    records.push(x, z, y, paletteIndex);
  });

  return { voxels: Uint8Array.from(records), colors };
}

/** Write a chunk header (no children) and return the offset past the content. */
function writeChunkHeader(view: DataView, offset: number, id: number, contentBytes: number): number {
  view.setInt32(offset, id, true);
  view.setInt32(offset + 4, contentBytes, true);
  view.setInt32(offset + 8, 0, true); // childrenBytes — leaf chunks have none
  return offset + CHUNK_HEADER_BYTES;
}

/**
 * Encode a {@link VoxelGrid} to a `.vox` file (MagicaVoxel version 150). Writes
 * `SIZE`, `XYZI`, and an `RGBA` palette built from the sculpt's colours, so the
 * file reopens with its exact colours in MagicaVoxel and round-trips losslessly
 * through {@link parseVox}. Emissive and materials are not represented (see the
 * module note); an empty grid yields a valid one-voxel-free file.
 */
export function encodeVox(grid: VoxelGrid): Uint8Array {
  const { voxels, colors } = quantizeGrid(grid);
  const voxelCount = voxels.length / 4;

  const sizeContent = 12;
  const xyziContent = 4 + voxelCount * 4;
  const rgbaContent = PALETTE_ENTRIES * 4;
  const childrenBytes =
    CHUNK_HEADER_BYTES + sizeContent + CHUNK_HEADER_BYTES + xyziContent + CHUNK_HEADER_BYTES + rgbaContent;
  const total = 8 /* header */ + CHUNK_HEADER_BYTES /* MAIN */ + childrenBytes;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // File header: "VOX " + version.
  view.setUint32(0, MAGIC, true);
  view.setInt32(4, VERSION, true);

  // MAIN chunk: no content, all model chunks as children.
  view.setInt32(8, CHUNK_MAIN, true);
  view.setInt32(12, 0, true);
  view.setInt32(16, childrenBytes, true);

  let offset = 8 + CHUNK_HEADER_BYTES;

  // SIZE: the model's dimensions, Y and Z swapped back to the format's Z-up.
  offset = writeChunkHeader(view, offset, CHUNK_SIZE, sizeContent);
  view.setInt32(offset, grid.sizeX, true);
  view.setInt32(offset + 4, grid.sizeZ, true);
  view.setInt32(offset + 8, grid.sizeY, true);
  offset += sizeContent;

  // XYZI: the voxel records, already in Z-up order from quantizeGrid.
  offset = writeChunkHeader(view, offset, CHUNK_XYZI, xyziContent);
  view.setInt32(offset, voxelCount, true);
  offset += 4;
  out.set(voxels, offset);
  offset += voxels.length;

  // RGBA: colour index p + 1 is stored at entry p; unused tail stays zeroed.
  offset = writeChunkHeader(view, offset, CHUNK_RGBA, rgbaContent);
  for (let i = 0; i < colors.length; i += 1) {
    const [r, g, b] = colors[i]!;
    const entry = offset + i * 4;
    out[entry] = r;
    out[entry + 1] = g;
    out[entry + 2] = b;
    out[entry + 3] = 255;
  }

  return out;
}
