/**
 * Unit tests for the DOS boot page's IndexedDB guard and stage watchdogs.
 *
 * js-dos opens an IndexedDB cache and starts DOSBox from that request's
 * callbacks. It handles `onerror` by falling back to a no-op cache — which is
 * what makes the cache provably optional — but handles neither `onblocked` nor a
 * request that simply never answers, and a wedged profile produces exactly the
 * latter. The boot then stops before the engine exists with no error and no
 * canvas: an indefinite "LOADING GAME…" on every DOS title and no other runtime.
 *
 * These tests drive the real guard out of the shipped `cartbox-boot.html` rather
 * than a copy of it, so the file that is deployed is the file under test. The
 * page is plain ES5 in a <script> tag (it must run before js-dos.js, and it is
 * the only tracked file in a gitignored bundle directory), so the source is
 * extracted and evaluated instead of imported.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import runInNewContext from "node:vm";
import { describe, expect, it } from "vitest";

const BOOT_PAGE = fileURLToPath(
  new URL("../apps/web/public/dosbox/cartbox-boot.html", import.meta.url),
);

/** An IDBOpenDBRequest as the guard sees it: handlers assigned, events fired by us. */
interface FakeRequest {
  onerror: ((event: unknown) => void) | null;
  onsuccess: ((event: unknown) => void) | null;
  onupgradeneeded: ((event: unknown) => void) | null;
  onblocked: ((event: unknown) => void) | null;
  result: unknown;
}

/** The shim the guard hands back in place of the real request. */
interface GuardedRequest extends FakeRequest {}

type GuardFn = (
  factory: { open: (name: string, version?: number) => FakeRequest } | null | undefined,
  timeoutMs: number,
  setTimer?: (callback: () => void, ms: number) => void,
) => { open: (name: string, version?: number) => GuardedRequest };

/**
 * The page's `guardIndexedDbOpen`, evaluated from the real file.
 *
 * Reading the function out of the page keeps one implementation: a copy here
 * would pass forever while the deployed page regressed.
 */
function loadGuard(): GuardFn {
  const html = readFileSync(BOOT_PAGE, "utf8");
  const start = html.indexOf("function guardIndexedDbOpen");
  expect(start, "cartbox-boot.html must define guardIndexedDbOpen").toBeGreaterThan(-1);

  // Take the declaration through to the statement that follows it, which is the
  // page's own export assignment marker.
  const end = html.indexOf("// Guard the real factory", start);
  expect(end, "the guard must be followed by its install block").toBeGreaterThan(start);

  const source = `${html.slice(start, end)}; guardIndexedDbOpen;`;
  const sandbox = { window: { setTimeout: () => undefined } };
  return runInNewContext.runInNewContext(source, sandbox) as GuardFn;
}

/** A database request that behaves however the test tells it to. */
function fakeFactory(): {
  factory: { open: (name: string, version?: number) => FakeRequest };
  request: FakeRequest;
  opened: string[];
} {
  const request: FakeRequest = {
    onerror: null,
    onsuccess: null,
    onupgradeneeded: null,
    onblocked: null,
    result: { name: "real-db" },
  };
  const opened: string[] = [];
  return {
    request,
    opened,
    factory: {
      open(name: string) {
        opened.push(name);
        return request;
      },
    },
  };
}

/** Captures the guard's timer so a test can decide when the deadline expires. */
function manualTimer() {
  const pending: (() => void)[] = [];
  return {
    schedule: (callback: () => void) => {
      pending.push(callback);
    },
    fire: () => pending.forEach((callback) => callback()),
    count: () => pending.length,
  };
}

const guardIndexedDbOpen = loadGuard();

// The engine binary memo js-dos keeps in IndexedDB. The guard denies this one by
// name so the engine is always re-downloaded (and validated) over HTTP.
const ENGINE_CACHE_DB = "js-dos-cache (6.22.60 (c3627d34f97fcc6e98ceef7fbea6e090))";
// A game-save database: emscripten's IDBFS opens one per mount, keyed by path.
// These must still pass through the guard so saves keep working.
const SAVE_DB = "/home/web_user/.dosbox";

