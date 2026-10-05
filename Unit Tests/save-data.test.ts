/**
 * Save data (ENGINE_PARITY_ROADMAP.md EP15b): a cart saves one Lua table with
 * cartbox.save and gets it back with cartbox.load. Covers the Lua (JSON both
 * ways, limits, erase) in real engines — Classic's small block and the Xbox
 * 360's — the host reading a save out of the block, the web storage (local,
 * the newer of local and cloud winning), and Lockout's career record.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, lockoutMeshSidecar } from "@cartbox/editor";
import {
  RAM_LAYOUTS,
  codeChunks,
  createConsole,
  getModel,
  injectSdk,
  saveBlockAddress,
  saveBlockBytes,
  saveCapacity,
  saveSdkLua,
  takeSave,
  validSave,
  type ModelId,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { inputBlockAddress } from "../packages/player/src/actionsSdk";
import { readSidecarUi, uiSdkLua } from "@cartbox/player";
import { MAX_SAVE_CHARS, newerSave, openSaves, parseCloudSaveBody, readLocalSave, saveKey, writeLocalSave } from "../apps/web/src/lib/saveData";

const DIST = path.resolve(__dirname, "../packages/engine/dist");

async function boot(model: ModelId, file: string, code: string, saved: string | null) {
  const layout = RAM_LAYOUTS[model];
  const prepared = injectSdk(prependLuaCode(codeChunks(new TextEncoder().encode(code)), saveSdkLua(layout, saved)));
  const mod = await (await import(pathToFileURL(path.join(DIST, file)).href)).default();
  const console = createConsole(mod, getModel(model), 44100);
  expect(console.loadCartridge(prepared)).toBe(true);
  const saves: (string | null)[] = [];
  const tick = () => {
    console.tick(0);
    const bytes = console.ramView(saveBlockAddress(layout) - layout.pmemAddress, saveBlockBytes(layout))!;
    const save = takeSave(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (save) saves.push(save.data);
  };
  return { console, tick, saves, words: () => console.netWords()! };
}

const CART = `
t = 0
function TIC()
  t = t + 1
  if t == 1 then
    local before = cartbox.load()
    pmem(0, before and before.level or -1)
    pmem(1, before and #before.items or -1)
    pmem(2, before and (before.name == "Ünïcode \\"q\\"\\n" and 1 or 0) or -1)
  elseif t == 2 then
    local ok = cartbox.save({ level = 7, items = { "sword", "key" }, name = "Ünïcode \\"q\\"\\n", best = 12.5, flags = { done = true, seen = false }, [3] = "three" })
    pmem(3, ok and 1 or 0)
    local back = cartbox.load()
    pmem(4, back.level * 10 + #back.items)
    pmem(5, back.flags.done and not back.flags.seen and back["3"] == "three" and math.floor(back.best * 10) or -1)
  elseif t == 3 then
    local ok, why = cartbox.save({ f = print })
    pmem(6, (not ok and why:find("function")) and 1 or 0)
    local big = {}
    for i = 1, 5000 do big[i] = i end
    local ok2, why2 = cartbox.save(big)
    pmem(7, (not ok2 and why2 == "too big") and 1 or 0)
  elseif t == 4 then
    cartbox.erase()
    pmem(8, cartbox.load() == nil and 1 or 0)
  end
end`;

describe.each([
  ["classic", "tic80.js"],
  ["xbox360", "xbox360/engine.js"],
] as [ModelId, string][])("cartbox.save in the real engine (%s)", (model, file) => {
  it.skipIf(!existsSync(path.join(DIST, file)))("loads the last save from the first tick, saves JSON the host reads, refuses what can't be saved, and erases", async () => {
    const layout = RAM_LAYOUTS[model];
    // Just below the input block, clear (on Classic) of TIC-80's gamepad map and system font.
    expect(saveBlockAddress(layout) + saveBlockBytes(layout)).toBe(inputBlockAddress(layout));
    if (model === "classic") expect(saveBlockAddress(layout)).toBeGreaterThanOrEqual(0x14e24);
    const previous = JSON.stringify({ level: 3, items: ["a", "b", "c"], name: 'Ünïcode "q"\n' });
    const e = await boot(model, file, CART, previous);
    for (let i = 0; i < 5; i += 1) e.tick();
    const w = e.words();
    expect([w[0], w[1], w[2]]).toEqual([3, 3, 1]);
    expect([w[3], w[4], w[5]]).toEqual([1, 72, 125]);
    expect([w[6], w[7], w[8]]).toEqual([1, 1, 1]);
    // The host saw the save, then the erase (the refused saves never reached it).
    expect(e.saves).toHaveLength(2);
    expect(JSON.parse(e.saves[0]!)).toEqual({ level: 7, items: ["sword", "key"], name: 'Ünïcode "q"\n', best: 12.5, flags: { done: true, seen: false }, "3": "three" });
    expect(e.saves[1]).toBeNull();
    expect(saveCapacity(layout)).toBe(model === "classic" ? 436 : 16372);
  });
});

describe("save checks", () => {
  it("only lets a JSON object or list through as a save", () => {
    expect(validSave('{"a":1}')).toBe('{"a":1}');
    expect(validSave("[1,2]")).toBe("[1,2]");
    expect(validSave("3")).toBeNull();
    expect(validSave("nope")).toBeNull();
    expect(validSave(null)).toBeNull();
  });

  it("starts a cart with a save holding ]] safely", async () => {
    if (!existsSync(path.join(DIST, "tic80.js"))) return;
    const e = await boot("classic", "tic80.js", `function TIC() pmem(0, #cartbox.load().s) end`, JSON.stringify({ s: "a]]b]=]c" }));
    e.tick();
    expect(e.words()[0]).toBe(8);
  });
});

/** A Storage stand-in. */
function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
}

