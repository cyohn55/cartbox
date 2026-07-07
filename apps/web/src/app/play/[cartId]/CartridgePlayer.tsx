"use client";

/**
 * Client component that mounts @cartbox/player for one cartridge, exposes
 * play/pause, captures the best score the cart emits, and submits the score with
 * its replay for server-side verification (which also grants any achievements
 * the run produced). Kept as a leaf client component so the cart page can stay a
 * server component.
 */

import { useEffect, useRef, useState } from "react";
import {
  getModel,
  mount,
  serializeReplay,
  type MailboxEvent,
  type ModelId,
  type PlayerHandle,
  type PostFxSettings,
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
}

type SubmitState = "idle" | "working" | "submitted" | "error";

export function CartridgePlayer({ cartId, cartUrl, engineUrl, modelId, postFx }: CartridgePlayerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
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
  }, [cartUrl, engineUrl, modelId, postFx]);

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
