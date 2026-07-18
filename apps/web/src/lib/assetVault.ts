/**
 * Client-side storage for user-supplied game data (Tier C titles).
 *
 * The player's own game files are stored in the browser's Origin Private File
 * System and never reach our servers. This is the platform's entire legal
 * posture on Tier C, so three properties are load-bearing, not incidental:
 *
 *   1. There is no upload path. This module has no network access of any kind,
 *      and no server route accepts these bytes.
 *   2. Keys are scoped by title *and* by nothing else — never by content hash.
 *      Content-addressed keys are what would let two accounts share one stored
 *      copy, which is precisely the mechanism that would make us a distributor
 *      rather than a viewer. Two players supplying identical files store two
 *      independent copies, on purpose.
 *   3. Nothing here reports what a player holds. No "someone already has this"
 *      lookup exists, because that too would turn stored bytes into a
 *      distribution signal.
 *
 * Storage I/O sits behind `AssetVault` so the surrounding logic can be tested
 * against an in-memory implementation without a browser.
 */

/** Metadata for one stored file. Bytes are fetched separately and lazily. */
export interface StoredAsset {
  path: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Per-title, per-origin storage for supplied game data.
 *
 * Deliberately narrow: put, list, read, and clear. There is no enumerate-all,
 * no cross-title query, and no export.
 */
export interface AssetVault {
  put(titleId: string, asset: StoredAsset, bytes: Uint8Array): Promise<void>;
  list(titleId: string): Promise<StoredAsset[]>;
  read(titleId: string, path: string): Promise<Uint8Array | null>;
  clear(titleId: string): Promise<void>;
}

/** Lowercase hex SHA-256 of the given bytes, via the platform's WebCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Thrown when the browser refuses to store more data. Surfaced distinctly from
 * ordinary failures because the remedy is the player's (free space, or supply a
 * smaller release), not a retry.
 */
export class VaultQuotaError extends Error {
  constructor(readonly requiredBytes: number) {
    super("Not enough browser storage to hold this game's data");
    this.name = "VaultQuotaError";
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NotAllowedError")
  );
}

/**
 * OPFS-backed vault. Files live under `titles/<titleId>/`, mirroring the paths
 * the engine expects so a runtime can mount the directory directly.
 */
export class OpfsAssetVault implements AssetVault {
  /** Files ≥ this size are streamed rather than buffered whole. */
  private static readonly METADATA_FILE = ".manifest.json";

  private async titleDirectory(titleId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const root = await navigator.storage.getDirectory();
    try {
      const titles = await root.getDirectoryHandle("titles", { create });
      return await titles.getDirectoryHandle(titleId, { create });
    } catch {
      // A missing directory simply means nothing has been supplied yet.
      return null;
    }
  }

  async put(titleId: string, asset: StoredAsset, bytes: Uint8Array): Promise<void> {
    const directory = await this.titleDirectory(titleId, true);
    if (!directory) {
      throw new Error(`Cannot open storage for title ${titleId}`);
    }

    try {
      // Paths may be nested (e.g. "Data Files/Morrowind.esm"), so walk and
      // create each segment rather than assuming a flat layout.
      const segments = asset.path.split("/").filter(Boolean);
      const fileName = segments.pop();
      if (!fileName) {
        throw new Error(`Invalid asset path: ${asset.path}`);
      }

      let target = directory;
      for (const segment of segments) {
        target = await target.getDirectoryHandle(segment, { create: true });
      }

      const handle = await target.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      // Copy into a plain ArrayBuffer-backed view: a caller's Uint8Array may be
      // backed by a SharedArrayBuffer, which the file-system write API rejects.
      await writable.write(Uint8Array.from(bytes));
      await writable.close();

      await this.writeMetadata(directory, asset);
    } catch (error) {
      if (isQuotaError(error)) {
        throw new VaultQuotaError(asset.sizeBytes);
      }
      throw error;
    }
  }

  /**
   * Records what has been stored. Kept as a sidecar rather than re-hashing on
   * every visit: re-reading multi-gigabyte game data to rebuild a list the
   * browser could have remembered would make the title page unusable.
   */
  private async writeMetadata(
    directory: FileSystemDirectoryHandle,
    asset: StoredAsset,
  ): Promise<void> {
    const existing = await this.readMetadata(directory);
    const next = [...existing.filter((entry) => entry.path !== asset.path), asset];
    const handle = await directory.getFileHandle(OpfsAssetVault.METADATA_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new TextEncoder().encode(JSON.stringify(next)));
    await writable.close();
  }

  private async readMetadata(directory: FileSystemDirectoryHandle): Promise<StoredAsset[]> {
    try {
      const handle = await directory.getFileHandle(OpfsAssetVault.METADATA_FILE);
      const text = await (await handle.getFile()).text();
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as StoredAsset[]) : [];
    } catch {
      // No sidecar yet, or it was evicted — treat as nothing stored.
      return [];
    }
  }

  async list(titleId: string): Promise<StoredAsset[]> {
    const directory = await this.titleDirectory(titleId, false);
    return directory ? this.readMetadata(directory) : [];
  }

  async read(titleId: string, path: string): Promise<Uint8Array | null> {
    const directory = await this.titleDirectory(titleId, false);
    if (!directory) {
      return null;
    }
    try {
      const segments = path.split("/").filter(Boolean);
      const fileName = segments.pop();
      if (!fileName) {
        return null;
      }
      let target = directory;
      for (const segment of segments) {
        target = await target.getDirectoryHandle(segment);
      }
      const handle = await target.getFileHandle(fileName);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }

  async clear(titleId: string): Promise<void> {
    const root = await navigator.storage.getDirectory();
    try {
      const titles = await root.getDirectoryHandle("titles");
      await titles.removeEntry(titleId, { recursive: true });
    } catch {
      // Already absent; clearing is idempotent.
    }
  }
}

/**
 * In-memory vault used by tests and by any environment without OPFS.
 *
 * Mirrors the real implementation's isolation exactly — keyed by title, no
 * cross-title access — so tests exercise the same contract the browser does.
 */
export class InMemoryAssetVault implements AssetVault {
  private readonly files = new Map<string, Map<string, { asset: StoredAsset; bytes: Uint8Array }>>();

  /** Optional cap, so quota handling can be exercised deterministically. */
  constructor(private readonly capacityBytes = Number.POSITIVE_INFINITY) {}

  // ECMAScript-private, not just `private`: a TypeScript modifier still leaves
  // the method on the prototype at runtime, and the vault's public surface is
  // asserted in tests precisely to keep cross-title access from creeping in.
  #usedBytes(): number {
    let total = 0;
    for (const title of this.files.values()) {
      for (const entry of title.values()) {
        total += entry.asset.sizeBytes;
      }
    }
    return total;
  }

  async put(titleId: string, asset: StoredAsset, bytes: Uint8Array): Promise<void> {
    const title = this.files.get(titleId) ?? new Map();
    const replacing = title.get(asset.path)?.asset.sizeBytes ?? 0;
    if (this.#usedBytes() - replacing + asset.sizeBytes > this.capacityBytes) {
      throw new VaultQuotaError(asset.sizeBytes);
    }
    title.set(asset.path, { asset, bytes });
    this.files.set(titleId, title);
  }

  async list(titleId: string): Promise<StoredAsset[]> {
    return [...(this.files.get(titleId)?.values() ?? [])].map((entry) => entry.asset);
  }

  async read(titleId: string, path: string): Promise<Uint8Array | null> {
    return this.files.get(titleId)?.get(path)?.bytes ?? null;
  }

  async clear(titleId: string): Promise<void> {
    this.files.delete(titleId);
  }
}
