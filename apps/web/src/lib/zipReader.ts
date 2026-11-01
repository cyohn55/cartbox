/**
 * A small ZIP reader (for ambientCG's material downloads, F9f): the central
 * directory read for each entry's name and place, stored entries copied and
 * deflated ones inflated through the platform's `DecompressionStream`
 * ("deflate-raw"). No ZIP64, no encryption — neither appears in those archives.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The files in a ZIP: name → bytes. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: searched back from the end (a comment may follow it).
  let eocd = -1;
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 65535); o -= 1) {
    if (view.getUint32(o, true) === EOCD) {
      eocd = o;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive");
  const count = view.getUint16(eocd + 10, true);
  let o = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(o, true) !== CENTRAL) throw new Error("A ZIP's directory is damaged");
    const method = view.getUint16(o + 10, true);
    const compressed = view.getUint32(o + 20, true);
    const nameLength = view.getUint16(o + 28, true);
    const extraLength = view.getUint16(o + 30, true);
    const commentLength = view.getUint16(o + 32, true);
    const local = view.getUint32(o + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nameLength));
    o += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (view.getUint32(local, true) !== LOCAL) throw new Error("A ZIP entry is damaged");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new Error(`A ZIP entry uses an unsupported method (${method})`);
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
