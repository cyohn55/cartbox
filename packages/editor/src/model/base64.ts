/**
 * Portable base64 for binary payloads, with no dependency on Node's `Buffer` so
 * the same code runs in the browser editor, the server render path, and the unit
 * tests. Used to embed typed-array geometry and compressed image bytes inside the
 * JSON sidecars that carry an asset in a cart.
 */

/** Encode raw bytes to a base64 string, chunked to stay within the call-stack limit. */
export function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let binary = "";
  const chunk = 0x8000; // 32KB per String.fromCharCode call — spreading the whole array overflows the stack
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Decode a base64 string back to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