describe("web storage", () => {
  const CART = "11111111-2222-3333-4444-555555555555";

  it("keeps a save per cart in the browser, the playtest's apart from players'", () => {
    const storage = memoryStorage();
    writeLocalSave(storage, saveKey(CART), '{"a":1}', "2026-01-01T00:00:00.000Z");
    expect(readLocalSave(storage, saveKey(CART))).toEqual({ data: '{"a":1}', updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(readLocalSave(storage, saveKey(CART, "playtest"))).toBeNull();
    storage.setItem(saveKey(CART), "garbage");
    expect(readLocalSave(storage, saveKey(CART))).toBeNull();
    writeLocalSave(storage, saveKey(CART), null, "2026-01-02T00:00:00.000Z");
    expect(storage.map.size).toBe(0);
  });

  it("starts from the newer of the browser's and the account's, keeps saves locally at once and in the account after a burst settles", async () => {
    const storage = memoryStorage();
    writeLocalSave(storage, saveKey(CART), '{"where":"local"}', "2026-01-01T00:00:00.000Z");
    const calls: { url: string; method: string; body?: string }[] = [];
    const request = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
      return new Response(JSON.stringify({ data: '{"where":"cloud"}', updatedAt: "2026-02-01T00:00:00.000Z" }));
    };
    const keeper = await openSaves({ cartId: CART, cloud: true, storage, request, now: () => Date.parse("2026-03-01T00:00:00.000Z"), settle: 10_000 });
    expect(keeper.data).toBe('{"where":"cloud"}');
    expect(readLocalSave(storage, saveKey(CART))!.data).toBe('{"where":"cloud"}'); // the browser catches up
    keeper.onSave('{"n":1}');
    keeper.onSave('{"n":2}');
    expect(keeper.data).toBe('{"n":2}');
    expect(readLocalSave(storage, saveKey(CART))).toEqual({ data: '{"n":2}', updatedAt: "2026-03-01T00:00:00.000Z" });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0); // still settling
    await keeper.flush();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1); // one write for the burst
    expect(JSON.parse(puts[0]!.body!)).toEqual({ data: '{"n":2}', updatedAt: "2026-03-01T00:00:00.000Z" });
    keeper.onSave(null);
    await keeper.flush();
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(readLocalSave(storage, saveKey(CART))).toBeNull();
  });

  it("uses the browser's copy when it's newer, or when signed out (never asking the account)", async () => {
    const storage = memoryStorage();
    writeLocalSave(storage, saveKey(CART), '{"where":"local"}', "2026-05-01T00:00:00.000Z");
    const request = async () => new Response(JSON.stringify({ data: '{"where":"cloud"}', updatedAt: "2026-02-01T00:00:00.000Z" }));
    expect((await openSaves({ cartId: CART, cloud: true, storage, request })).data).toBe('{"where":"local"}');
    let asked = false;
    const signedOut = await openSaves({ cartId: CART, cloud: false, storage, request: async () => ((asked = true), new Response("{}")) });
    expect(signedOut.data).toBe('{"where":"local"}');
    signedOut.onSave('{"x":1}');
    await signedOut.flush();
    expect(asked).toBe(false);
    expect(newerSave(null, null)).toBeNull();
  });

  it("checks what the route is sent: a JSON object or list within the cap, dated no later than shortly ahead", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(parseCloudSaveBody(JSON.stringify({ data: '{"a":1}', updatedAt: "2025-12-31T00:00:00.000Z" }), now)).toEqual({ data: '{"a":1}', updatedAt: "2025-12-31T00:00:00.000Z" });
    expect(parseCloudSaveBody(JSON.stringify({ data: '{"a":1}', updatedAt: "2030-01-01T00:00:00.000Z" }), now)!.updatedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(parseCloudSaveBody(JSON.stringify({ data: "3", updatedAt: "2025-01-01T00:00:00.000Z" }), now)).toBeNull();
    expect(parseCloudSaveBody(JSON.stringify({ data: `[${"1,".repeat(MAX_SAVE_CHARS)}1]`, updatedAt: "2025-01-01T00:00:00.000Z" }), now)).toBeNull();
    expect(parseCloudSaveBody(JSON.stringify({ data: '{"a":1}', updatedAt: "yesterday" }), now)).toBeNull();
    expect(parseCloudSaveBody("not json", now)).toBeNull();
  });
});

