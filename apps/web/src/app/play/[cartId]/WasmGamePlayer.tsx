"use client";

/**
 * Client leaf that runs a `wasm-app` title.
 *
 * Loads the game's Emscripten module, drives it in a rAF loop, paints each frame
 * to a canvas, and saves to local storage. Everything game-specific lives behind
 * the Cartbox Game ABI (games/README.md), so this component is identical for
 * every ported title.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { ButtonState, buttonForKey, isBoundKey } from "@/lib/gameInput";
import { InMemorySaveStore, OpfsSaveStore, type SaveStore } from "@/lib/gameSaves";
import {
  GameSession,
  clampDelta,
  paintFrame,
  type GameModuleFactory,
} from "@/lib/wasmGameRuntime";

interface WasmGamePlayerProps {
  titleId: string;
  /** Directory under public/games holding game.js + game.wasm. */
  bundleName: string;
  width: number;
  height: number;
}

type Status = "loading" | "ready" | "error";

/**
 * Loads the Emscripten glue as a module at runtime.
 *
 * The glue is a build artefact rather than a source import, so it is fetched
 * dynamically — this also keeps a multi-megabyte game out of the app bundle for
 * players who never open it.
 */
async function loadGameFactory(bundleName: string): Promise<GameModuleFactory> {
  const scriptUrl = withBasePath(`/games/${bundleName}/game.js`);
  const imported = (await import(/* webpackIgnore: true */ scriptUrl)) as {
    default: GameModuleFactory;
  };
  return imported.default;
}

export function WasmGamePlayer({ titleId, bundleName, width, height }: WasmGamePlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const buttonsRef = useRef(new ButtonState());
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const storeRef = useRef<SaveStore | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [running, setRunning] = useState(false);

  // OPFS is absent in some browsers and private modes; saves then live only for
  // the session rather than the game refusing to run.
  if (storeRef.current === null && typeof navigator !== "undefined") {
    const hasOpfs = typeof navigator.storage?.getDirectory === "function";
    storeRef.current = hasOpfs ? new OpfsSaveStore() : new InMemorySaveStore();
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const factory = await loadGameFactory(bundleName);
        const session = await GameSession.start(
          factory,
          { width, height },
          // The glue resolves game.wasm relative to itself, which breaks when the
          // site is served under a project path (GitHub Pages). Resolve it the
          // same way every other asset URL in the app is resolved.
          { locateFile: (file: string) => withBasePath(`/games/${bundleName}/${file}`) },
        );
        if (cancelled) {
          return;
        }
        sessionRef.current = session;
        setStatus("ready");

        // Paint one frame immediately so the canvas is not blank before play.
        session.tick(0);
        const context = canvasRef.current?.getContext("2d");
        if (context) {
          paintFrame(context, session.frame(), { width, height });
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "Could not load this game.");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      sessionRef.current = null;
    };
  }, [bundleName, height, width]);

  // Drive the loop only while running, so a paused game costs nothing.
  useEffect(() => {
    if (!running || status !== "ready") {
      return;
    }
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }

    lastTimeRef.current = performance.now();

    const step = (now: number) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      const delta = clampDelta((now - lastTimeRef.current) / 1000);
      lastTimeRef.current = now;

      session.setInput(buttonsRef.current.mask());
      session.tick(delta);
      paintFrame(context, session.frame(), { width, height });
      setScore(session.score());

      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [height, running, status, width]);

  // Keyboard input. Only bound keys are intercepted, so browser shortcuts and
  // assistive technology keep working.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const button = buttonForKey(event.code);
      if (!button) {
        return;
      }
      event.preventDefault();
      buttonsRef.current.press(button);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const button = buttonForKey(event.code);
      if (button) {
        if (isBoundKey(event.code)) {
          event.preventDefault();
        }
        buttonsRef.current.release(button);
      }
    };
    // A held key at the moment focus leaves would otherwise stick down forever.
    const onBlur = () => buttonsRef.current.releaseAll();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const onSave = useCallback(async () => {
    const session = sessionRef.current;
    const store = storeRef.current;
    if (!session || !store) {
      return;
    }
    const data = session.save();
    if (!data) {
      setMessage("This game has no save state.");
      return;
    }
    await store.write({ titleId, slot: 0 }, data);
    setMessage("Saved.");
  }, [titleId]);

  const onLoad = useCallback(async () => {
    const session = sessionRef.current;
    const store = storeRef.current;
    if (!session || !store) {
      return;
    }
    const record = await store.read({ titleId, slot: 0 });
    if (!record) {
      setMessage("No save found.");
      return;
    }
    // A refusal is expected when a save predates a game update, not an error.
    setMessage(session.load(record.data) ? "Loaded." : "That save is not compatible with this version.");
    setScore(session.score());
  }, [titleId]);

  return (
    <section>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: "100%", imageRendering: "pixelated", background: "#101018" }}
      />

      {status === "loading" && <p>Loading game…</p>}
      {status === "error" && <p role="alert">{message}</p>}

      {status === "ready" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={() => setRunning((value) => !value)}>
            {running ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={() => void onSave()}>
            Save
          </button>
          <button type="button" onClick={() => void onLoad()}>
            Load
          </button>
          <span>Score: {score}</span>
          {message && <span>{message}</span>}
        </div>
      )}
    </section>
  );
}
