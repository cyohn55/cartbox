"use client";

/**
 * Playtest overlay: runs the current cart live using @cartbox/player. The editor
 * hands us the serialised .tic bytes; we wrap them in a blob: URL (the player
 * fetches cartUrl, and fetch supports blob:) so the exact in-memory cartridge
 * runs with no round-trip through storage. Stop tears the player down and
 * returns to editing.
 */

import { useEffect, useRef, useState } from "react";
import { mount, type PlayerHandle, type PostFxSettings } from "@cartbox/player";

import styles from "./editor.module.css";

interface RunOverlayProps {
  bytes: Uint8Array;
  engineUrl: string;
  cartName: string;
  /** The cart's post-processing stack, applied live during the playtest. */
  postFx?: PostFxSettings;
  onClose: () => void;
}

export function RunOverlay({ bytes, engineUrl, cartName, postFx, onClose }: RunOverlayProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(true);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    // saveTic() returns an exact-length buffer, so its ArrayBuffer is the cart
    // bytes verbatim. The cast sidesteps the DOM lib's SharedArrayBuffer union.
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const handle = mount(stage, {
      cartUrl: url,
      engineUrl,
      autostart: true,
      record: false,
      controls: "auto",
      scale: "fit",
      // Let creators playtest lit carts: autoDetect only lights carts that call
      // cartbox.light(), so unlit carts preview unchanged.
      lighting: { autoDetect: true },
      // Playtest with the cart's authored FX stack, exactly as players see it.
      postFx,
      onReady: () => setStatus("ready"),
      onError: () => setStatus("error"),
    });
    handleRef.current = handle;

    return () => {
      handle.destroy();
      URL.revokeObjectURL(url);
    };
  }, [bytes, engineUrl, postFx]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const togglePlayback = () => {
    const handle = handleRef.current;
    if (!handle) return;
    if (handle.running) {
      handle.pause();
      setRunning(false);
    } else {
      handle.resume();
      setRunning(true);
    }
  };

  return (
    <div className={styles.runOverlay} role="dialog" aria-modal="true" aria-label={`Playtest ${cartName}`}>
      <div className={styles.runCard}>
        <div className={styles.runBar}>
          <span className={styles.runDot} aria-hidden />
          <span className={styles.runTitle}>Playtest · {cartName}</span>
          <div className={styles.runBarActions}>
            <button type="button" className="cbx-btn" onClick={togglePlayback} disabled={status !== "ready"}>
              {running ? "Pause" : "Resume"}
            </button>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={onClose}>
              Stop
            </button>
          </div>
        </div>

        <div ref={stageRef} className={styles.runStage} />

        <p className={styles.runHint}>
          <span className="data">← ↑ ↓ →</span> move · <span className="data">Z</span> /{" "}
          <span className="data">X</span> action · <span className="data">Esc</span> to stop
          {status === "loading" && " · building cartridge…"}
          {status === "error" && " · this cartridge failed to run"}
        </p>
      </div>
    </div>
  );
}