describe("Lockout", () => {
  it("keeps a career record", () => {
    expect(LOCKOUT_CODE).toContain("career = cartbox.load() or {}");
    expect(LOCKOUT_CODE).toContain("cartbox.save(career)");
  });

  it.skipIf(!existsSync(path.join(DIST, "xbox360/engine.js")))("loads the career, shows it on the title menu, and saves a finished match into it (real engine)", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const saved = JSON.stringify({ matches: 2, wins: 1, kills: 5, deaths: 3 });
    // A probe: what the menu shows, and at tick 60 (in a match) the match ending as a win with 4 kills.
    const probe = `
local _T = TIC
local n = 0
function TIC()
  _T()
  n = n + 1
  pmem(117, cartbox.ui.get("career") == "Career: 2 matches . 1 won . 5 kills . 3 deaths" and 1 or 0)
  if n == 60 and p then p.kills = 4; p.deaths = 1; record_match("YOU WIN"); pmem(118, 1) end
end`;
    let tic = codeChunks(new TextEncoder().encode(`${new TextDecoder().decode(lockoutCartCode())}\n${probe}`));
    tic = prependLuaCode(tic, saveSdkLua(layout, saved));
    tic = injectSdk(prependLuaCode(tic, uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
    const mod = await (await import(pathToFileURL(path.join(DIST, "xbox360/engine.js")).href)).default();
    const console = createConsole(mod, getModel("xbox360"), 44100);
    expect(console.loadCartridge(tic)).toBe(true);
    const saves: (string | null)[] = [];
    const tick = (buttons: number) => {
      console.tick(buttons);
      const bytes = console.ramView(saveBlockAddress(layout) - layout.pmemAddress, saveBlockBytes(layout))!;
      const save = takeSave(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (save) saves.push(save.data);
    };
    for (let i = 0; i < 3; i += 1) tick(0);
    expect(console.netWords()![117]).toBe(1); // the title menu's career line
    tick(1 << 4); // Free for All
    for (let i = 0; i < 60; i += 1) tick(0);
    expect(console.netWords()![118]).toBe(1);
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0]!)).toEqual({ matches: 3, wins: 2, kills: 9, deaths: 4 });
  });
});

/** Lockout's code alone (without the cartridge's palette chunk), to append a probe to. */
function lockoutCartCode(): Uint8Array {
  return new TextEncoder().encode(LOCKOUT_CODE);
}
