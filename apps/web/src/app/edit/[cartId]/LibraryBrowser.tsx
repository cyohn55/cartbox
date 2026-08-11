"use client";

/**
 * The asset-library browser: a modal opened from a tab's import rail that lets a
 * creator search the first-party CC0 catalogue and insert an asset into the cart.
 *
 * The modal is medium-scoped — a tab opens it for exactly the kind it can insert
 * (the Mesh tab passes `kind="mesh"`), so the browser never shows an asset the
 * caller has no path for. Fetching, searching, and category filtering all go
 * through {@link fetchLibrary}; the actual insert is the caller's job, handed the
 * chosen {@link LibraryAsset} via {@link onInsert}, so this component owns
 * discovery and the tab owns turning an asset into a sidecar entry.
 */

import { useCallback, useEffect, useState } from "react";

import { provenanceCredit, type LibraryAsset, type LibraryAssetKind } from "@/lib/libraryManifest";
import { fetchLibrary } from "@/lib/libraryClient";
import styles from "./LibraryBrowser.module.css";

interface LibraryBrowserProps {
  /** Whether the modal is shown. */
  open: boolean;
  /** Close without inserting (backdrop, close button, or Escape). */
  onClose: () => void;
  /** The mediums to browse — exactly the kinds the opener can insert. */
  kinds: readonly LibraryAssetKind[];
  /** Insert the chosen asset; may be async. Rejections surface as a card error. */
  onInsert: (asset: LibraryAsset) => void | Promise<void>;
  /** Heading; defaults to a label derived from the browsed kinds. */
  title?: string;
}

/** Human labels for the medium a single-kind browser is scoped to. */
const KIND_TITLE: Record<LibraryAssetKind, string> = {
  mesh: "3D model library",
  sprite: "Sprite library",
  tile: "Tile library",
  voxel: "Voxel library",
};

/** A heading for a browser scoped to `kinds`, falling back to a generic label. */
function titleForKinds(kinds: readonly LibraryAssetKind[]): string {
  if (kinds.length === 1) return KIND_TITLE[kinds[0]!];
  return "Asset library";
}

/** One catalogue card: thumbnail with a glyph fallback, credit, and Insert. */
function AssetCard({
  asset,
  onInsert,
}: {
  asset: LibraryAsset;
  onInsert: (asset: LibraryAsset) => void | Promise<void>;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const insert = async () => {
    setBusy(true);
    setError(null);
    try {
      await onInsert(asset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not insert this asset.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card}>
      {thumbFailed ? (
        <div className={styles.thumbFallback} aria-hidden>
          ▣
        </div>
      ) : (
        <img
          className={styles.thumb}
          src={asset.thumbnailUrl}
          alt={asset.name}
          loading="lazy"
          onError={() => setThumbFailed(true)}
        />
      )}
      <div className={styles.cardBody}>
        <span className={styles.cardName}>{asset.name}</span>
        <span className={styles.credit}>{provenanceCredit(asset)}</span>
        {error && <span className={`${styles.credit} ${styles.error}`}>{error}</span>}
        <button type="button" className={styles.insert} onClick={() => void insert()} disabled={busy}>
          {busy ? "Inserting…" : "Insert"}
        </button>
      </div>
    </div>
  );
}

export function LibraryBrowser({ open, onClose, kinds, onInsert, title }: LibraryBrowserProps) {
  // A stable dependency key for the kinds array, whose identity changes each
  // render even when its contents do not.
  const kindsKey = [...kinds].sort().join(",");
  const [text, setText] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape whenever the modal is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Fetch whenever the query inputs change while open. A stale flag drops the
  // response of a superseded request so fast typing never shows older results.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    setError(null);
    fetchLibrary({
      kinds: [...kinds],
      ...(text.trim() ? { text: text.trim() } : {}),
      ...(category ? { categories: [category] } : {}),
    })
      .then((response) => {
        if (stale) return;
        setAssets(response.items as LibraryAsset[]);
        setCategories(response.categories as string[]);
        setTotal(response.totalItems);
      })
      .catch((cause: unknown) => {
        if (stale) return;
        setError(cause instanceof Error ? cause.message : "Could not load the asset library.");
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [open, kindsKey, text, category]);

  // Reset transient search state each time the modal is opened fresh.
  useEffect(() => {
    if (open) {
      setText("");
      setCategory(null);
    }
  }, [open]);

  const stopInsideClicks = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? titleForKinds(kinds)}
        onClick={stopInsideClicks}
      >
        <div className={styles.header}>
          <span className={styles.title}>{title ?? titleForKinds(kinds)}</span>
          <span className={styles.count}>
            {total} {total === 1 ? "asset" : "assets"}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.controls}>
          <input
            className={styles.search}
            type="search"
            placeholder="Search by name or tag…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoFocus
          />
          {categories.length > 0 && (
            <div className={styles.chips}>
              <button
                type="button"
                className={`${styles.chip} ${category === null ? styles.chipActive : ""}`}
                onClick={() => setCategory(null)}
              >
                All
              </button>
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`${styles.chip} ${category === name ? styles.chipActive : ""}`}
                  onClick={() => setCategory(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <div className={`${styles.state} ${styles.error}`}>{error}</div>
        ) : loading && assets.length === 0 ? (
          <div className={styles.state}>Loading…</div>
        ) : assets.length === 0 ? (
          <div className={styles.state}>No matching assets.</div>
        ) : (
          <div className={styles.grid}>
            {assets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} onInsert={onInsert} />
            ))}
          </div>
        )}

        <div className={styles.footer}>
          Every asset is public-domain (CC0). The credit shown is stamped into your cart on insert.
        </div>
      </div>
    </div>
  );
}
