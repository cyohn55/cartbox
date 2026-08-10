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

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";

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
}

type SubmitState = "idle" | "working" | "submitted" | "error";

export function CartridgePlayer({ cartId, cartUrl, engineUrl, modelId, postFx, scene, anim, particles, collision, flags, meshRaw, worldRaw }: CartridgePlayerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  // Decode the mesh sidecar once per cart: parsing deserialises geometry, so it
  // must not rerun on every render (and a malformed payload yields null → no meshes).
  const mesh = useMemo(() => parseMeshScene(meshRaw), [meshRaw]);
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

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

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
      // The cart's authored HD-2D world: 3D terrain with the cart's 2D character
      // sprites composited into it as depth-sorted billboards.
      world: world ?? undefined,
      onReady: () => setStatus("ready"),
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

    return () => handle.destroy();
  }, [cartUrl, engineUrl, modelId, postFx, scene, anim, particles, collision, flags, mesh, world]);

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
      <div ref={stageRef} style={{ width: "100%", aspectRatio: `${model.width} / ${model.height}`, background: "#0c0a14" }} />
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
