/**
 * Standalone export (ENGINE_PARITY_ROADMAP.md EP18): a game as files that play
 * anywhere, with no Cartbox server.
 *
 * - **One HTML file.** The page carries everything inline: the cartridge, the
 *   editor-made data (3D scene, world, effects…), the engine core for the cart's
 *   console model, the player (the standalone runtime, bundled by
 *   apps/web/scripts/build-standalone.mjs), and the physics engine or KTX2
 *   transcoder only when the scene needs them. Opened from disk or any web
 *   host, it plays.
 * - **A zip for itch.io** (and any static host): that page as index.html, plus
 *   a web app manifest, icons and a service worker — so, served over HTTPS, the
 *   game installs as an app and plays offline.
 *
 * The page's data rides in one JSON script block (every "<" escaped, so no
 * payload can close it); a few lines of inline script import the runtime from
 * a blob URL and boot it. Saves stay in the player's browser (localStorage).
 *
 * Pure apart from {@link fetchStandaloneParts}, which fetches the prebuilt parts.
 */

import { bytesToBase64, encodeRgbaPng, type ConsoleModelId } from "@cartbox/editor";

import { physicsNeeds } from "./downloadBudget";
import { zipFiles } from "./zip";

/** What the game is: the cartridge and the editor-made data the player reads. */
export interface StandaloneGame {
  readonly title: string;
  /** Names the game's saves in the player's browser. */
  readonly cartId: string;
  readonly modelId: ConsoleModelId;
  /** The .tic bytes. */
  readonly cart: Uint8Array;
  /** Sidecars as stored (each validated again when the game boots); null or absent when the cart has none. */
  readonly postFx?: unknown;
  readonly scene?: unknown;
  readonly anim?: unknown;
  readonly particles?: unknown;
  readonly collision?: unknown;
  readonly flags?: unknown;
  /** The encoded mesh sidecar, its textures inline. */
  readonly mesh?: string | null;
  /** The encoded HD-2D world sidecar. */
  readonly world?: string | null;
}

/** The prebuilt code an export carries. */
export interface StandaloneParts {
  /** The standalone runtime (an ES module exporting `boot`). */
  readonly runtime: string;
  /** The console model's engine core: its Emscripten glue and WebAssembly. */
  readonly engine: { readonly js: string; readonly wasm: Uint8Array };
  /** The physics engine module, when the scene has bodies. */
  readonly physics?: string | null;
  /** The KTX2 transcoder module, when the scene keeps KTX2 textures. */
  readonly ktx2?: string | null;
}

/** What the page hands the runtime's `boot`. */
export interface StandaloneData {
  readonly version: 1;
  readonly title: string;
  readonly cartId: string;
  readonly modelId: ConsoleModelId;
  /** Base64 .tic bytes. */
  readonly cart: string;
  readonly postFx: unknown;
  readonly scene: unknown;
  readonly anim: unknown;
  readonly particles: unknown;
  readonly collision: unknown;
  readonly flags: unknown;
  readonly mesh: string | null;
  readonly world: string | null;
  readonly engine: { readonly js: string; readonly wasm: string };
  readonly physics: string | null;
  readonly ktx2: string | null;
}

/** Which optional parts a game needs. */
export interface StandaloneNeeds {
  readonly physics: "regular" | "deterministic" | null;
  readonly ktx2: boolean;
}

export function standaloneNeeds(game: Pick<StandaloneGame, "mesh">): StandaloneNeeds {
  const mesh = game.mesh ?? null;
  const physics = physicsNeeds(mesh);
  return {
    physics: physics.bodies ? (physics.deterministic ? "deterministic" : "regular") : null,
    ktx2: Boolean(mesh?.includes('"mime":"image/ktx2"')),
  };
}

/** A file name from the game's title: lower case, dashes, never empty. */
export function standaloneFileName(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "game"
  );
}

