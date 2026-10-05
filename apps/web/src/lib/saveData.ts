/**
 * Keeping a cart's save data (ENGINE_PARITY_ROADMAP.md EP15b): what the cart
 * saved with cartbox.save, in this browser (localStorage, per cart) and, for a
 * signed-in player, in their account (/api/carts/[cartId]/save). Whichever
 * copy is newer wins when a cart starts; a save writes the browser's copy at
 * once and the account's a moment later (saves often come in bursts).
 */

import { validSave } from "@cartbox/player";

/** The largest save any core makes (its 16 KB block, less the header), with room for JSON escaping. */
export const MAX_SAVE_CHARS = 16384;

export interface StoredSave {
  readonly data: string;
  readonly updatedAt: string;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** The browser's key for a cart's save; the editor's playtest keeps its own, apart from players'. */
export function saveKey(cartId: string, scope: "play" | "playtest" = "play"): string {
  return `cartbox:save:${scope}:${cartId}`;
}

const isTime = (t: unknown): t is string => typeof t === "string" && Number.isFinite(Date.parse(t));

/** A stored save read defensively (null when missing or malformed). */
export function readLocalSave(storage: Storage | null | undefined, key: string): StoredSave | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: unknown; updatedAt?: unknown };
    const data = typeof parsed.data === "string" ? validSave(parsed.data) : null;
    return data && isTime(parsed.updatedAt) ? { data, updatedAt: parsed.updatedAt } : null;
  } catch {
    return null;
  }
}

/** Keep (or with null, forget) a save in the browser. Storage being full or off is not an error. */
export function writeLocalSave(storage: Storage | null | undefined, key: string, data: string | null, updatedAt: string): void {
  try {
    if (data === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify({ data, updatedAt }));
  } catch {
    // Private mode or a full quota: the save still lives in the account, or for this session.
  }
}

/** The newer of two saves (either may be missing). */
export function newerSave(a: StoredSave | null, b: StoredSave | null): StoredSave | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a;
}

/** A PUT body for the save route, checked: JSON text of an object or list within the cap, and a time not in the future. */
export function parseCloudSaveBody(raw: string, now = Date.now()): StoredSave | null {
  try {
    const body = JSON.parse(raw) as { data?: unknown; updatedAt?: unknown };
    if (typeof body.data !== "string" || body.data.length > MAX_SAVE_CHARS || !isTime(body.updatedAt)) return null;
    const data = validSave(body.data);
    if (!data) return null;
    // A clock a little ahead is fine; a save dated far ahead would win every comparison.
    const at = Math.min(Date.parse(body.updatedAt), now + 5 * 60_000);
    return { data, updatedAt: new Date(at).toISOString() };
  } catch {
    return null;
  }
}

export interface SaveKeeperOptions {
  readonly cartId: string;
  readonly scope?: "play" | "playtest";
  /** Keep saves in the player's account too (signed in, on the hosted site). */
  readonly cloud: boolean;
  readonly storage?: Storage | null;
  /** fetch with the session's auth headers. */
  readonly request?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  /** How long a burst of saves settles before the account's copy is written (ms). */
  readonly settle?: number;
}

/**
 * The save to start a cart from (the newer of the browser's and the account's),
 * and an onSave that keeps each new one.
 */
export interface SaveKeeper {
  /** The save to start the cart from: the newest, including any made since the keeper opened. */
  readonly data: string | null;
  readonly onSave: (data: string | null) => void;
  /** Write the account's copy now (on leaving the page). */
  readonly flush: () => Promise<void>;
}

/** The browser's localStorage, or null where it's unavailable (a server render, blocked storage). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export async function openSaves(options: SaveKeeperOptions): Promise<SaveKeeper> {
  const storage = options.storage ?? null;
  const key = saveKey(options.cartId, options.scope);
  const url = `/api/carts/${options.cartId}/save`;
  const now = options.now ?? Date.now;
  let cloud: StoredSave | null = null;
  if (options.cloud && options.request) {
    try {
      const res = await options.request(url);
      if (res.ok) {
        const body = (await res.json()) as { data?: unknown; updatedAt?: unknown };
        const data = typeof body.data === "string" ? validSave(body.data) : null;
        if (data && isTime(body.updatedAt)) cloud = { data, updatedAt: body.updatedAt };
      }
    } catch {
      // Offline: the browser's copy will do.
    }
  }
  const start = newerSave(readLocalSave(storage, key), cloud);
  if (start && start === cloud) writeLocalSave(storage, key, start.data, start.updatedAt);

  let current = start?.data ?? null;
  let pending: { data: string | null; updatedAt: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = async () => {
    timer = null;
    const next = pending;
    pending = null;
    if (!next || !options.cloud || !options.request) return;
    try {
      if (next.data === null) await options.request(url, { method: "DELETE" });
      else await options.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    } catch {
      // Kept in the browser; the account catches up on the next save.
    }
  };
  return {
    get data() {
      return current;
    },
    onSave: (data) => {
      current = data;
      const updatedAt = new Date(now()).toISOString();
      writeLocalSave(storage, key, data, updatedAt);
      pending = { data, updatedAt };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void send(), options.settle ?? 2000);
    },
    flush: async () => {
      if (timer) clearTimeout(timer);
      await send();
    },
  };
}
