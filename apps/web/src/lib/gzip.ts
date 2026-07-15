/**
 * Gzip helpers over the Web Streams API, so text can be stored compactly — e.g.
 * a serialised editor document kept in localStorage, which is small enough for a
 * flat handheld render once compressed but not as raw base64. Browsers and modern
 * Node both expose CompressionStream/DecompressionStream globally, so this module
 * has no platform-specific dependency and is directly unit-testable.
 */

/** Drain a byte stream into a single contiguous array. */
async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
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

/** Push bytes through a (de)compression transform and collect the result. */
async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // The write/close chain rejects on invalid input (e.g. a non-gzip payload);
  // the same failure surfaces from readAll below, so swallow it here to avoid an
  // unhandled rejection while the caller still sees the error via readAll.
  void writer
    .write(bytes.slice())
    .then(() => writer.close())
    .catch(() => {});
  return readAll(stream.readable);
}

/** base64-encode bytes, chunked to avoid String.fromCharCode arg-count limits. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Decode base64 back to raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Gzip a UTF-8 string and return it base64-encoded. */
export async function gzipToBase64(text: string): Promise<string> {
  const input = new TextEncoder().encode(text);
  return bytesToBase64(await transform(input, new CompressionStream("gzip")));
}

/** Reverse {@link gzipToBase64}: base64 → gunzip → UTF-8 string. */
export async function base64GunzipToText(base64: string): Promise<string> {
  const bytes = base64ToBytes(base64);
  return new TextDecoder().decode(await transform(bytes, new DecompressionStream("gzip")));
}
