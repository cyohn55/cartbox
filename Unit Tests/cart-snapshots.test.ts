/**
 * Named snapshots of a cart (ENGINE_PARITY_ROADMAP.md EP19): names, the payload
 * codec (gzipped, re-validated on the way back), what a restore would change,
 * the upload rules the API enforces, both stores (this browser's, on a Map in
 * place of IndexedDB, and the account's, against a stand-in for the API), and
 * the migration's lock-down.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_FX } from "@cartbox/editor";
import { codeChunks } from "@cartbox/player";

import {
  MAX_SNAPSHOTS,
  decodeSnapshot,
  defaultSnapshotName,
  encodeSnapshot,
  packSnapshot,
  snapshotChanges,
  snapshotName,
  snapshotObjectKey,
  snapshotUploadError,
  sortSnapshots,
  unpackSnapshot,
  type SnapshotContent,
} from "../apps/web/src/lib/cartSnapshots";
import { SIDECARS, emptySidecars } from "../apps/web/src/lib/sidecars";
import { accountSnapshots, browserSnapshots, SnapshotError, type SnapshotKV, type StoredSnapshot } from "../apps/web/src/lib/snapshotStore";

/** A cart: code, plus a sprites chunk (type 2) holding `sprite`. */
function cart(code: string, sprite = 1): Uint8Array {
  const codeBytes = codeChunks(new TextEncoder().encode(code));
  const out = new Uint8Array(codeBytes.length + 4 + 32);
  out.set(codeBytes);
  out.set([2, 32, 0, 0], codeBytes.length);
  out.fill(sprite, codeBytes.length + 4);
  return out;
}

/** Lockout's effects stack as the registry stores it. */
const FX = SIDECARS.fx.parse(LOCKOUT_FX)!;

const BASE: SnapshotContent = {
  model: "classic",
  bytes: cart("function TIC() cls(0) end"),
  sidecars: emptySidecars(),
  meta: { title: "Robots", description: "", tags: ["arcade"] },
};

describe("names", () => {
  it("are one trimmed line of at most 80 characters, or nothing", () => {
    expect(snapshotName("  Before   the boss\nfight ")).toBe("Before the boss fight");
    expect(snapshotName("x".repeat(200))!.length).toBe(80);
    expect(snapshotName("   ")).toBeNull();
    expect(snapshotName(7)).toBeNull();
    expect(defaultSnapshotName(new Date(2026, 9, 6, 9, 5))).toBe("Snapshot 2026-10-06 09:05");
  });
});

describe("the payload", () => {
  it("round-trips through JSON and gzip, sidecars re-validated on the way back", async () => {
    const content: SnapshotContent = { ...BASE, sidecars: { ...emptySidecars(), fx: FX } };
    const back = decodeSnapshot(encodeSnapshot(content))!;
    expect(Array.from(back.bytes)).toEqual(Array.from(content.bytes));
    expect(back.meta).toEqual(content.meta);
    expect(back.sidecars.fx).toEqual(content.sidecars.fx);
    const packed = await packSnapshot(content);
    expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b]);
    const unpacked = (await unpackSnapshot(packed))!;
    expect(Array.from(unpacked.bytes)).toEqual(Array.from(content.bytes));
    // A damaged sidecar is dropped, not trusted.
    const tampered = JSON.parse(encodeSnapshot(content));
    tampered.sidecars.fx = { nonsense: true };
    tampered.sidecars.collision = "garbage";
    const read = decodeSnapshot(JSON.stringify(tampered))!;
    expect(read.sidecars.collision).toBeNull();
  });

  it("refuses what isn't a snapshot", async () => {
    expect(decodeSnapshot("not json")).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ version: 2, model: "classic", bytes: "" }))).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ version: 1, model: "classic" }))).toBeNull();
    expect(await unpackSnapshot(new TextEncoder().encode("plain text"))).toBeNull();
  });
});

describe("what a restore changes", () => {
  it("names each part of the cart, each layer and the details that differ", () => {
    expect(snapshotChanges(BASE, BASE)).toEqual([]);
    expect(snapshotChanges(BASE, { ...BASE, bytes: cart("function TIC() cls(5) end") })).toEqual(["code"]);
    expect(snapshotChanges(BASE, { ...BASE, bytes: cart("function TIC() cls(0) end", 9) })).toEqual(["sprites"]);
    expect(snapshotChanges(BASE, { ...BASE, sidecars: { ...emptySidecars(), fx: FX } })).toEqual(["effects"]);
    expect(snapshotChanges(BASE, { ...BASE, meta: { ...BASE.meta, title: "Robots 2" }, model: "pro" })).toEqual(["details", "console model"]);
  });
});

