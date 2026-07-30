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

describe("guardIndexedDbOpen — a cache that never answers", () => {
  it("reports the failure js-dos handles when the open request stays silent", () => {
    const { factory } = fakeFactory();
    const timer = manualTimer();
    const guarded = guardIndexedDbOpen(factory, 5000, timer.schedule);

    const request = guarded.open("js-dos-cache (6.22)", 1);
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

    const shim = guarded.open("js-dos-cache (6.22)", 1);
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

    const shim = guarded.open("js-dos-cache (6.22)", 1);
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

    const shim = guarded.open("js-dos-cache (6.22)", 1);
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

    const shim = guarded.open("js-dos-cache (6.22)", 1);
    const events: string[] = [];
    shim.onerror = () => events.push("error");

    request.onerror?.({});
    timer.fire();

    expect(events).toEqual(["error"]);
  });

  it("exposes the real request's result, which js-dos reads to get the database", () => {
    const { factory, request } = fakeFactory();
    const guarded = guardIndexedDbOpen(factory, 5000, manualTimer().schedule);

    const shim = guarded.open("js-dos-cache (6.22)", 1);
    expect(shim.result).toBe(request.result);
  });

  it("opens the underlying database rather than replacing it", () => {
    const { factory, opened } = fakeFactory();
    const guarded = guardIndexedDbOpen(factory, 5000, manualTimer().schedule);

    guarded.open("js-dos-cache (6.22)", 1);
    expect(opened).toEqual(["js-dos-cache (6.22)"]);
  });

  it("leaves a host without IndexedDB alone, so js-dos takes its no-op path", () => {
    expect(guardIndexedDbOpen(undefined, 5000)).toBeUndefined();
    expect(guardIndexedDbOpen(null, 5000)).toBeNull();
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
