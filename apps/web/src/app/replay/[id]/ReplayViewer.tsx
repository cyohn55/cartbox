"use client";

/**
 * Plays back a stored replay by mounting the player in playback mode. It fetches
 * the serialized replay from R2, parses it, and drives the console from the
 * recorded input stream (with RNG seeded from the replay), so the session
 * reproduces exactly.
 */

import { useEffect, useRef, useState } from "react";
import { mount, parseReplay, type ModelId, type PlayerHandle } from "@cartbox/player";

interface ReplayViewerProps {
  cartUrl: string;
  engineUrl: string;
  replayUrl: string;
  modelId: ModelId;
}

export function ReplayViewer({ cartUrl, engineUrl, replayUrl, modelId }: ReplayViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [nonce, setNonce] = useState(0); // bump to restart the replay

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    let handle: PlayerHandle | undefined;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(replayUrl, { signal: controller.signal });
        const replay = parseReplay(await response.text());
        handle = mount(stage, {
          cartUrl,
          engineUrl,
          modelId,
          replay,
          autostart: true,
          scale: "fit",
          onReady: () => setStatus("ready"),
          onError: () => setStatus("error"),
        });
        handleRef.current = handle;
      } catch {
        setStatus("error");
      }
    })();

    return () => {
      controller.abort();
      handle?.destroy();
    };
  }, [cartUrl, engineUrl, replayUrl, modelId, nonce]);

  return (
    <div>
      <div ref={stageRef} style={{ width: "100%", aspectRatio: "240 / 136", background: "#0c0a14" }} />
      <button
        type="button"
        onClick={() => {
          setStatus("loading");
          setNonce((n) => n + 1);
        }}
      >
        ↻ Replay again
      </button>
      {status === "loading" && <p>Loading replay…</p>}
      {status === "error" && <p role="alert">This replay could not be played.</p>}
    </div>
  );
}
