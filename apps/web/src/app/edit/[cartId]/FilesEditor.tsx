"use client";

/**
 * The Files tab: upload the content a cartridge is too small to hold.
 *
 * Until this existed the asset store was reachable by HTTP and unreachable by a
 * person. `/api/carts/[cartId]/assets` was complete — content-addressed,
 * budgeted, deduplicating — and nothing in the editor called it, so a creator
 * could only spend their model's allowance indirectly, through images already
 * embedded in a mesh. This is the direct path.
 *
 * ## Why it validates before it uploads
 *
 * Every rule here is enforced again on the server, which is the only place that
 * counts: the hash is recomputed from the bytes, the allowlist and the budget
 * are re-checked, and nothing the client claims is trusted. The client-side pass
 * is not a substitute for that, it is a courtesy — a 16MB upload that was always
 * going to be refused costs the creator a minute of waiting to be told so. So
 * this runs the *same* `checkAssetUpload` the route runs, and only sends what it
 * expects to be accepted.
 *
 * ## Why the hash is computed here as well
 *
 * Two reasons, neither of them authority. It lets the request carry a hash the
 * server can cross-check, so a truncated or mangled upload fails loudly instead
 * of storing wrong bytes under a right-looking name. And it means dedup is
 * visible: re-uploading something the store already has reports as costing
 * nothing, which is otherwise invisible and looks like a bug.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ALLOWED_ASSET_TYPES,
  EMPTY_CART_ASSETS,
  MAX_ASSET_BYTES,
  checkAssetUpload,
  describeRejection,
  hashAsset,
  withAsset,
  withoutAsset,
  type AssetRef,
  type CartAssets,
} from "@/lib/cartAssetStore";
import { authHeaders } from "@/lib/supabase-browser";

import {
  assetNameFromFile,
  budgetUsage,
  contentTypeForUpload,
  formatBytes,
  uniqueAssetName,
} from "./assetUploads";
import styles from "./editor.module.css";

interface FilesEditorProps {
  cartId: string;
  /** The model's allowance. The tab is only shown when this is non-zero or the cart already has assets. */
  budgetBytes: number;
  /** Lets the workbench keep the tab reachable once a cart is storing something. */
  onHasAssetsChange?: (hasAssets: boolean) => void;
}

/** One line of feedback about a file the creator just picked. */
interface Outcome {
  readonly fileName: string;
  readonly text: string;
  readonly failed: boolean;
}

