"use client";

/**
 * The CC0 libraries beyond the Cartbox catalogue (AAA_FIDELITY_ROADMAP.md
 * F9f): a modal that searches Poly Haven or ambientCG for one kind of asset
 * (a material, an HDRI or a model) and imports the chosen one at a
 * resolution. Searching and importing go through externalLibraries.ts; what
 * an import turns into (a material on the selected mesh, the sky's panorama, a
 * new mesh) is the opener's, handed the asset and resolution through
 * {@link onImport}. The credit is the opener's to stamp, from
 * {@link externalCredit}.
 */

import { useCallback, useEffect, useState } from "react";

import { EXTERNAL_RESOLUTIONS, searchExternal, type ExternalAsset, type ExternalKind, type ExternalResolution, type ExternalSource } from "@/lib/externalLibraries";
import styles from "./LibraryBrowser.module.css";

interface ExternalLibraryBrowserProps {
  open: boolean;
  onClose: () => void;
  kind: ExternalKind;
  onImport: (asset: ExternalAsset, resolution: ExternalResolution) => Promise<void>;
}

const TITLES: Record<ExternalKind, string> = { material: "CC0 materials", hdri: "CC0 HDRIs", mesh: "CC0 models" };
const SOURCES: { id: ExternalSource; label: string }[] = [
  { id: "polyhaven", label: "Poly Haven" },
  { id: "ambientcg", label: "ambientCG" },
];

export function ExternalLibraryBrowser({ open, onClose, kind, onImport }: ExternalLibraryBrowserProps) {
  const [source, setSource] = useState<ExternalSource>("polyhaven");
  const [text, setText] = useState("");
  const [resolution, setResolution] = useState<ExternalResolution>("1k");
  const [assets, setAssets] = useState<ExternalAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Search as the query changes (a stale answer dropped), a moment after typing stops.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchExternal(source, kind, text.trim(), (url) => fetch(url))
        .then((found) => {
          if (!stale) setAssets(found.slice(0, 60));
        })
        .catch((cause: unknown) => {
          if (!stale) setError(cause instanceof Error ? cause.message : "The library couldn't be reached.");
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, source, kind, text]);

  const stopInsideClicks = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);
  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={TITLES[kind]} onClick={stopInsideClicks}>
        <div className={styles.header}>
          <span className={styles.title}>{TITLES[kind]}</span>
          <span className={styles.count}>{assets.length} found</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className={styles.controls}>
          <div className={styles.chips}>
            {SOURCES.filter((s) => !(kind === "mesh" && s.id === "ambientcg")).map((s) => (
              <button key={s.id} type="button" className={`${styles.chip} ${source === s.id ? styles.chipActive : ""}`} onClick={() => setSource(s.id)}>
                {s.label}
              </button>
            ))}
            {EXTERNAL_RESOLUTIONS.map((r) => (
              <button key={r} type="button" className={`${styles.chip} ${resolution === r ? styles.chipActive : ""}`} onClick={() => setResolution(r)} title="The resolution to import at">
                {r}
              </button>
            ))}
          </div>
          <input className={styles.search} type="search" placeholder="Search by name or tag…" value={text} onChange={(event) => setText(event.target.value)} autoFocus />
        </div>
        {error ? (
          <div className={`${styles.state} ${styles.error}`}>{error}</div>
        ) : loading && assets.length === 0 ? (
          <div className={styles.state}>Searching…</div>
        ) : assets.length === 0 ? (
          <div className={styles.state}>No matching assets.</div>
        ) : (
          <div className={styles.grid}>
            {assets.map((asset) => (
              <button
                key={`${asset.source}:${asset.id}`}
                type="button"
                className={styles.card}
                disabled={busy !== null}
                title={`${asset.name} — ${asset.provenance.author}, ${asset.provenance.source} (CC0)`}
                onClick={async () => {
                  setBusy(asset.id);
                  setError(null);
                  try {
                    await onImport(asset, resolution);
                    onClose();
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "That asset couldn't be imported.");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {asset.thumbnailUrl && <img className={styles.thumb} src={asset.thumbnailUrl} alt="" loading="lazy" />}
                <span className={styles.cardBody}>
                  <span className={styles.cardName}>{busy === asset.id ? "Importing…" : asset.name}</span>
                  <span className={styles.credit}>{asset.provenance.author}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className={styles.footer}>Every asset is CC0 from {source === "polyhaven" ? "Poly Haven" : "ambientCG"}. Its credit is kept with your cart.</div>
      </div>
    </div>
  );
}
