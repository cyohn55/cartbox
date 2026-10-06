/**
 * The standalone runtime (ENGINE_PARITY_ROADMAP.md EP18): what an exported
 * game's page runs. Bundled with the player into one ES module by
 * apps/web/scripts/build-standalone.mjs; the page (see standaloneExport.ts)
 * imports it from a blob URL and calls {@link boot} with the game's data.
 *
 * It does what the site's player page does, from inline data instead of the
 * network: the engine core from its embedded glue and WebAssembly, the
 * sidecars validated as on the site, physics and the KTX2 transcoder from
 * their embedded modules (when the export has them), and saves kept in this
 * browser.
 */

import { base64ToBytes } from "@cartbox/editor";
import {
  mount,
  parseAnim,
  parseCollisionField,
  parseFlagsField,
  parseMeshScene,
  parseParticles,
  parsePostFxSettings,
  parseScene,
  parseWorldScene,
  readSidecarActions,
  readSidecarUi,
  type ModelId,
  type PhysicsBackend,
  type PlayerHandle,
} from "@cartbox/player";

import { browserStorage, openSaves } from "../lib/saveData";
import type { StandaloneData } from "../lib/standaloneExport";

type Ktx2Decode = Awaited<ReturnType<NonNullable<Parameters<typeof mount>[1]["ktx2"]>>>;

/** An ES module from its source, by blob URL. */
async function importSource<T>(source: string): Promise<T> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ /* webpackIgnore: true */ url)) as T;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Boot the game into `stage`; `status` shows loading and errors (hidden once it plays). */
export async function boot(game: StandaloneData, stage: HTMLElement, status?: HTMLElement | null): Promise<PlayerHandle> {
  if (game.version !== 1) throw new Error("This export needs a newer player.");
  const say = (text: string) => {
    if (status) {
      status.textContent = text;
      status.hidden = text === "";
    }
  };
  const cart = base64ToBytes(game.cart);
  const cartUrl = URL.createObjectURL(new Blob([cart.buffer as ArrayBuffer], { type: "application/octet-stream" }));
  const engineUrl = URL.createObjectURL(new Blob([game.engine.js], { type: "text/javascript" }));
  const mesh = parseMeshScene(game.mesh);
  const ui = readSidecarUi(game.mesh);
  const actions = readSidecarActions(game.mesh);
  const saves = await openSaves({ cartId: game.cartId, cloud: false, storage: browserStorage() });
  const physicsSource = game.physics;
  const ktx2Source = game.ktx2;
  addEventListener("pagehide", () => void saves.flush());

  say("Loading…");
  const handle = mount(stage, {
    cartUrl,
    engineUrl,
    engineWasm: base64ToBytes(game.engine.wasm),
    modelId: game.modelId as ModelId,
    controls: "auto",
    scale: "fit",
    lighting: { autoDetect: true },
    postFx: parsePostFxSettings(game.postFx) ?? undefined,
    scene: parseScene(game.scene) ?? undefined,
    anim: parseAnim(game.anim) ?? undefined,
    particles: parseParticles(game.particles) ?? undefined,
    collision: parseCollisionField(game.collision) ?? undefined,
    flags: parseFlagsField(game.flags) ?? undefined,
    mesh: mesh ?? undefined,
    world: parseWorldScene(game.world) ?? undefined,
    ...(ui.length > 0 ? { ui } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    saveData: saves.data,
    onSave: saves.onSave,
    ...(physicsSource
      ? { physics: async () => (await importSource<{ backend: () => Promise<PhysicsBackend> }>(physicsSource)).backend() }
      : {}),
    ...(ktx2Source ? { ktx2: async () => (await importSource<{ decoder: () => Promise<Ktx2Decode> }>(ktx2Source)).decoder() } : {}),
    onReady: () => {
      // Browsers only let sound start from a gesture: the first click, tap or key starts the game.
      say("Click, tap or press a key to play");
      const start = () => {
        removeEventListener("pointerdown", start);
        removeEventListener("keydown", start);
        say("");
        void handle.resume();
      };
      addEventListener("pointerdown", start);
      addEventListener("keydown", start);
    },
    onError: (error) => say(`This game could not start: ${error.message}`),
  });
  return handle;
}
