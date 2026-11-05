"use client";

/**
 * Edit together (AAA_PRODUCTION_ROADMAP.md W2): turn co-editing on, say who
 * you are, and see who else is editing this cart. The session keeps running
 * with the dialog closed.
 */

import { useEffect, useRef } from "react";

import type { CoEdit } from "./useCoEdit";
import styles from "./editor.module.css";

export function CoEditPanel({ coEdit, onClose }: { coEdit: CoEdit; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { status, others, reach, enabled, setEnabled, name, setName } = coEdit;
  const statusText =
    status === "on"
      ? others.length === 0
        ? "On — nobody else here yet."
        : `On — ${others.length} other${others.length === 1 ? "" : "s"} editing.`
      : status === "connecting"
        ? "Connecting…"
        : status === "error"
          ? "Couldn't reach the editing channel."
          : "Off.";

  return (
    <div className={styles.helpOverlay} role="dialog" aria-modal="true" aria-label="Edit together">
      <div className={styles.helpCard} style={{ maxWidth: 480 }}>
        <div className={styles.helpHead}>
          <h2 className={styles.helpTitle}>Edit together</h2>
          <button ref={closeRef} type="button" className="cbx-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ display: "grid", gap: 12, fontSize: 14 }}>
          <p style={{ margin: 0, opacity: 0.8 }}>
            Everyone with this on sees the others&rsquo; changes to the scene and the cart&rsquo;s layers as they make them. Different objects keep everyone&rsquo;s
            edits; for the same object, the latest edit wins. {reach === "online" ? "It reaches anyone editing this cart." : "Without an online server it reaches this browser's other tabs."}
          </p>
          <label style={{ display: "grid", gap: 4 }}>
            Your name
            <input aria-label="Your name" value={name} maxLength={40} placeholder="Shown to the others" onChange={(event) => setName(event.target.value)} />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" aria-label="Edit together" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Edit together
          </label>
          <div role="status">{statusText}</div>
          {others.length > 0 && (
            <ul aria-label="Editing now" style={{ margin: 0, paddingLeft: 18 }}>
              {others.map((p) => (
                <li key={p.peer}>
                  {p.name}
                  {p.selection.length > 0 ? ` — has ${p.selection.length === 1 ? `“${p.selection[0]}”` : `${p.selection.length} objects`} selected` : ""}
                </li>
              ))}
            </ul>
          )}
          <p style={{ margin: 0, opacity: 0.7, fontSize: 12 }}>
            Changes from when it&rsquo;s on travel, so turn it on before editing, or save first. The code and the sprite, map and sound banks don&rsquo;t travel yet: one
            person edits those at a time and saves.
          </p>
        </div>
      </div>
    </div>
  );
}
