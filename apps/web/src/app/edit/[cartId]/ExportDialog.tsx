"use client";

/**
 * Export the game to play anywhere (ENGINE_PARITY_ROADMAP.md EP18): one HTML
 * file, or a zip for itch.io and other hosts that installs as an app and plays
 * offline. Opened from the top bar's File menu. See lib/standaloneExport.ts.
 */

import { useEffect, useRef, useState } from "react";

import { basePath } from "@/lib/staticSite";
import { fetchStandaloneParts, standaloneFileName, standaloneHtml, standaloneNeeds, standaloneZip, type StandaloneGame } from "@/lib/standaloneExport";
import { formatBytes } from "./assetUploads";
import styles from "./editor.module.css";

type Format = "html" | "zip";

/** Hand the browser a file to save. */
function saveFile(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportDialog({
  title,
  engineUrl,
  game,
  onClose,
}: {
  title: string;
  /** The cart's console model's engine glue URL. */
  engineUrl: string;
  /** The game as it stands in the editor (null when the engine can't save the cart). */
  game: () => Promise<StandaloneGame | null>;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "working"; format: Format } | { kind: "done"; name: string; bytes: number } | { kind: "error"; message: string }>({ kind: "idle" });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (format: Format) => {
    setState({ kind: "working", format });
    try {
      const current = await game();
      if (!current) throw new Error("The cart can't be saved right now (is the engine loaded?).");
      const parts = await fetchStandaloneParts(current, { engineUrl, basePath });
      const name = standaloneFileName(current.title);
      if (format === "html") {
        const html = standaloneHtml(current, parts);
        saveFile(`${name}.html`, html, "text/html");
        setState({ kind: "done", name: `${name}.html`, bytes: new Blob([html]).size });
      } else {
        // Zipping a large game takes a moment: let the "Exporting…" paint first.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const zip = standaloneZip(current, parts);
        saveFile(`${name}.zip`, zip.buffer as ArrayBuffer, "application/zip");
        setState({ kind: "done", name: `${name}.zip`, bytes: zip.length });
      }
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const [extras, setExtras] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void game().then((current) => {
      if (!live || !current) return;
      const needs = standaloneNeeds(current);
      const list = [needs.physics && (needs.physics === "deterministic" ? "the deterministic physics engine" : "the physics engine"), needs.ktx2 && "the KTX2 texture transcoder"].filter(Boolean);
      setExtras(list.length > 0 ? `It also carries ${list.join(" and ")}, which this game's scene uses.` : null);
    });
    return () => {
      live = false;
    };
  }, [game]);

  const busy = state.kind === "working";
  return (
    <div className={styles.helpOverlay} role="dialog" aria-modal="true" aria-label="Export game">
      <div className={styles.helpCard} style={{ maxWidth: 520 }}>
        <div className={styles.helpHead}>
          <h2 className={styles.helpTitle}>Export “{title || "Untitled"}”</h2>
          <button ref={closeRef} type="button" className="cbx-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ display: "grid", gap: 14, fontSize: 14 }}>
          <p style={{ margin: 0 }}>
            A copy of the game that plays without Cartbox: the cartridge, its scene and effects, and the engine, all in the download.
            {extras && ` ${extras}`} Saves stay in each player&apos;s browser.
          </p>
          <div style={{ display: "grid", gap: 4 }}>
            <button type="button" className="cbx-btn cbx-btn-accent" disabled={busy} onClick={() => void run("html")}>
              {busy && state.format === "html" ? "Exporting…" : "Download one HTML file"}
            </button>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Open it in any browser, from disk or a web host. Easiest to share.</span>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <button type="button" className="cbx-btn" disabled={busy} onClick={() => void run("zip")}>
              {busy && state.format === "zip" ? "Exporting…" : "Download zip for itch.io (installs, plays offline)"}
            </button>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Upload it to itch.io as an HTML game, or put its files on any HTTPS host: players can install it as an app and play offline.
            </span>
          </div>
          {state.kind === "done" && (
            <p role="status" style={{ margin: 0, color: "#4ade80" }}>
              Saved {state.name} ({formatBytes(state.bytes)}).
            </p>
          )}
          {state.kind === "error" && (
            <p role="alert" style={{ margin: 0, color: "#f87171" }}>
              Export failed: {state.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
