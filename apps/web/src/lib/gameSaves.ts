/**
 * Save persistence for the `wasm-app` runtime.
 *
 * A ported game's save is an opaque blob it produced through `cartbox_save`;
 * the host never interprets it. Saves live in the browser alongside the player's
 * other local data, per title and per slot.
 *
 * Storage sits behind `SaveStore` for the same reason the asset vault does: the
 * surrounding logic is then testable without a browser, and the contract stays
 * narrow enough to audit.
 */

export interface SaveSlot {
  titleId: string;
  /** Slot index. Most games use 0; the ABI does not limit how many a game keeps. */
  slot: number;
}

export interface SaveRecord extends SaveSlot {
  data: Uint8Array;
  savedAt: Date;
}

export interface SaveStore {
  write(slot: SaveSlot, data: Uint8Array): Promise<void>;
  read(slot: SaveSlot): Promise<SaveRecord | null>;
  remove(slot: SaveSlot): Promise<void>;
  listSlots(titleId: string): Promise<number[]>;
}

/**
 * Storage key for a slot.
 *
 * Title id is included so two games can never collide, and the slot index is
 * validated rather than interpolated blindly — it reaches a filesystem path.
 */
export function saveKey(slot: SaveSlot): string {
  if (!Number.isInteger(slot.slot) || slot.slot < 0) {
    throw new RangeError(`Invalid save slot: ${slot.slot}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(slot.titleId)) {
    throw new RangeError(`Invalid title id: ${slot.titleId}`);
  }
  return `${slot.titleId}.${slot.slot}.sav`;
}

/** Parses a storage key back into a slot, or null when it is not one. */
export function parseSaveKey(key: string): SaveSlot | null {
  const match = /^([A-Za-z0-9_-]+)\.(\d+)\.sav$/.exec(key);
  if (!match?.[1] || match[2] === undefined) {
    return null;
  }
  return { titleId: match[1], slot: Number(match[2]) };
}

/** OPFS-backed saves, under a `saves/` directory separate from game assets. */
export class OpfsSaveStore implements SaveStore {
  async #directory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
    try {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle("saves", { create });
    } catch {
      return null;
    }
  }

  async write(slot: SaveSlot, data: Uint8Array): Promise<void> {
    const directory = await this.#directory(true);
    if (!directory) {
      throw new Error("Local storage is unavailable");
    }
    const handle = await directory.getFileHandle(saveKey(slot), { create: true });
    const writable = await handle.createWritable();
    // Copy into a plain ArrayBuffer-backed view; a caller's array may be backed
    // by the WASM heap or a SharedArrayBuffer, which the write API rejects.
    await writable.write(Uint8Array.from(data));
    await writable.close();
  }

  async read(slot: SaveSlot): Promise<SaveRecord | null> {
    const directory = await this.#directory(false);
    if (!directory) {
      return null;
    }
    try {
      const file = await (await directory.getFileHandle(saveKey(slot))).getFile();
      return {
        ...slot,
        data: new Uint8Array(await file.arrayBuffer()),
        savedAt: new Date(file.lastModified),
      };
    } catch {
      return null;
    }
  }

  async remove(slot: SaveSlot): Promise<void> {
    const directory = await this.#directory(false);
    try {
      await directory?.removeEntry(saveKey(slot));
    } catch {
      // Already gone; removal is idempotent.
    }
  }

  async listSlots(titleId: string): Promise<number[]> {
    const directory = await this.#directory(false);
    if (!directory) {
      return [];
    }
    const slots: number[] = [];
    // @ts-expect-error — `keys()` is standard on FileSystemDirectoryHandle but
    // is missing from the DOM lib shipped with this TypeScript version.
    for await (const name of directory.keys()) {
      const parsed = parseSaveKey(name as string);
      if (parsed?.titleId === titleId) {
        slots.push(parsed.slot);
      }
    }
    return slots.sort((left, right) => left - right);
  }
}

/** In-memory saves, for tests and environments without OPFS. */
export class InMemorySaveStore implements SaveStore {
  readonly #records = new Map<string, SaveRecord>();

  async write(slot: SaveSlot, data: Uint8Array): Promise<void> {
    // Copy on write: the caller's array is often a view into the WASM heap,
    // which the next allocation may overwrite.
    this.#records.set(saveKey(slot), { ...slot, data: Uint8Array.from(data), savedAt: new Date() });
  }

  async read(slot: SaveSlot): Promise<SaveRecord | null> {
    const record = this.#records.get(saveKey(slot));
    return record ? { ...record, data: Uint8Array.from(record.data) } : null;
  }

  async remove(slot: SaveSlot): Promise<void> {
    this.#records.delete(saveKey(slot));
  }

  async listSlots(titleId: string): Promise<number[]> {
    return [...this.#records.values()]
      .filter((record) => record.titleId === titleId)
      .map((record) => record.slot)
      .sort((left, right) => left - right);
  }
}
