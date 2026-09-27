"use client";

/**
 * The editor's download budget (ENGINE_ROADMAP.md, Phase 4): what a player's
 * browser fetches before this cart runs, how long that takes on typical
 * connections, and what would shrink it. Opened from the top bar's ⋯ menu.
 */

import { useEffect, useRef, useState } from "react";

import type { ConsoleModelId } from "@cartbox/editor";

import { cartAssetBytes } from "@/lib/cartAssetStore";
import { BUDGET_HEAVY_BYTES, BUDGET_LIGHT_BYTES, measureDownload, type DownloadBudget as Budget } from "@/lib/downloadBudget";
import { formatBytes } from "./assetUploads";
import styles from "./editor.module.css";

const RATING_TEXT: Record<Budget["rating"], string> = {
  light: "Light — loads quickly almost anywhere.",
  medium: "Medium — fine on broadband and 4G; a wait on slow mobile.",
  heavy: "Heavy — a long wait on mobile. See the tips below.",
};
const RATING_COLOR: Record<Budget["rating"], string> = { light: "#4ade80", medium: "#fbbf24", heavy: "#f87171" };

const seconds = (s: number) => (s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`);

export function DownloadBudget({
  modelId,
  cartridge,
  meshSidecar,
  otherData,
  cartId,
  hasUploads,
  onClose,
}: {
  modelId: ConsoleModelId;
  /** The cartridge bytes as they'd be saved (null when the engine can't save). */
  cartridge: Uint8Array | null;
  meshSidecar: string | null;
  otherData: readonly unknown[];
  cartId: string;
  hasUploads: boolean;
  onClose: () => void;
}) {
  const [budget, setBudget] = useState<Budget | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let uploadedBytes = 0;
      if (hasUploads) {
        try {
          const response = await fetch(`/api/carts/${cartId}/assets`);
          if (response.ok) uploadedBytes = cartAssetBytes((await response.json()) as Parameters<typeof cartAssetBytes>[0]);
        } catch {
          // Uploaded files just go uncounted when the manifest can't be read.
        }
      }
      const measured = await measureDownload({ modelId, cartridge, meshSidecar, otherData, uploadedBytes });
      if (!cancelled) setBudget(measured);
    })();
    return () => {
      cancelled = true;
    };
  }, [modelId, cartridge, meshSidecar, otherData, cartId, hasUploads]);

  const max = budget ? Math.max(...budget.items.map((i) => i.bytes), 1) : 1;
  return (
    <div className={styles.helpOverlay} role="dialog" aria-modal="true" aria-label="Download size">
      <div className={styles.helpCard} style={{ maxWidth: 560 }}>
        <div className={styles.helpHead}>
          <h2 className={styles.helpTitle}>Download size</h2>
          <button ref={closeRef} type="button" className="cbx-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {!budget ? (
          <p>Measuring…</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700 }} aria-label="Total download">
                {formatBytes(budget.total)}
              </div>
              <div style={{ color: RATING_COLOR[budget.rating] }}>{RATING_TEXT[budget.rating]}</div>
            </div>
            <div style={{ display: "grid", gap: 6 }} aria-label="What the player downloads">
              {budget.items.map((item) => (
                <div key={item.key} style={{ display: "grid", gap: 2 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                    <span>
                      {item.label} {item.note && <span style={{ opacity: 0.6 }}>· {item.note}</span>}
                    </span>
                    <span className="data">{formatBytes(item.bytes)}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)" }}>
                    <div style={{ height: 6, borderRadius: 3, width: `${Math.max(1, (item.bytes / max) * 100)}%`, background: "#8b93ff" }} />
                  </div>
                </div>
              ))}
            </div>
            {budget.scene && (
              <div style={{ fontSize: 13 }} aria-label="3D scene breakdown">
                <strong>3D scene</strong> (before compression): geometry {formatBytes(budget.scene.geometry)} · textures{" "}
                {formatBytes(budget.scene.textures)} · animation {formatBytes(budget.scene.animation)} · other {formatBytes(budget.scene.other)}
                {budget.scene.heaviest.length > 0 && (
                  <div style={{ opacity: 0.75, marginTop: 4 }}>
                    Heaviest: {budget.scene.heaviest.map((m) => `${m.name} (${formatBytes(m.bytes)})`).join(", ")}
                  </div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 16, fontSize: 13 }} aria-label="Load time">
              {budget.loadSeconds.map((l) => (
                <div key={l.name}>
                  <div style={{ opacity: 0.6 }}>{l.name}</div>
                  <div className="data">{seconds(l.seconds)}</div>
                </div>
              ))}
            </div>
            {budget.tips.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }} aria-label="Tips">
                {budget.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            )}
            <p className={styles.helpFoot}>
              Sizes are as sent (compressed); the Cartbox player itself is shared by every cart and cached, so it isn&apos;t counted. Light is under{" "}
              {formatBytes(BUDGET_LIGHT_BYTES)}, heavy over {formatBytes(BUDGET_HEAVY_BYTES)}.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