describe("guardIndexedDbOpen — a save database that misbehaves", () => {
  it("reports the failure js-dos handles when the open request stays silent", () => {
    const { factory } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const request = guarded.open(SAVE_DB, 1);
    const errors: unknown[] = [];
    request.onerror = (event) => errors.push(event);
    request.onsuccess = () => errors.push("unexpected success");

    // The real database never fires anything; only the deadline does.
    expect(errors).toHaveLength(0);
    timer.fire();

    expect(errors).toHaveLength(1);
    expect((errors[0] as { cartboxTimedOut?: boolean }).cartboxTimedOut).toBe(true);
  });

  it("does not fire the deadline once the database has answered", () => {
    const { factory, request } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const shim = guarded.open(SAVE_DB, 1);
    const events: string[] = [];
    shim.onsuccess = () => events.push("success");
    shim.onerror = () => events.push("error");

    request.onsuccess?.({});
    timer.fire();

    expect(events).toEqual(["success"]);
  });

  it("keeps waiting through onupgradeneeded, which precedes success", () => {
    const { factory, request } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const shim = guarded.open(SAVE_DB, 1);
    const events: string[] = [];
    shim.onupgradeneeded = () => events.push("upgrade");
    shim.onsuccess = () => events.push("success");
    shim.onerror = () => events.push("error");

    request.onupgradeneeded?.({});
    request.onsuccess?.({});
    timer.fire();

    expect(events).toEqual(["upgrade", "success"]);
  });

  it("turns a blocked open — which never completes — into the handled failure", () => {
    const { factory, request } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const shim = guarded.open(SAVE_DB, 1);
    const events: string[] = [];
    shim.onerror = () => events.push("error");

    request.onblocked?.({});
    timer.fire();

    expect(events).toEqual(["error"]);
  });

  it("passes a real failure straight through", () => {
    const { factory, request } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const shim = guarded.open(SAVE_DB, 1);
    const events: string[] = [];
    shim.onerror = () => events.push("error");

    request.onerror?.({});
    timer.fire();

    expect(events).toEqual(["error"]);
  });

  it("turns a synchronously thrown open — a storage-blocked iframe — into the handled failure", () => {
    // A sandboxed or storage-partitioned iframe (this DOS player runs in one)
    // makes IDBFactory.open() throw synchronously, e.g. a SecurityError. js-dos
    // does not guard the call, so an unswallowed throw would abort a save mount
    // with no fallback. The guard must absorb it and still surface the onerror.
    const thrown = new Error("access to the Indexed Database API is denied in this context");
    const factory = {
      open() {
        throw thrown;
      },
    };
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    // The throw must not escape open(): js-dos assigns handlers to the return value.
    let shim!: GuardedRequest;
    expect(() => {
      shim = guarded.open(SAVE_DB, 1);
    }).not.toThrow();

    const events: unknown[] = [];
    shim.onerror = (event) => events.push(event);
    shim.onsuccess = () => events.push("unexpected success");

    // The failure is deferred so it lands after js-dos has wired shim.onerror.
    expect(events).toHaveLength(0);
    timer.fire();

    expect(events).toHaveLength(1);
    expect((events[0] as { cartboxOpenThrew?: boolean }).cartboxOpenThrew).toBe(true);
    expect((events[0] as { error?: unknown }).error).toBe(thrown);
  });

  it("reads result as null when open threw, since there is no request to read from", () => {
    const factory = {
      open() {
        throw new Error("denied");
      },
    };
    const guarded = guardIndexedDbOpen(factory, 5000, manualTimer().schedule);

    const shim = guarded.open(SAVE_DB, 1);
    expect(shim.result).toBeNull();
  });

  it("exposes the real request's result, which js-dos reads to get the database", () => {
    const { factory, request } = fakeFactory();
    const guarded = guardIndexedDbOpen(factory, 5000, manualTimer().schedule);

    const shim = guarded.open(SAVE_DB, 1);
    expect(shim.result).toBe(request.result);
  });

  it("opens the underlying database rather than replacing it", () => {
    const { factory, opened } = fakeFactory();
    const guarded = guardIndexedDbOpen(factory, 5000, manualTimer().schedule);

    guarded.open(SAVE_DB, 1);
    expect(opened).toEqual([SAVE_DB]);
  });

  it("leaves a host without IndexedDB alone, so js-dos takes its no-op path", () => {
    expect(guardIndexedDbOpen(undefined, 5000)).toBeUndefined();
    expect(guardIndexedDbOpen(null, 5000)).toBeNull();
  });
});

describe("guardIndexedDbOpen — the engine binary cache is denied", () => {
  it("never opens the engine cache database, so a corrupt entry can't be read", () => {
    // js-dos feeds the cached engine bytes straight to WebAssembly.compile with
    // no length check; a truncated entry throws "expected 4 bytes, fell off end"
    // on every launch. Denying the database routes js-dos to its no-op cache and
    // a fresh, validated download — the real DB must never be touched.
    const { factory, opened } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const shim = guarded.open(ENGINE_CACHE_DB, 1);
    expect(opened).toEqual([]);

    const events: unknown[] = [];
    shim.onerror = (event) => events.push(event);
    shim.onsuccess = () => events.push("unexpected success");

    // Deferred, so js-dos has wired shim.onerror before it fires.
    expect(events).toHaveLength(0);
    timer.fire();

    expect(events).toHaveLength(1);
    expect((events[0] as { cartboxCacheBypassed?: boolean }).cartboxCacheBypassed).toBe(true);
  });

  it("reads result as null for the denied cache, since no database was opened", () => {
    const { factory } = fakeFactory();
    const guarded = guardIndexedDbOpen(factory, 5000, manualTimer().schedule);

    expect(guarded.open(ENGINE_CACHE_DB, 1).result).toBeNull();
  });

  it("denies the cache without even calling open, so a throwing factory is moot", () => {
    const factory = {
      open() {
        throw new Error("should not be called for the engine cache");
      },
    };
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    let shim!: GuardedRequest;
    expect(() => {
      shim = guarded.open(ENGINE_CACHE_DB, 1);
    }).not.toThrow();

    const events: unknown[] = [];
    shim.onerror = (event) => events.push(event);
    timer.fire();

    expect((events[0] as { cartboxCacheBypassed?: boolean }).cartboxCacheBypassed).toBe(true);
  });
});

describe("cartbox-boot.html — boot stages are bounded", () => {
  const html = readFileSync(BOOT_PAGE, "utf8");

  it("installs the guard before js-dos.js, which reads indexedDB as it loads", () => {
    expect(html.indexOf("guardIndexedDbOpen")).toBeLessThan(html.indexOf('src="js-dos.js"'));
  });

  it("watches both boot stages, so neither can hang without reporting", () => {
    expect(html).toContain('stageWatchdog("the DOSBox engine to start"');
    expect(html).toContain('stageWatchdog("the game files to download"');
  });

  it("gives the download far longer than engine start-up, since it is 13MB over the network", () => {
    const engine = Number(/ENGINE_STAGE_TIMEOUT_MS = (\d+)/.exec(html)?.[1]);
    const extract = Number(/EXTRACT_STAGE_TIMEOUT_MS = (\d+)/.exec(html)?.[1]);
    expect(engine).toBeGreaterThan(0);
    expect(extract).toBeGreaterThan(engine);
  });
});
