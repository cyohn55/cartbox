/**
 * A WebM file from encoded video frames (AAA_FIDELITY_ROADMAP.md F10d): the
 * EBML header, then one Segment holding Info, one video track and Clusters of
 * SimpleBlocks, a new Cluster at each key frame (and before a block's time
 * would overflow its 16-bit offset). Built in memory, so every size is known
 * and written out; no Cues (players seek by scanning the Clusters).
 */

/** An encoded frame: its bytes, presentation time (ms) and whether it's a key frame. */
export interface WebmFrame {
  readonly data: Uint8Array;
  readonly timestamp: number;
  readonly key: boolean;
}

export interface WebmTrack {
  readonly width: number;
  readonly height: number;
  /** The Matroska codec ID: "V_VP9" or "V_VP8". */
  readonly codec: "V_VP9" | "V_VP8";
  /** The whole video's duration (ms). */
  readonly duration: number;
}

const ID = {
  ebml: 0x1a45dfa3,
  ebmlVersion: 0x4286,
  ebmlReadVersion: 0x42f7,
  maxIdLength: 0x42f2,
  maxSizeLength: 0x42f3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
} as const;

/** An element ID's own bytes (its leading bits already mark its length). */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}

/** A size as an 8-byte EBML variable-length integer. */
function sizeBytes(size: number): number[] {
  const out = [0x01];
  for (let i = 6; i >= 0; i -= 1) out.push(Math.floor(size / 2 ** (8 * i)) & 0xff);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function element(id: number, body: Uint8Array | readonly Uint8Array[]): Uint8Array {
  const data = body instanceof Uint8Array ? body : concat(body);
  return concat([Uint8Array.from([...idBytes(id), ...sizeBytes(data.length)]), data]);
}

function uint(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = Math.max(0, Math.round(value)); bytes.length === 0 || v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return element(id, Uint8Array.from(bytes));
}

function float(id: number, value: number): Uint8Array {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat64(0, value);
  return element(id, data);
}

const text = (id: number, value: string) => element(id, new TextEncoder().encode(value));

/** The longest a block may sit after its Cluster's time (a signed 16-bit offset, in ms). */
const MAX_OFFSET = 32767;

/** The WebM file of `frames` (in presentation order) on one video track. */
export function muxWebm(track: WebmTrack, frames: readonly WebmFrame[]): Uint8Array {
  const header = element(ID.ebml, [
    uint(ID.ebmlVersion, 1),
    uint(ID.ebmlReadVersion, 1),
    uint(ID.maxIdLength, 4),
    uint(ID.maxSizeLength, 8),
    text(ID.docType, "webm"),
    uint(ID.docTypeVersion, 2),
    uint(ID.docTypeReadVersion, 2),
  ]);
  const info = element(ID.info, [uint(ID.timecodeScale, 1_000_000), text(ID.muxingApp, "cartbox"), text(ID.writingApp, "cartbox"), float(ID.duration, track.duration)]);
  const tracks = element(ID.tracks, [
    element(ID.trackEntry, [
      uint(ID.trackNumber, 1),
      uint(ID.trackUid, 1),
      uint(ID.trackType, 1),
      text(ID.codecId, track.codec),
      element(ID.video, [uint(ID.pixelWidth, track.width), uint(ID.pixelHeight, track.height)]),
    ]),
  ]);
  const clusters: Uint8Array[] = [];
  let open: { time: number; blocks: Uint8Array[] } | null = null;
  const close = () => {
    if (open) clusters.push(element(ID.cluster, [uint(ID.timecode, open.time), ...open.blocks]));
    open = null;
  };
  for (const frame of frames) {
    const time = Math.max(0, Math.round(frame.timestamp));
    if (!open || frame.key || time - open.time > MAX_OFFSET) {
      close();
      open = { time, blocks: [] };
    }
    const offset = time - open!.time;
    const head = Uint8Array.from([0x81, (offset >> 8) & 0xff, offset & 0xff, frame.key ? 0x80 : 0x00]);
    open!.blocks.push(element(ID.simpleBlock, concat([head, frame.data])));
  }
  close();
  return concat([header, element(ID.segment, [info, tracks, ...clusters])]);
}

/** One element read back: its ID, where its body starts, and its size (for tests and checks). */
export interface EbmlElement {
  readonly id: number;
  readonly start: number;
  readonly size: number;
}

/** The elements directly inside `bytes[from, to)`. */
export function readEbml(bytes: Uint8Array, from = 0, to = bytes.length): EbmlElement[] {
  const out: EbmlElement[] = [];
  let o = from;
  const vint = (keepMarker: boolean): number => {
    const first = bytes[o]!;
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
    let value = keepMarker ? first : first & (0xff >> length);
    for (let i = 1; i < length; i += 1) value = value * 256 + bytes[o + i]!;
    o += length;
    return value;
  };
  while (o < to) {
    const id = vint(true);
    const size = vint(false);
    out.push({ id, start: o, size });
    o += size;
  }
  return out;
}