describe("the API's upload rules", () => {
  it("takes gzip within the size limit while the cart has room", async () => {
    const packed = await packSnapshot(BASE);
    expect(snapshotUploadError(packed, 0)).toBeNull();
    expect(snapshotUploadError(new TextEncoder().encode("x".repeat(40)), 0)?.status).toBe(400);
    expect(snapshotUploadError(packed, MAX_SNAPSHOTS)?.status).toBe(409);
    expect(snapshotObjectKey("c", "s")).toBe("snapshots/c/s.json.gz");
  });

  it("lists newest first", () => {
    const a = { id: "a", name: "A", createdAt: "2026-10-01T00:00:00Z", size: 1 };
    const b = { id: "b", name: "B", createdAt: "2026-10-05T00:00:00Z", size: 1 };
    expect(sortSnapshots([a, b]).map((s) => s.id)).toEqual(["b", "a"]);
  });
});

/** The browser seam on a Map. */
function memoryKV(): SnapshotKV & { records: Map<string, StoredSnapshot> } {
  const records = new Map<string, StoredSnapshot>();
  return {
    records,
    all: async (cartId) => [...records.values()].filter((r) => r.cartId === cartId),
    put: async (record) => void records.set(record.id, record),
    delete: async (id) => void records.delete(id),
  };
}

describe("this browser's snapshots", () => {
  it("take, list (newest first, this cart only), open and delete", async () => {
    const kv = memoryKV();
    let t = Date.parse("2026-10-06T10:00:00Z");
    const store = browserSnapshots("cart-1", kv, () => new Date((t += 60_000)));
    const other = browserSnapshots("cart-2", kv);
    const first = await store.take("  First  ", BASE);
    const second = await store.take("Second", { ...BASE, bytes: cart("function TIC() cls(7) end") });
    await other.take("Elsewhere", BASE);
    expect(first.name).toBe("First");
    expect((await store.list()).map((s) => s.name)).toEqual(["Second", "First"]);
    const opened = (await store.open(second.id))!;
    expect(snapshotChanges(BASE, opened)).toEqual(["code"]);
    await store.remove(first.id);
    expect((await store.list()).map((s) => s.id)).toEqual([second.id]);
    expect(await store.open("missing")).toBeNull();
  });

  it("stops at the limit, saying what to do", async () => {
    const kv = memoryKV();
    const store = browserSnapshots("c", kv);
    for (let i = 0; i < MAX_SNAPSHOTS; i += 1) kv.records.set(`r${i}`, { id: `r${i}`, cartId: "c", name: "x", createdAt: "2026-01-01T00:00:00Z", size: 1, payload: new Uint8Array() });
    await expect(store.take("one more", BASE)).rejects.toThrow(/delete an old one/);
  });
});

describe("the account's snapshots", () => {
  /** A stand-in for /api/carts/[cartId]/snapshots, keeping payloads as sent. */
  function fakeApi(signedIn = true) {
    const rows: { id: string; name: string; createdAt: string; size: number; payload: Uint8Array }[] = [];
    const calls: string[] = [];
    const request = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (!signedIn) return Response.json({ error: "Sign in to save snapshots." }, { status: 401 });
      const u = new URL(url, "http://x");
      const id = u.pathname.split("/snapshots")[1]?.replace(/^\//, "");
      if (!id && method === "GET") return Response.json({ snapshots: rows.map(({ payload: _payload, ...info }) => info) });
      if (!id && method === "POST") {
        const payload = new Uint8Array(init!.body as ArrayBuffer);
        const problem = snapshotUploadError(payload, rows.length);
        if (problem) return Response.json({ error: problem.message }, { status: problem.status });
        const row = { id: `s${rows.length + 1}`, name: u.searchParams.get("name")!, createdAt: `2026-10-06T10:0${rows.length}:00Z`, size: payload.length, payload };
        rows.push(row);
        const { payload: _payload, ...info } = row;
        return Response.json({ snapshot: info });
      }
      const row = rows.find((r) => r.id === id);
      if (!row) return Response.json({ error: "Snapshot not found." }, { status: 404 });
      if (method === "DELETE") {
        rows.splice(rows.indexOf(row), 1);
        return Response.json({ deleted: true });
      }
      return new Response(row.payload.buffer as ArrayBuffer);
    };
    return { request, rows, calls };
  }

  it("takes (gzipped, named in the query), lists, opens and deletes through the API", async () => {
    const api = fakeApi();
    const store = accountSnapshots("cart-9", api.request);
    expect(store.home).toBe("account");
    const info = await store.take("Before   boss", BASE);
    expect(api.calls[0]).toBe("POST /api/carts/cart-9/snapshots?name=Before%20boss");
    expect(info.name).toBe("Before boss");
    expect([api.rows[0]!.payload[0], api.rows[0]!.payload[1]]).toEqual([0x1f, 0x8b]);
    await store.take("Later", { ...BASE, meta: { ...BASE.meta, title: "Robots II" } });
    expect((await store.list()).map((s) => s.name)).toEqual(["Later", "Before boss"]);
    const opened = (await store.open("s2"))!;
    expect(opened.meta.title).toBe("Robots II");
    expect(await store.open("nope")).toBeNull();
    await store.remove("s1");
    expect(api.rows.map((r) => r.id)).toEqual(["s2"]);
  });

  it("reports the server's own reason (signed out is a 401 the editor falls back on)", async () => {
    const store = accountSnapshots("c", fakeApi(false).request);
    const error = await store.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).status).toBe(401);
    expect((error as SnapshotError).message).toBe("Sign in to save snapshots.");
  });
});

