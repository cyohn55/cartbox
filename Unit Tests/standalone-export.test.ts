/**
 * Standalone export (ENGINE_PARITY_ROADMAP.md EP18): a game as one HTML file
 * and as a zip for itch.io that installs as an offline app. Covers the zip
 * writer, what parts a game needs, the page (its data block can't be broken
 * out of, and boots), the manifest, service worker and icons, and — in a real
 * browser, opened straight from disk — an exported cart running and saving.
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCKOUT_FX, lockoutCartridge, lockoutMeshSidecar, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { codeChunks } from "@cartbox/player";

import {
  OFFLINE_FILES,
  scriptJson,
  standaloneData,
  standaloneFileName,
  standaloneHtml,
  standaloneIcon,
  standaloneManifest,
  standaloneNeeds,
  standaloneServiceWorker,
  standaloneZip,
  type StandaloneGame,
  type StandaloneParts,
} from "../apps/web/src/lib/standaloneExport";
import { zipFiles } from "../apps/web/src/lib/zip";

/** Read a zip's entries back (local headers), inflating as needed. */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    const body = Buffer.from(bytes.subarray(start, start + size));
    out.set(name, method === 8 ? inflateRawSync(body) : body);
    at = start + size;
  }
  return out;
}

const PARTS: StandaloneParts = {
  runtime: 'export async function boot() { document.title = "</script><!-- booted"; }',
  engine: { js: "export default async () => ({});", wasm: Uint8Array.from([0, 97, 115, 109]) },
  physics: "export const backend = 1;",
  ktx2: "export const decoder = 1;",
};

const GAME: StandaloneGame = {
  title: 'Tom & Jerry <"Chase">',
  cartId: "abc-123",
  modelId: "classic",
  cart: Uint8Array.from([5, 6, 7]),
  mesh: null,
};

describe("zip writer", () => {
  it("packs files that unzip to the same bytes, compressing what shrinks", () => {
    const text = new TextEncoder().encode("hello hello hello hello hello ".repeat(50));
    const noise = Uint8Array.from({ length: 300 }, (_, i) => (i * 7919) % 251);
    const zip = zipFiles([{ name: "a.txt", data: text }, { name: "dir/noise.bin", data: noise }], new Date(2026, 9, 6, 12, 30, 10));
    const files = unzip(zip);
    expect([...files.keys()]).toEqual(["a.txt", "dir/noise.bin"]);
    expect(Buffer.compare(files.get("a.txt")!, Buffer.from(text))).toBe(0);
    expect(Buffer.compare(files.get("dir/noise.bin")!, Buffer.from(noise))).toBe(0);
    expect(zip.length).toBeLessThan(text.length); // the text was deflated
    // The end record lists both entries.
    const end = new DataView(zip.buffer, zip.length - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(10, true)).toBe(2);
  });
});

describe("what an export carries", () => {
  it("physics only for scenes with bodies (the deterministic build when asked), the transcoder only for KTX2 textures", () => {
    expect(standaloneNeeds({ mesh: null })).toEqual({ physics: null, ktx2: false, direct: false });
    expect(standaloneNeeds({ mesh: '{"meshes":[{"physics":{"body":"dynamic"}}]}' })).toEqual({ physics: "regular", ktx2: false, direct: false });
    expect(standaloneNeeds({ mesh: '{"physicsWorld":{"deterministic":true},"m":[{"physics":{"body":"static"}}]}' }).physics).toBe("deterministic");
    expect(standaloneNeeds({ mesh: '{"img":{"mime":"image/ktx2"}}' }).ktx2).toBe(true);
    const data = standaloneData(GAME, PARTS);
    expect(data.physics).toBeNull();
    expect(data.ktx2).toBeNull();
    expect(data.cart).toBe("BQYH");
    expect(data.engine.wasm).toBe("AGFzbQ==");
  });

  it("names files from the title", () => {
    expect(standaloneFileName("  Neon City: Part 2! ")).toBe("neon-city-part-2");
    expect(standaloneFileName("★★★")).toBe("game");
  });
});

