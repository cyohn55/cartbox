"use client";

/**
 * Client component that mounts @cartbox/player for one cartridge, exposes
 * play/pause, captures the best score the cart emits, and submits the score with
 * its replay for server-side verification (which also grants any achievements
 * the run produced). Kept as a leaf client component so the cart page can stay a
 * server component.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getModel,
  mount,
  parseMeshScene,
  readSidecarUi,
  readSidecarActions,
  parseWorldScene,
  serializeReplay,
  type MailboxEvent,
  type ModelId,
  type PlayerHandle,
  type PostFxSettings,
  type SceneSpec,
  type AnimSpec,
  type ParticleSpec,
  type CollisionField,
  type FlagsField,
} from "@cartbox/player";

import { authHeaders, getAccessToken } from "@/lib/supabase-browser";
import { browserStorage, openSaves, type SaveKeeper } from "@/lib/saveData";
import { isStaticExport } from "@/lib/staticSite";
import { loadKtx2Decoder } from "@/lib/ktx2Decoder";
import { rapierPhysics } from "@/lib/physicsRapier";
import { streamTextures, type StreamedTexture } from "@/lib/textureStream";
import type { EncodedImage } from "@cartbox/editor";

interface CartridgePlayerProps {
  cartId: string;
  cartUrl: string;
  engineUrl: string;
  modelId: ModelId;
  /** The cart's authored post-processing stack, or null when none is saved. */
  postFx: PostFxSettings | null;
  /** The cart's authored parallax-scene backdrop, or null when none is saved. */
  scene: SceneSpec | null;
  /** The cart's authored animation timeline, or null when none is saved. */
  anim: AnimSpec | null;
  /** The cart's authored weather/particle system, or null when none is saved. */
  particles: ParticleSpec | null;
  /** The cart's authored collision layer, or null when none is saved. */
  collision: CollisionField | null;
  /** The cart's authored tile-flags layer, or null when none is saved. */
  flags: FlagsField | null;
  /**
   * The cart's raw mesh sidecar JSON, or null when none is saved. Parsed on the
   * client (its geometry decodes into typed arrays that can't cross the RSC
   * server→client boundary the plain-object sidecars use).
   */
  meshRaw: string | null;
  /** The cart's raw HD-2D world sidecar JSON, or null when none is saved. */
  worldRaw: string | null;
  /**
   * The scene's textures kept in the cart asset store, streamed in after the
   * cart starts (the scene itself carries only their placeholders).
   */
  meshTextures?: readonly StreamedTexture[];
}

type SubmitState = "idle" | "working" | "submitted" | "error";