describe("the migration", () => {
  it("locks the table to the API: row-level security on, no policies", () => {
    for (const file of ["0029_cart_snapshots.sql", "apply-0029-to-prod.sql"]) {
      const sql = readFileSync(path.resolve(__dirname, "../supabase/migrations", file), "utf8");
      expect(sql).toContain("create table if not exists cart_snapshots");
      expect(sql).toContain("alter table cart_snapshots enable row level security;");
      expect(sql).not.toMatch(/create policy/i);
    }
  });
});

function findChromium(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const bin of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const file = path.join(root, dir, bin);
      if (existsSync(file)) return file;
    }
  }
  return null;
}
const chromiumPath = findChromium();

describe.skipIf(!chromiumPath)("this browser's snapshots on real IndexedDB", () => {
  it("survive a reload, per cart, and delete", async () => {
    const esbuild = await import("esbuild");
    const root = path.resolve(__dirname, "..");
    const bundle = await esbuild.build({
      stdin: {
        contents: `
          import { browserSnapshots, indexedDbSnapshots } from "./apps/web/src/lib/snapshotStore";
          import { emptySidecars } from "./apps/web/src/lib/sidecars";
          const content = (n) => ({ model: "classic", bytes: new Uint8Array([n, n, n]), sidecars: emptySidecars(), meta: { title: "T" + n, description: "", tags: [] } });
          window.take = async (cart, name, n) => (await browserSnapshots(cart, indexedDbSnapshots()).take(name, content(n))).id;
          window.list = async (cart) => (await browserSnapshots(cart, indexedDbSnapshots()).list()).map((s) => s.name);
          window.open = async (cart, id) => { const c = await browserSnapshots(cart, indexedDbSnapshots()).open(id); return c && [c.meta.title, Array.from(c.bytes)]; };
          window.remove = (cart, id) => browserSnapshots(cart, indexedDbSnapshots()).remove(id);
        `,
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      alias: { "@cartbox/editor": path.join(root, "packages/editor/src/index.ts"), "@cartbox/player": path.join(root, "packages/player/src/index.ts") },
      tsconfig: path.join(root, "apps/web/tsconfig.json"),
      logLevel: "silent",
    });
    const dir = mkdtempSync(path.join(tmpdir(), "cartbox-snapshots-"));
    const file = path.join(dir, "page.html");
    writeFileSync(file, `<!doctype html><script>${bundle.outputFiles[0]!.text.replace(/<\/script/g, "<\\/script")}</script>`);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: chromiumPath!, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(file).href);
      const a = await page.evaluate(() => (window as unknown as { take: (c: string, n: string, k: number) => Promise<string> }).take("cart-a", "First", 1));
      await page.evaluate(() => (window as unknown as { take: (c: string, n: string, k: number) => Promise<string> }).take("cart-b", "Other", 2));
      await page.reload();
      expect(await page.evaluate(() => (window as unknown as { list: (c: string) => Promise<string[]> }).list("cart-a"))).toEqual(["First"]);
      expect(await page.evaluate((id) => (window as unknown as { open: (c: string, i: string) => Promise<unknown> }).open("cart-a", id), a)).toEqual(["T1", [1, 1, 1]]);
      await page.evaluate((id) => (window as unknown as { remove: (c: string, i: string) => Promise<void> }).remove("cart-a", id), a);
      expect(await page.evaluate(() => (window as unknown as { list: (c: string) => Promise<string[]> }).list("cart-a"))).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { list: (c: string) => Promise<string[]> }).list("cart-b"))).toEqual(["Other"]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