export function FilesEditor({ cartId, budgetBytes, onHasAssetsChange }: FilesEditorProps) {
  const [assets, setAssets] = useState<CartAssets>(EMPTY_CART_ASSETS);
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const names = Object.keys(assets.entries);
  const usage = budgetUsage(assets, budgetBytes);

  useEffect(() => {
    onHasAssetsChange?.(names.length > 0);
  }, [names.length, onHasAssetsChange]);

  // Load the manifest the cart already has. The route returns each entry with a
  // resolved public URL, which is the only part the client cannot derive itself.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/carts/${cartId}/assets`);
        if (!response.ok) throw new Error(`Server said ${response.status}.`);
        const body = (await response.json()) as {
          entries: Record<string, AssetRef & { url: string }>;
        };
        if (cancelled) return;
        const entries: Record<string, AssetRef> = {};
        const resolved: Record<string, string> = {};
        for (const [name, entry] of Object.entries(body.entries ?? {})) {
          entries[name] = { hash: entry.hash, bytes: entry.bytes, contentType: entry.contentType };
          resolved[name] = entry.url;
        }
        setAssets({ entries });
        setUrls(resolved);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not load this cart's files.");
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cartId]);

  const upload = useCallback(
    async (files: readonly File[]) => {
      setBusy(true);
      setOutcomes([]);

      // The manifest advances inside this loop rather than through React state,
      // so a second file is budgeted against the first one's bytes. Reading
      // state here would check every file against the manifest as it was before
      // any of them landed, and let a batch overshoot the budget.
      let manifest = assets;
      const nextUrls: Record<string, string> = {};
      const results: Outcome[] = [];

      for (const file of files) {
        const name = uniqueAssetName(assetNameFromFile(file.name), Object.keys(manifest.entries));
        const contentType = contentTypeForUpload(file.name, file.type);

        // Checked before the bytes are read, so an oversized file costs nothing.
        if (file.size > MAX_ASSET_BYTES) {
          results.push({
            fileName: file.name,
            failed: true,
            text: `${formatBytes(file.size)} is over the ${formatBytes(MAX_ASSET_BYTES)} per-file limit.`,
          });
          continue;
        }

        let bytes: Uint8Array;
        let hash: string;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
          hash = await hashAsset(bytes);
        } catch {
          results.push({ fileName: file.name, failed: true, text: "Could not read this file." });
          continue;
        }

        const rejection = checkAssetUpload(
          name,
          hash,
          bytes.length,
          contentType,
          manifest,
          budgetBytes,
        );
        if (rejection) {
          results.push({ fileName: file.name, failed: true, text: describeRejection(rejection) });
          continue;
        }

        const form = new FormData();
        form.set("name", name);
        form.set("hash", hash);
        // Re-wrapped so the part carries the type resolved above: the browser
        // leaves `.glb` and friends untyped, and the server allowlists whatever
        // the part declares.
        form.set("file", new File([bytes as BlobPart], name, { type: contentType }));

        try {
          const response = await fetch(`/api/carts/${cartId}/assets`, {
            method: "POST",
            headers: await authHeaders(),
            body: form,
          });
          const body = (await response.json()) as {
            error?: string;
            url?: string;
            deduplicated?: boolean;
          };
          if (!response.ok) {
            results.push({
              fileName: file.name,
              failed: true,
              text: body.error ?? `Server said ${response.status}.`,
            });
            continue;
          }
          manifest = withAsset(manifest, name, { hash, bytes: bytes.length, contentType });
          if (body.url) nextUrls[name] = body.url;
          results.push({
            fileName: file.name,
            failed: false,
            text: body.deduplicated
              ? `Stored as ${name} — already in the store, so it cost no new space.`
              : `Stored as ${name} (${formatBytes(bytes.length)}).`,
          });
        } catch {
          results.push({
            fileName: file.name,
            failed: true,
            text: "Could not reach the server. Nothing was uploaded.",
          });
        }
      }

      setAssets(manifest);
      setUrls((current) => ({ ...current, ...nextUrls }));
      setOutcomes(results);
      setBusy(false);
    },
    [assets, budgetBytes, cartId],
  );

  const remove = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        const response = await fetch(
          `/api/carts/${cartId}/assets?name=${encodeURIComponent(name)}`,
          { method: "DELETE", headers: await authHeaders() },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setOutcomes([
            { fileName: name, failed: true, text: body.error ?? `Server said ${response.status}.` },
          ]);
          return;
        }
        setAssets((current) => withoutAsset(current, name));
        setOutcomes([{ fileName: name, failed: false, text: "Removed from this cart." }]);
      } catch {
        setOutcomes([{ fileName: name, failed: true, text: "Could not reach the server." }]);
      } finally {
        setBusy(false);
      }
    },
    [cartId],
  );

  return (
    <div className={styles.filesPanel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Files</span>
        <span className={styles.panelMeta}>
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.budgetBytes)}
        </span>
      </div>

      <p className={styles.filesIntro}>
        Textures, models and audio too large for the cartridge. These are stored beside the cart and
        referenced by content hash, so identical files are only ever stored once — across every cart
        on the site, not just this one.
      </p>

      <div
        className={styles.filesMeter}
        role="meter"
        aria-valuenow={Math.round(usage.fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Asset budget used"
      >
        <div className={styles.filesMeterFill} style={{ width: `${usage.fraction * 100}%` }} />
      </div>

      <div className={styles.filesActions}>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ALLOWED_ASSET_TYPES.join(",")}
          className={styles.filesInput}
          disabled={busy}
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            // Cleared so picking the same file twice in a row still fires a
            // change event — otherwise a failed upload cannot be retried.
            event.target.value = "";
            if (picked.length > 0) void upload(picked);
          }}
        />
        <span className={styles.panelMeta}>
          {formatBytes(usage.freeBytes)} free · up to {formatBytes(MAX_ASSET_BYTES)} per file
        </span>
      </div>

      {loadError && <p className={styles.panelWarning}>{loadError}</p>}

      {outcomes.length > 0 && (
        <ul className={styles.filesOutcomes}>
          {outcomes.map((outcome) => (
            <li
              key={`${outcome.fileName}:${outcome.text}`}
              className={outcome.failed ? styles.filesOutcomeFailed : undefined}
            >
              <strong>{outcome.fileName}</strong> — {outcome.text}
            </li>
          ))}
        </ul>
      )}

      {loaded && names.length === 0 && !loadError && (
        <p className={styles.panelMeta}>
          Nothing uploaded yet. A cart plays fine without files — they are for content the 2MB
          cartridge cannot hold.
        </p>
      )}

      {names.length > 0 && (
        <ul className={styles.filesList}>
          {Object.entries(assets.entries)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, ref]) => (
              <li key={name} className={styles.filesRow}>
                <span className={styles.filesName}>
                  {urls[name] ? (
                    <a href={urls[name]} target="_blank" rel="noreferrer">
                      {name}
                    </a>
                  ) : (
                    name
                  )}
                </span>
                <span className={styles.panelMeta}>{ref.contentType}</span>
                <span className={styles.panelMeta}>{formatBytes(ref.bytes)}</span>
                <button
                  type="button"
                  className={styles.filesRemove}
                  disabled={busy}
                  onClick={() => void remove(name)}
                  title={`Remove ${name} from this cart`}
                >
                  Remove
                </button>
              </li>
            ))}
        </ul>
      )}

      {names.length > 0 && (
        <p className={styles.filesFootnote}>
          Removing drops this cart&apos;s reference to a file, not the stored bytes — another cart
          may share them.
        </p>
      )}
    </div>
  );
}