export function standaloneData(game: StandaloneGame, parts: StandaloneParts): StandaloneData {
  const needs = standaloneNeeds(game);
  return {
    version: 1,
    title: game.title,
    cartId: game.cartId,
    modelId: game.modelId,
    cart: bytesToBase64(game.cart),
    postFx: game.postFx ?? null,
    scene: game.scene ?? null,
    anim: game.anim ?? null,
    particles: game.particles ?? null,
    collision: game.collision ?? null,
    flags: game.flags ?? null,
    mesh: game.mesh ?? null,
    world: game.world ?? null,
    engine: { js: parts.engine.js, wasm: bytesToBase64(parts.engine.wasm) },
    physics: needs.physics ? (parts.physics ?? null) : null,
    ktx2: needs.ktx2 ? (parts.ktx2 ?? null) : null,
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** JSON safe inside a <script> element: no "<" survives, so nothing in it can end the element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Page background (the player's own letterbox colour). */
const BACKGROUND = "#0c0a14";

/**
 * The game as one HTML page. `offline` links the web app manifest and
 * registers the service worker beside it (the zip's index.html).
 */
export function standaloneHtml(game: StandaloneGame, parts: StandaloneParts, options: { offline?: boolean } = {}): string {
  const payload = scriptJson({ runtime: parts.runtime, game: standaloneData(game, parts) });
  const offlineHead = options.offline
    ? `<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" href="icon-192.png">\n<link rel="apple-touch-icon" href="icon-192.png">\n`
    : "";
  const offlineScript = options.offline
    ? `if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${BACKGROUND}">
<meta name="generator" content="Cartbox">
<title>${escapeHtml(game.title || "Game")}</title>
${offlineHead}<style>
html, body { margin: 0; height: 100%; background: ${BACKGROUND}; color: #cbd5e1; font: 14px system-ui, sans-serif; overflow: hidden; }
#game { position: fixed; inset: 0; }
#status { position: fixed; left: 0; right: 0; bottom: 16px; margin: 0; text-align: center; pointer-events: none; }
</style>
</head>
<body>
<div id="game"></div>
<p id="status">Loading…</p>
<script type="application/json" id="cartbox-game">${payload}</script>
<script type="module">
const status = document.getElementById("status");
try {
  const { runtime, game } = JSON.parse(document.getElementById("cartbox-game").textContent);
  const url = URL.createObjectURL(new Blob([runtime], { type: "text/javascript" }));
  const { boot } = await import(url);
  await boot(game, document.getElementById("game"), status);
} catch (error) {
  status.textContent = "This game could not start: " + (error && error.message ? error.message : error);
}
${offlineScript}</script>
</body>
</html>
`;
}

/** The web app manifest: installable, full screen, with the export's icons. */
export function standaloneManifest(game: Pick<StandaloneGame, "title">): string {
  const name = game.title || "Game";
  return `${JSON.stringify(
    {
      name,
      short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
      start_url: "./index.html",
      scope: "./",
      display: "fullscreen",
      background_color: BACKGROUND,
      theme_color: BACKGROUND,
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
    null,
    2,
  )}\n`;
}

/** The files the service worker keeps for offline play. */
export const OFFLINE_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"] as const;

/**
 * The service worker: on install it stores every file of the export in a cache
 * named for this game and this build (`version`); it answers from that cache,
 * falling back to the network; on activation it drops the game's older caches
 * (and only its own: other games on the same host keep theirs).
 */
export function standaloneServiceWorker(game: Pick<StandaloneGame, "cartId">, version: string): string {
  const prefix = `cartbox-${standaloneFileName(game.cartId)}-`;
  return `// Offline play for a Cartbox export: every file is cached on install.
const PREFIX = ${JSON.stringify(prefix)};
const CACHE = PREFIX + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(OFFLINE_FILES)};
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(event.request, { ignoreSearch: true })).then((hit) => hit || fetch(event.request)));
});
`;
}

/**
 * The export's icon: a cartridge (rounded body, label, play mark) on the page
 * background, `size` pixels square, drawn inside the maskable safe zone.
 */
export function standaloneIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const bg = [0x0c, 0x0a, 0x14];
  const body = [0x8b, 0x93, 0xff];
  const label = [0x1e, 0x1b, 0x2e];
  const mark = [0xf8, 0xfa, 0xfc];
  const s = size / 100; // drawn on a 100-unit grid
  const inRounded = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / s;
      const y = (py + 0.5) / s;
      let c = bg;
      if (inRounded(x, y, 26, 22, 74, 78, 6)) {
        c = body;
        if (inRounded(x, y, 32, 30, 68, 58, 3)) {
          c = label;
          // A play triangle centred in the label.
          const tx = x - 44;
          const ty = y - 44;
          if (tx >= 0 && tx <= 14 && Math.abs(ty) <= 8 - (tx * 8) / 14) c = mark;
        }
        // Contact ridges along the bottom edge.
        if (y > 66 && y < 74 && x > 34 && x < 66 && Math.floor(x - 34) % 4 < 2) c = label;
      }
      const o = (py * size + px) * 4;
      rgba[o] = c[0]!;
      rgba[o + 1] = c[1]!;
      rgba[o + 2] = c[2]!;
      rgba[o + 3] = 255;
    }
  }
  return encodeRgbaPng(rgba, size, size, { compress: true });
}

/** A short content hash for cache names (FNV-1a over the page). */
function versionOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The zip for itch.io and static hosts: index.html, manifest, icons, service worker. */
export function standaloneZip(game: StandaloneGame, parts: StandaloneParts, date?: Date): Uint8Array {
  const encoder = new TextEncoder();
  const html = standaloneHtml(game, parts, { offline: true });
  return zipFiles(
    [
      { name: "index.html", data: encoder.encode(html) },
      { name: "manifest.webmanifest", data: encoder.encode(standaloneManifest(game)) },
      { name: "sw.js", data: encoder.encode(standaloneServiceWorker(game, versionOf(html))) },
      { name: "icon-192.png", data: standaloneIcon(192) },
      { name: "icon-512.png", data: standaloneIcon(512) },
    ],
    date,
  );
}

/** Where the prebuilt parts are served. */
export interface StandaloneSources {
  /** The model's engine glue URL (its .wasm sits beside it). */
  readonly engineUrl: string;
  /** The site's base path ("" at the root). */
  readonly basePath: string;
  readonly fetch?: typeof fetch;
}

/** Fetch the parts a game needs: the runtime, its engine core, and physics or the KTX2 transcoder if used. */
export async function fetchStandaloneParts(game: Pick<StandaloneGame, "mesh">, sources: StandaloneSources): Promise<StandaloneParts> {
  const get = sources.fetch ?? fetch;
  const needs = standaloneNeeds(game);
  const load = async (url: string) => {
    const res = await get(url);
    if (!res.ok) throw new Error(`Export could not fetch ${url} (${res.status})`);
    return res;
  };
  const text = async (url: string) => (await load(url)).text();
  const part = (name: string) => `${sources.basePath}/standalone/${name}`;
  const [runtime, js, wasm, physics, ktx2] = await Promise.all([
    text(part("runtime.js")),
    text(sources.engineUrl),
    load(sources.engineUrl.replace(/\.js(\?.*)?$/, ".wasm")).then(async (r) => new Uint8Array(await r.arrayBuffer())),
    needs.physics ? text(part(needs.physics === "deterministic" ? "physics-deterministic.js" : "physics.js")) : null,
    needs.ktx2 ? text(part("ktx2.js")) : null,
  ]);
  return { runtime, engine: { js, wasm }, physics, ktx2 };
}
