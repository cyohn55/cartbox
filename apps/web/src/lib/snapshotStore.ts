/**
 * Where a cart's snapshots live (ENGINE_PARITY_ROADMAP.md EP19): one interface,
 * two homes.
 *
 * - **The account** (signed in, on the server build): the snapshots API,
 *   `/api/carts/[cartId]/snapshots`, which keeps them in object storage, so
 *   they follow the creator between machines.
 * - **This browser** (signed out, or the static demo build): IndexedDB, behind
 *   a small key-value seam so tests run it on a Map.
 *
 * Both store a snapshot as its packed (gzipped) payload; see cartSnapshots.ts.
 */

import { MAX_SNAPSHOTS, packSnapshot, snapshotName, sortSnapshots, unpackSnapshot, type SnapshotContent, type SnapshotInfo } from "./cartSnapshots";

export interface SnapshotStore {
  /** "account" or "browser": where these snapshots are kept (shown to the creator). */
  readonly home: "account" | "browser";
  list(): Promise<SnapshotInfo[]>;
  take(name: string, content: SnapshotContent): Promise<SnapshotInfo>;
  open(id: string): Promise<SnapshotContent | null>;
  remove(id: string): Promise<void>;
}

/** A failure the creator can read (the server's own message when there is one). */
export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

type Request = (url: string, init?: RequestInit) => Promise<Response>;

async function failure(res: Response, fallback: string): Promise<SnapshotError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return new SnapshotError(body.error, res.status);
  } catch {
    // Not JSON.
  }
  return new SnapshotError(fallback, res.status);
}

const isInfo = (v: unknown): v is SnapshotInfo => {
  const r = v as Record<string, unknown> | null;
  return !!r && typeof r.id === "string" && typeof r.name === "string" && typeof r.createdAt === "string" && typeof r.size === "number";
};

/** The account's snapshots, through the API. `request` adds the session's auth. */
export function accountSnapshots(cartId: string, request: Request): SnapshotStore {
  const base = `/api/carts/${cartId}/snapshots`;
  return {
    home: "account",
    async list() {
      const res = await request(base);
      if (!res.ok) throw await failure(res, "Snapshots could not be listed.");
      const body = (await res.json()) as { snapshots?: unknown };
      return sortSnapshots(Array.isArray(body.snapshots) ? body.snapshots.filter(isInfo) : []);
    },
    async take(name, content) {
      const packed = await packSnapshot(content);
      const res = await request(`${base}?name=${encodeURIComponent(snapshotName(name) ?? "Snapshot")}`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: packed.buffer as ArrayBuffer,
      });
      if (!res.ok) throw await failure(res, "The snapshot could not be saved.");
      const body = (await res.json()) as { snapshot?: unknown };
      if (!isInfo(body.snapshot)) throw new SnapshotError("The snapshot could not be saved.");
      return body.snapshot;
    },
    async open(id) {
      const res = await request(`${base}/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, "The snapshot could not be read.");
      return unpackSnapshot(new Uint8Array(await res.arrayBuffer()));
    },
    async remove(id) {
      const res = await request(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw await failure(res, "The snapshot could not be deleted.");
    },
  };
}

/** A stored snapshot in the browser: its listing plus its packed payload. */
export interface StoredSnapshot extends SnapshotInfo {
  readonly cartId: string;
  readonly payload: Uint8Array;
}

/** The browser seam: every snapshot of one cart, put, and deleted. */
export interface SnapshotKV {
  all(cartId: string): Promise<StoredSnapshot[]>;
  put(record: StoredSnapshot): Promise<void>;
  delete(id: string): Promise<void>;
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** This browser's snapshots of a cart. */
export function browserSnapshots(cartId: string, kv: SnapshotKV, now: () => Date = () => new Date()): SnapshotStore {
  const info = ({ id, name, createdAt, size }: StoredSnapshot): SnapshotInfo => ({ id, name, createdAt, size });
  return {
    home: "browser",
    async list() {
      return sortSnapshots((await kv.all(cartId)).map(info));
    },
    async take(name, content) {
      const existing = await kv.all(cartId);
      if (existing.length >= MAX_SNAPSHOTS) throw new SnapshotError(`A cart keeps at most ${MAX_SNAPSHOTS} snapshots: delete an old one first.`, 409);
      const payload = await packSnapshot(content);
      const record: StoredSnapshot = { id: newId(), cartId, name: snapshotName(name) ?? "Snapshot", createdAt: now().toISOString(), size: payload.length, payload };
      try {
        await kv.put(record);
      } catch {
        throw new SnapshotError("This browser's storage is full, so the snapshot could not be kept.");
      }
      return info(record);
    },
    async open(id) {
      const record = (await kv.all(cartId)).find((r) => r.id === id);
      return record ? unpackSnapshot(record.payload) : null;
    },
    async remove(id) {
      await kv.delete(id);
    },
  };
}

const DB_NAME = "cartbox-snapshots";
const STORE = "snapshots";

/** The browser seam on IndexedDB (one database, snapshots indexed by cart). */
export function indexedDbSnapshots(factory: IDBFactory = indexedDB): SnapshotKV {
  let opening: Promise<IDBDatabase> | null = null;
  const db = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("cartId", "cartId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opening = null;
        reject(req.error);
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await db()).transaction(STORE, mode);
    const req = work(tx.objectStore(STORE));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    all: (cartId) => run("readonly", (store) => store.index("cartId").getAll(cartId) as IDBRequest<StoredSnapshot[]>),
    put: async (record) => {
      await run("readwrite", (store) => store.put(record));
    },
    delete: async (id) => {
      await run("readwrite", (store) => store.delete(id));
    },
  };
}