export function CartridgePlayer({ cartId, cartUrl, engineUrl, modelId, postFx, scene, anim, particles, collision, flags, meshRaw, worldRaw, meshTextures }: CartridgePlayerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  // Decode the mesh sidecar once per cart: parsing deserialises geometry, so it
  // must not rerun on every render (and a malformed payload yields null → no meshes).
  const mesh = useMemo(() => parseMeshScene(meshRaw), [meshRaw]);
  // Its UI documents (EP13), from the same sidecar.
  const ui = useMemo(() => readSidecarUi(meshRaw), [meshRaw]);
  const actions = useMemo(() => readSidecarActions(meshRaw), [meshRaw]);
  // Save data (EP15b): this browser's and, signed in, the account's — loaded
  // before the cart starts, so cartbox.load has it from the first tick.
  const [saves, setSaves] = useState<SaveKeeper | null>(null);
  useEffect(() => {
    let live = true;
    let keeper: SaveKeeper | null = null;
    void (async () => {
      const token = isStaticExport ? null : await getAccessToken().catch(() => null);
      keeper = await openSaves({
        cartId,
        cloud: Boolean(token),
        storage: browserStorage(),
        request: async (url, init) => fetch(url, { ...init, headers: await authHeaders(init?.headers ?? {}) }),
      });
      if (live) setSaves(keeper);
    })();
    return () => {
      live = false;
      void keeper?.flush();
    };
  }, [cartId]);
  // The HD-2D world sidecar, parsed once per cart (malformed → null → no world).
  const world = useMemo(() => parseWorldScene(worldRaw), [worldRaw]);
  const handleRef = useRef<PlayerHandle | null>(null);
  const bestScoreRef = useRef<number | null>(null);
  const unlockedRef = useRef(false);

  // Size the display box to the cart's own model so a Pro cart (640x360) isn't
  // letterboxed into Classic's 240x136 aspect.
  const model = getModel(modelId);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [hasUnlocks, setHasUnlocks] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  // Streamed textures: bytes arrived of the total, until they're all in.
  const [textureProgress, setTextureProgress] = useState<{ loaded: number; total: number } | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    // Textures stream in once the cart is running; ones that land before the
    // scene is up wait here and are handed over together when it is.
    const pendingTextures = new Map<string, EncodedImage>();
    let sceneReady = false;
    const flushTextures = () => {
      if (!sceneReady || pendingTextures.size === 0) return;
      void handleRef.current?.supplyTextures(new Map(pendingTextures));
      pendingTextures.clear();
    };
    const streaming = new AbortController();
    // Each texture is fetched once: at start if the start level (or something
    // always loaded) needs it, else when a level that needs it is switched to.
    const fetched = new Set<string>();
    const stream = (list: readonly StreamedTexture[], onProgress: (loaded: number, total: number) => void) => {
      const todo = list.filter((t) => !fetched.has(t.hash));
      for (const t of todo) fetched.add(t.hash);
      return streamTextures(todo, {
        signal: streaming.signal,
        onProgress,
        onTexture: (hash, image) => {
          pendingTextures.set(hash, image);
          flushTextures();
        },
      });
    };

    if (!saves) return;
    const handle = mount(stage, {
      cartUrl,
      engineUrl,
      modelId,
      controls: "auto",
      scale: "fit",
      // Relight carts that emit lights via cartbox.light(); autoDetect leaves
      // every other cart looking exactly as before.
      lighting: { autoDetect: true },
      // The cart's authored FX stack (fog/bloom/CRT/…), saved from the editor.
      postFx: postFx ?? undefined,
      // The cart's authored parallax backdrop, composited behind the live
      // foreground via chroma-key before lighting/post-FX.
      scene: scene ?? undefined,
      // The cart's authored animation, played host-side off the frame clock
      // (drives scene layers, post-FX values, and foreground placements).
      anim: anim ?? undefined,
      // The cart's authored weather system (rain/snow/embers/fog), composited
      // over each frame in front of the scene and under the post-FX finish.
      particles: particles ?? undefined,
      // The cart's authored collision layer, injected as cart data so the cart's
      // own Lua can read it via cartbox.solid(x, y) / cartbox.mapsize().
      collision: collision ?? undefined,
      // The cart's authored tile-flags layer, read via cartbox.flag(x, y, n).
      flags: flags ?? undefined,
      // The cart's authored 3D mesh scene, rasterised over each frame by the
      // player's software rasteriser (Phase 2 of the mesh asset feature).
      mesh: mesh ?? undefined,
      ...(ui.length > 0 ? { ui } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      saveData: saves.data,
      onSave: saves.onSave,
      // Physics bodies on those meshes, simulated by Rapier (fetched only when a
      // cart actually has bodies).
      physics: rapierPhysics(),
      // KTX2 textures: the transcoder is fetched only if the scene has one.
      ktx2: loadKtx2Decoder,
      // A level's textures load when code switches to it (cartbox.level).
      levelAssets: (level, onProgress) => {
        const list = (meshTextures ?? []).filter((t) => t.levels?.includes(level.id));
        if (list.length === 0) return Promise.resolve();
        setTextureProgress({ loaded: 0, total: 1 });
        return stream(list, (loaded, total) => {
          onProgress(total > 0 ? loaded / total : 1);
          setTextureProgress({ loaded, total: Math.max(1, total) });
        }).then(() => {
          if (!streaming.signal.aborted) setTextureProgress(null);
        });
      },
      // Spatial loading: an object's textures load as the focus nears it.
      streamAssets: (objectIds) => {
        const list = (meshTextures ?? []).filter((t) => t.objects?.some((id) => objectIds.includes(id)));
        if (list.length > 0) void stream(list, () => {});
      },
      // The cart's authored HD-2D world: 3D terrain with the cart's 2D character
      // sprites composited into it as depth-sorted billboards.
      world: world ?? undefined,
      onReady: () => {
        setStatus("ready");
        sceneReady = true;
        flushTextures();
      },
      onError: () => setStatus("error"),
      onEvent: (event: MailboxEvent) => {
        if (event.kind === "score" && event.value > (bestScoreRef.current ?? -1)) {
          bestScoreRef.current = event.value;
          setBestScore(event.value);
        } else if (event.kind === "achievement") {
          unlockedRef.current = true;
          setHasUnlocks(true);
        }
      },
    });
    handleRef.current = handle;

    const atStart = (meshTextures ?? []).filter((t) => !t.levels && !t.objects);
    if (mesh && atStart.length > 0) {
      setTextureProgress({ loaded: 0, total: 1 });
      void stream(atStart, (loaded, total) => setTextureProgress({ loaded, total: Math.max(1, total) })).then(() => {
        if (!streaming.signal.aborted) setTextureProgress(null);
      });
    }

    return () => {
      streaming.abort();
      handle.destroy();
    };
  }, [cartUrl, engineUrl, modelId, postFx, scene, anim, particles, collision, flags, mesh, ui, actions, saves, world, meshTextures]);

  const togglePlayback = () => {
    const handle = handleRef.current;
    if (!handle) {
      return;
    }
    if (handle.running) {
      handle.pause();
      setRunning(false);
    } else {
      handle.resume();
      setRunning(true);
    }
  };

  /** Persists the current replay (optionally queuing unlock verification). */
  const persistReplay = async (verify: boolean): Promise<string | null> => {
    const replay = handleRef.current?.getReplay();
    if (!replay || replay.frameCount === 0) {
      return null;
    }
    const response = await fetch("/api/replays", {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ cartId, replay: serializeReplay(replay), verify }),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { id?: string };
    return body.id ?? null;
  };

  /** Saves the run: submits the score if any, and queues unlock verification. */
  const submit = async () => {
    const score = bestScoreRef.current;
    if (score === null && !unlockedRef.current) {
      return;
    }
    setSubmitState("working");
    try {
      const replayId = await persistReplay(unlockedRef.current);
      if (!replayId) {
        throw new Error("replay save failed");
      }
      if (score !== null) {
        const response = await fetch("/api/scores", {
          method: "POST",
          headers: await authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ cartId, replayId, value: score }),
        });
        setSubmitState(response.ok ? "submitted" : "error");
      } else {
        setSubmitState("submitted"); // unlock-only run
      }
    } catch {
      setSubmitState("error");
    }
  };

  return (
    <div>
      <div style={{ position: "relative" }}>
        <div ref={stageRef} style={{ width: "100%", aspectRatio: `${model.width} / ${model.height}`, background: "#0c0a14" }} />
        {textureProgress && (
          <div
            role="progressbar"
            aria-label="Loading textures"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((textureProgress.loaded / textureProgress.total) * 100)}
            style={{ position: "absolute", left: 8, right: 8, bottom: 8, pointerEvents: "none", fontSize: 12, color: "#cbd5e1", textShadow: "0 1px 2px #000" }}
          >
            <div>
              Loading textures · {(textureProgress.loaded / 1048576).toFixed(1)} / {(textureProgress.total / 1048576).toFixed(1)} MB
            </div>
            <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", marginTop: 4 }}>
              <div style={{ height: 4, borderRadius: 2, width: `${(textureProgress.loaded / textureProgress.total) * 100}%`, background: "#8b93ff" }} />
            </div>
          </div>
        )}
      </div>
      <div>
        <button type="button" onClick={togglePlayback} disabled={status !== "ready"}>
          {running ? "⏸ Pause" : "▶ Play"}
        </button>
        {/* Score/replay verification needs the community server, which the
            static demo build doesn't have — best scores stay session-local. */}
        {!isStaticExport && (
          <button
            type="button"
            onClick={submit}
            disabled={status !== "ready" || (bestScore === null && !hasUnlocks) || submitState === "working"}
          >
            {submitState === "submitted"
              ? "✓ Submitted"
              : bestScore !== null
                ? `🏆 Submit score (${bestScore})`
                : hasUnlocks
                  ? "🏆 Submit run"
                  : "🏆 Submit"}
          </button>
        )}
      </div>
      {bestScore !== null && <p>Best score this session: {bestScore}</p>}
      {status === "loading" && <p>Loading cartridge…</p>}
      {status === "error" && <p role="alert">This cartridge failed to load.</p>}
      {submitState === "submitted" && (
        <p>Submitted for verification — it’ll appear on the leaderboard once confirmed.</p>
      )}
      {submitState === "error" && <p role="alert">Could not submit your score.</p>}
    </div>
  );
}