describe("the page", () => {
  it("keeps its data in one block nothing can close, and gives it back intact", () => {
    const html = standaloneHtml(GAME, PARTS);
    expect(html).toContain("<title>Tom &amp; Jerry &lt;&quot;Chase&quot;&gt;</title>");
    const block = html.match(/<script type="application\/json" id="cartbox-game">([\s\S]*?)<\/script>/)![1]!;
    expect(block).not.toContain("<");
    const { runtime, game } = JSON.parse(block);
    expect(runtime).toBe(PARTS.runtime);
    expect(game.title).toBe(GAME.title);
    expect(scriptJson("a\u2028b</script>")).toBe('"a\\u2028b\\u003c/script>"');
    // Only the offline page links the manifest and registers the worker.
    expect(html).not.toContain("manifest.webmanifest");
    expect(html).not.toContain("serviceWorker");
    const offline = standaloneHtml(GAME, PARTS, { offline: true });
    expect(offline).toContain('<link rel="manifest" href="manifest.webmanifest">');
    expect(offline).toContain('navigator.serviceWorker.register("sw.js")');
  });

  it("zips for itch.io: index.html, a manifest, icons and a service worker that caches every file", () => {
    const files = unzip(standaloneZip(GAME, PARTS));
    expect([...files.keys()]).toEqual(["index.html", "manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png"]);
    expect(files.get("index.html")!.toString()).toBe(standaloneHtml(GAME, PARTS, { offline: true }));
    const manifest = JSON.parse(files.get("manifest.webmanifest")!.toString());
    expect(manifest).toMatchObject({ name: GAME.title, start_url: "./index.html", display: "fullscreen" });
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
    const sw = files.get("sw.js")!.toString();
    for (const file of OFFLINE_FILES) expect(sw).toContain(JSON.stringify(file));
    expect(sw).toContain('"cartbox-abc-123-"');
    expect(standaloneServiceWorker(GAME, "v1")).not.toBe(standaloneServiceWorker(GAME, "v2"));
    // Real PNGs, the right size.
    for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512]] as const) {
      const png = files.get(name)!;
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    expect(standaloneIcon(48).length).toBeGreaterThan(50);
    expect(standaloneManifest({ title: "" }).includes('"name": "Game"')).toBe(true);
  });
});

describe("Lockout", () => {
  it("exports as one page: its cartridge, scene, effects and input actions inline, no physics engine needed", () => {
    const game: StandaloneGame = { title: "Lockout", cartId: "lockout", modelId: "xbox360", cart: lockoutCartridge(), postFx: LOCKOUT_FX, mesh: lockoutMeshSidecar() };
    expect(standaloneNeeds(game)).toEqual({ physics: null, ktx2: false, direct: false });
    const html = standaloneHtml(game, { ...PARTS, physics: null, ktx2: null });
    const { game: data } = JSON.parse(html.match(/id="cartbox-game">([\s\S]*?)<\/script>/)![1]!);
    expect(data.mesh).toBe(lockoutMeshSidecar());
    expect(data.modelId).toBe("xbox360");
    expect(data.postFx).toEqual(LOCKOUT_FX);
    expect(html.length).toBeLessThan(3_000_000);
  });
});

// ── In a real browser ────────────────────────────────────────────────────────

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
const ENGINE_DIST = path.resolve(__dirname, "../packages/engine/dist");
const canRun = Boolean(chromiumPath) && existsSync(path.join(ENGINE_DIST, "tic80.wasm"));

