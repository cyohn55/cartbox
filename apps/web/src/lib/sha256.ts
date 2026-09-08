/**
 * SHA-256, shared by the two very different things in this codebase that hash
 * bytes: the Tier C asset vault (which hashes to *verify* a player's own files
 * match a known release) and the cart asset store (which hashes to *address*
 * creator-uploaded content).
 *
 * Extracted so there is one implementation rather than two, and kept in its own
 * module so neither of those importing it drags in the other — `assetVault.ts`
 * is browser-only OPFS code, and `cartAssetStore.ts` runs on the server.
 *
 * Pure and isomorphic: WebCrypto is available in browsers, Node 20+, and the
 * edge runtime alike.
 */

/** Lowercase hex SHA-256 of the given bytes, via the platform's WebCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied into a fresh array so the digest covers this view's own region: a
  // Uint8Array can be a window onto a larger buffer, and hashing the backing
  // buffer would silently hash the wrong bytes.
  const source = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