describe.skipIf(!canRun)("an exported game in a real browser", () => {
  let dir = "";
  let parts: (engine: "tic80" | "xbox360") => StandaloneParts;
  let browser: any = null;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cartbox-export-"));
    execFileSync("node", [path.resolve(__dirname, "../apps/web/scripts/build-standalone.mjs"), path.join(dir, "parts")]);
    const runtime = readFileSync(path.join(dir, "parts", "runtime.js"), "utf8");
    parts = (engine) => {
      const base = engine === "tic80" ? path.join(ENGINE_DIST, "tic80") : path.join(ENGINE_DIST, engine, "engine");
      return { runtime, engine: { js: readFileSync(`${base}.js`, "utf8"), wasm: new Uint8Array(readFileSync(`${base}.wasm`)) } };
    };
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("opens from disk, starts on a click, runs the cart and keeps its save in the browser", async () => {
    const code = `
t = 0
function TIC()
  cls(2)
  t = t + 1
  if t == 30 then cartbox.save({ frames = t, hello = "standalone" }) end
end`;
    const game: StandaloneGame = { title: "Export test", cartId: "export-test", modelId: "classic", cart: codeChunks(new TextEncoder().encode(code)) };
    const file = path.join(dir, "game.html");
    writeFileSync(file, standaloneHtml(game, parts("tic80")));
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("press a key"), null, { timeout: 30_000 });
    await page.mouse.click(10, 10);
    await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith("cartbox:save:play:export-test")), null, { timeout: 30_000 });
    const saved = await page.evaluate(() => localStorage.getItem("cartbox:save:play:export-test"));
    expect(saved).toContain("standalone");
    expect(await page.evaluate(() => document.getElementById("status")?.hidden)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("served from its zip, installs its service worker and then plays with the network gone", async () => {
    const code = "function TIC() cls(3) end";
    const game: StandaloneGame = { title: "Offline test", cartId: "offline-test", modelId: "classic", cart: codeChunks(new TextEncoder().encode(code)) };
    const files = unzip(standaloneZip(game, parts("tic80")));
    const types: Record<string, string> = { html: "text/html", webmanifest: "application/manifest+json", js: "text/javascript", png: "image/png" };
    const server: Server = createServer((req, res) => {
      const name = (req.url ?? "/").split("?")[0]!.replace(/^\/+/, "") || "index.html";
      const body = files.get(name);
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": types[name.split(".").pop()!] ?? "application/octet-stream" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${port}/`);
      await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("press a key"), null, { timeout: 30_000 });
      // The worker has cached every file once it's active.
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      const manifest = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute("href"));
      expect(manifest).toBe("manifest.webmanifest");
      await context.setOffline(true);
      server.close();
      await page.reload();
      await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("press a key"), null, { timeout: 30_000 });
      const cached = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("cartbox-offline-test-")).length);
      expect(cached).toBe(1);
    } finally {
      await context.close();
      server.close();
    }
  }, 90_000);

  it("plays Lockout (the Modern core and its 3D scene) from one file", async () => {
    const game: StandaloneGame = { title: "Lockout", cartId: "lockout", modelId: "xbox360", cart: lockoutCartridge(), postFx: LOCKOUT_FX, mesh: lockoutMeshSidecar() };
    const file = path.join(dir, "lockout.html");
    writeFileSync(file, standaloneHtml(game, parts("xbox360")));
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("press a key"), null, { timeout: 60_000 });
    await page.mouse.click(10, 10);
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => document.getElementById("status")?.hidden)).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll("#game canvas").length)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  /** Open a page, start the game with a click, and wait for the cart's save under `cartId`. */
  async function playUntilSaved(file: string, cartId: string, act?: (page: any) => Promise<void>) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("press a key"), null, { timeout: 60_000 });
    await page.mouse.click(10, 300);
    if (act) await act(page);
    await page.waitForFunction((id: string) => localStorage.getItem(`cartbox:save:play:${id}`) !== null, cartId, { timeout: 60_000 });
    const saved = JSON.parse(JSON.parse(await page.evaluate((id: string) => localStorage.getItem(`cartbox:save:play:${id}`)!, cartId)).data);
    return { page, saved, errors };
  }

  it("carries the physics engine: a scene's crate falls and lands", async () => {
    // Two triangles spanning the whole unit cube, so each body's box is a full cube.
    const box = { name: "b", primitives: [{ positions: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5], normals: null, uvs: null, indices: [0, 1, 2, 0, 3, 1], material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
    const mesh = serializeMeshAsset({ ...box, primitives: box.primitives.map((p) => ({ ...p, positions: Float32Array.from(p.positions), indices: Uint32Array.from(p.indices) })) } as MeshAsset);
    const sidecar = JSON.stringify({
      version: 2,
      meshes: [
        { id: "floor", name: "floor", mesh, transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [30, 1, 30] }, physics: { body: "static", shape: "box" } },
        { id: "crate", name: "crate", mesh, transform: { position: [0, 6, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, physics: { body: "dynamic", shape: "box", mass: 1 } },
      ],
    });
    const code = `
t = 0
function TIC()
  cls(0)
  if cartbox.physics() then t = t + 1 end
  if t == 150 then local _, y = cartbox.body("crate") cartbox.save({ physics = true, y = math.floor(y * 100) }) end
end`;
    const game: StandaloneGame = { title: "Fall", cartId: "fall-test", modelId: "xbox360", cart: codeChunks(new TextEncoder().encode(code)), mesh: sidecar };
    expect(standaloneNeeds(game).physics).toBe("regular");
    const file = path.join(dir, "fall.html");
    writeFileSync(file, standaloneHtml(game, { ...parts("xbox360"), physics: readFileSync(path.join(dir, "parts", "physics.js"), "utf8") }));
    const { page, saved, errors } = await playUntilSaved(file, "fall-test");
    expect(saved.physics).toBe(true);
    expect(saved.y).toBeLessThan(150); // dropped from 6 m, resting on the floor (~0.5 m)
    expect(saved.y).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("carries the KTX2 transcoder: its module decodes a texture, and a scene using one plays", async () => {
    const ktx2 = readFileSync(path.join(dir, "parts", "ktx2.js"), "utf8");
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(dir, "fall.html")).href);
    // As a string, so the test runner leaves the page's dynamic import alone.
    await page.evaluate(`window.__ktx2 = ${JSON.stringify({ source: ktx2, bytes: Array.from(readFileSync(path.join(__dirname, "fixtures", "quad8-uastc.ktx2"))) })}`);
    const decoded = await page.evaluate(`(async () => {
      const { source, bytes } = window.__ktx2;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const mod = await import(url);
      const decode = await mod.decoder();
      const tex = decode(new Uint8Array(bytes));
      return tex ? { width: tex.width, height: tex.height, corner: Array.from(tex.data.slice(0, 4)), opposite: Array.from(tex.data.slice(-4)) } : null;
    })()`) as { width: number; height: number; corner: number[]; opposite: number[] } | null;
    await page.close();
    expect(decoded).not.toBeNull();
    expect([decoded!.width, decoded!.height]).toEqual([8, 8]);
    expect(decoded!.corner).not.toEqual(decoded!.opposite); // quadrants of different colours
    // A scene whose texture is KTX2: the export carries the transcoder and the game plays.
    const textured = JSON.stringify({ version: 2, meshes: [{ id: "q", name: "q", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, mesh: JSON.parse(serializeMeshAsset({ name: "q", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: Float32Array.from([0, 0, 1, 0, 0, 1]), indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: { mime: "image/ktx2", bytes: new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "quad8-uastc.ktx2"))) } } }] } as MeshAsset)) }] });
    const code = `t = 0 function TIC() t = t + 1 if t == 30 then cartbox.save({ ok = true }) end end`;
    const game: StandaloneGame = { title: "Tex", cartId: "ktx2-test", modelId: "xbox360", cart: codeChunks(new TextEncoder().encode(code)), mesh: textured };
    expect(standaloneNeeds(game).ktx2).toBe(true);
    const file = path.join(dir, "tex.html");
    writeFileSync(file, standaloneHtml(game, { ...parts("xbox360"), ktx2 }));
    const run = await playUntilSaved(file, "ktx2-test");
    expect(run.saved.ok).toBe(true);
    expect(run.errors).toEqual([]);
    await run.page.close();
  }, 120_000);

  it("runs a Modern scene on the dedicated core: the whole player around it, 6,000 placements in a tick", async () => {
    const box = { name: "b", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] } as MeshAsset;
    const sidecar = JSON.stringify({
      version: 2,
      core: "direct",
      meshes: [{ id: "a", name: "crate", mesh: serializeMeshAsset(box), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      timelines: [{ name: "t", duration: 1, tracks: [] }],
    });
    const code = `
t = 0
function TIC()
  cls(0)
  print("DIRECT", 10, 10, 12)
  t = t + 1
  if t == 20 then
    local ok = 0
    for i = 1, 6000 do if cartbox.place("crate", i, 0, 0, 0, 0, 0, 1) then ok = ok + 1 end end
    cartbox.save({ direct = _cbx_cmd ~= nil, placed = ok })
  end
end`;
    const game: StandaloneGame = { title: "Direct", cartId: "direct-test", modelId: "xbox360", cart: codeChunks(new TextEncoder().encode(code)), mesh: sidecar };
    expect(standaloneNeeds(game).direct).toBe(true);
    const core = path.resolve(__dirname, "../packages/modern-core/dist/modern-core");
    const file = path.join(dir, "direct.html");
    writeFileSync(file, standaloneHtml(game, { ...parts("xbox360"), engine: { js: readFileSync(`${core}.js`, "utf8"), wasm: new Uint8Array(readFileSync(`${core}.wasm`)) } }));
    const { page, saved, errors } = await playUntilSaved(file, "direct-test");
    expect(saved).toEqual({ direct: true, placed: 6000 });
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("has a Start menu: Esc pauses, and its settings apply to the running cart at once", async () => {
    const code = `
last = nil
function TIC()
  cls(1)
  local s = cartbox.textscale() .. "/" .. cartbox.colorfilter()
  if s ~= last then last = s cartbox.save({ seen = s }) end
end`;
    const game: StandaloneGame = { title: "Menu test", cartId: "menu-test", modelId: "classic", cart: codeChunks(new TextEncoder().encode(code)) };
    const file = path.join(dir, "menu.html");
    writeFileSync(file, standaloneHtml(game, parts("tic80")));
    const { page, saved } = await playUntilSaved(file, "menu-test");
    expect(saved.seen).toBe("1/none");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"][aria-label="Paused"]:not([hidden])');
    await page.selectOption('select[aria-label="Text size"]', "2");
    await page.selectOption('select[aria-label="Colour filter"]', "protanopia");
    await page.click("text=Resume");
    await page.waitForFunction(() => localStorage.getItem("cartbox:save:play:menu-test")?.includes("2/protanopia"), null, { timeout: 30_000 });
    expect(await page.evaluate(() => document.getElementById("game")!.style.filter)).toMatch(/cbx-color-filter/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cartbox:accessibility")!))).toMatchObject({ textScale: 2, colorFilter: "protanopia" });
    expect(await page.isVisible('[role="dialog"][aria-label="Paused"]')).toBe(false);
    await page.close();
  }, 120_000);
});
