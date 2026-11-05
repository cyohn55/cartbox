"use client";

/**
 * Named snapshots of the cart (ENGINE_PARITY_ROADMAP.md EP19): take one, see
 * them listed newest first, restore one (after seeing what it changes, and with
 * the current state snapshotted first), or delete one. Opened from the File
 * menu. Kept in the account when signed in, else in this browser.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { defaultSnapshotName, snapshotChanges, type SnapshotContent, type SnapshotInfo } from "@/lib/cartSnapshots";
import { compareBranches, mergeBranches } from "@/lib/cartBranches";
import { isStaticExport } from "@/lib/staticSite";
import { accountSnapshots, browserSnapshots, indexedDbSnapshots, SnapshotError, type SnapshotStore } from "@/lib/snapshotStore";
import { authHeaders } from "@/lib/supabase-browser";
import { formatBytes } from "./assetUploads";
import styles from "./editor.module.css";

type Pending = { kind: "restore"; info: SnapshotInfo; content: SnapshotContent; changes: string[] } | null;

export function SnapshotsPanel({
  cartId,
  current,
  onRestore,
  onClose,
}: {
  cartId: string;
  /** The cart as it stands (null when the engine can't save it). */
  current: () => SnapshotContent | null;
  /** Put a snapshot's content into the editor. */
  onRestore: (content: SnapshotContent) => void;
  onClose: () => void;
}) {
  const browser = useMemo(() => (typeof indexedDB !== "undefined" ? browserSnapshots(cartId, indexedDbSnapshots()) : null), [cartId]);
  const account = useMemo(
    () => (isStaticExport ? null : accountSnapshots(cartId, async (url, init) => fetch(url, { ...init, headers: await authHeaders(init?.headers ?? {}) }))),
    [cartId],
  );
  const [store, setStore] = useState<SnapshotStore | null>(account ?? browser);
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [name, setName] = useState(() => defaultSnapshotName());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = useCallback(async () => {
    if (!store) return;
    try {
      setList(await store.list());
    } catch (error) {
      // Signed out, not this cart's owner, or a server without snapshots: keep them in this browser instead.
      if (error instanceof SnapshotError && [401, 403, 503].includes(error.status) && store.home === "account" && browser) {
        setStore(browser);
        const why = error.status === 401 ? "Not signed in" : error.status === 403 ? "This cart isn't yours" : "Snapshots aren't set up on this server";
        setMessage({ text: `${why}: snapshots are kept in this browser.` });
        return;
      }
      setList([]);
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  }, [store, browser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const take = async (snapshotName: string, quiet = false) => {
    const content = current();
    if (!store || !content) throw new SnapshotError("The cart can't be saved right now (is the engine loaded?).");
    const info = await store.take(snapshotName, content);
    if (!quiet) setMessage({ text: `Took “${info.name}”.` });
    await refresh();
    return info;
  };

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(null);
    }
  };

  const askRestore = (info: SnapshotInfo) =>
    act(info.id, async () => {
      if (!store) return;
      const content = await store.open(info.id);
      if (!content) throw new SnapshotError("That snapshot couldn't be read.");
      const now = current();
      setPending({ kind: "restore", info, content, changes: now ? snapshotChanges(now, content) : ["everything"] });
    });

  const restore = (p: NonNullable<Pending>) =>
    act(p.info.id, async () => {
      // The current state first, so the restore can itself be undone.
      await take(`Before restoring “${p.info.name}”`.slice(0, 80), true);
      onRestore(p.content);
      setPending(null);
      setMessage({ text: `Restored “${p.info.name}”. Save to keep it.` });
    });

  // Branches (W3): a snapshot merged into the cart object by object, against a common ancestor when one is picked.
  const [merging, setMerging] = useState<{ info: SnapshotInfo; theirs: SnapshotContent; base: SnapshotContent | null; baseId: string; picks: Record<string, "ours" | "theirs"> } | null>(null);
  const askMerge = (info: SnapshotInfo) =>
    act(info.id, async () => {
      if (!store) return;
      const theirs = await store.open(info.id);
      if (!theirs) throw new SnapshotError("That snapshot couldn't be read.");
      setMerging({ info, theirs, base: null, baseId: "", picks: {} });
    });
  const setBase = (baseId: string) =>
    act("base", async () => {
      if (!merging || !store) return;
      const base = baseId ? await store.open(baseId) : null;
      setMerging({ ...merging, base, baseId });
    });
  const mergeNow = () =>
    act("merge", async () => {
      const ours = current();
      if (!merging || !ours) return;
      const result = mergeBranches(merging.base, ours, merging.theirs, (key) => merging.picks[key] ?? "theirs");
      await take(`Before merging “${merging.info.name}”`.slice(0, 80), true);
      onRestore(result.content);
      setMessage({ text: `Merged “${merging.info.name}” (${result.conflicts.filter((c) => c.took === "theirs").length} of ${result.conflicts.length} choices from it). Save to keep it.` });
      setMerging(null);
    });

  const remove = (info: SnapshotInfo) =>
    act(info.id, async () => {
      if (!store || !window.confirm(`Delete the snapshot “${info.name}”? This can't be undone.`)) return;
      await store.remove(info.id);
      await refresh();
    });

  return (
    <div className={styles.helpOverlay} role="dialog" aria-modal="true" aria-label="Snapshots">
      <div className={styles.helpCard} style={{ maxWidth: 560 }}>
        <div className={styles.helpHead}>
          <h2 className={styles.helpTitle}>Snapshots</h2>
          <button ref={closeRef} type="button" className="cbx-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ display: "grid", gap: 12, fontSize: 14 }}>
          <p style={{ margin: 0, opacity: 0.8 }}>
            A snapshot keeps the whole cart (code, art, sound, scene and every layer) under a name, to go back to later.{" "}
            {store?.home === "account" ? "Kept in your account." : "Kept in this browser."}
          </p>
          <form
            style={{ display: "flex", gap: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              void act("take", async () => {
                await take(name);
                setName(defaultSnapshotName());
              });
            }}
          >
            <input
              aria-label="Snapshot name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              style={{ flex: 1, font: "inherit", padding: "6px 10px", background: "var(--well)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)" }}
            />
            <button type="submit" className="cbx-btn cbx-btn-accent" disabled={busy !== null || !store}>
              {busy === "take" ? "Taking…" : "Take snapshot"}
            </button>
          </form>
          {message && (
            <p role={message.error ? "alert" : "status"} style={{ margin: 0, color: message.error ? "#f87171" : "#4ade80" }}>
              {message.text}
            </p>
          )}
          {pending && (
            <div role="alertdialog" aria-label="Restore snapshot" style={{ padding: 12, borderRadius: 8, border: "1px solid var(--border-strong)", display: "grid", gap: 8 }}>
              <strong>Restore “{pending.info.name}”?</strong>
              <span>
                {pending.changes.length === 0
                  ? "It matches the cart as it is now."
                  : `This changes: ${pending.changes.join(", ")}.`}{" "}
                The cart as it is now is snapshotted first.
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="cbx-btn cbx-btn-accent" disabled={busy !== null} onClick={() => void restore(pending)}>
                  {busy === pending.info.id ? "Restoring…" : "Restore"}
                </button>
                <button type="button" className="cbx-btn" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {merging && (() => {
            const ours = current();
            const diff = ours ? compareBranches(ours, merging.theirs) : [];
            const auto = ours && merging.base ? new Set(mergeBranches(merging.base, ours, merging.theirs).conflicts.map((c) => c.key)) : null;
            return (
              <div role="alertdialog" aria-label="Merge snapshot" style={{ padding: 12, borderRadius: 8, border: "1px solid var(--border-strong)", display: "grid", gap: 8 }}>
                <strong>Merge “{merging.info.name}” into the cart</strong>
                <label style={{ fontSize: 13 }}>
                  Common ancestor{" "}
                  <select aria-label="Common ancestor" value={merging.baseId} onChange={(e) => void setBase(e.target.value)}>
                    <option value="">none (choose every difference)</option>
                    {(list ?? []).filter((i) => i.id !== merging.info.id).map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </label>
                {diff.length === 0 ? (
                  <span>It matches the cart as it is now.</span>
                ) : (
                  <div style={{ display: "grid", gap: 2, maxHeight: 200, overflowY: "auto", fontSize: 13 }}>
                    {diff.map((d) => {
                      const settled = auto !== null && !auto.has(d.key);
                      return (
                        <label key={d.key} style={{ display: "flex", gap: 6, alignItems: "center", opacity: settled ? 0.6 : 1 }}>
                          <input
                            type="checkbox"
                            aria-label={`Take ${d.label} from the snapshot`}
                            disabled={settled}
                            checked={settled || (merging.picks[d.key] ?? "theirs") === "theirs"}
                            onChange={(e) => setMerging({ ...merging, picks: { ...merging.picks, [d.key]: e.target.checked ? "theirs" : "ours" } })}
                          />
                          {d.label} <span style={{ opacity: 0.6 }}>({d.change}{settled ? ", changed on one side only: merged" : ""})</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="cbx-btn cbx-btn-accent" disabled={busy !== null || diff.length === 0} onClick={() => void mergeNow()}>
                    {busy === "merge" ? "Merging…" : "Merge ticked"}
                  </button>
                  <button type="button" className="cbx-btn" onClick={() => setMerging(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          })()}
          <div aria-label="Snapshots" style={{ display: "grid", gap: 4, maxHeight: 320, overflowY: "auto" }}>
            {list === null ? (
              <span style={{ opacity: 0.7 }}>Loading…</span>
            ) : list.length === 0 ? (
              <span style={{ opacity: 0.7 }}>No snapshots yet.</span>
            ) : (
              list.map((info) => (
                <div key={info.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>
                      {new Date(info.createdAt).toLocaleString()} · {formatBytes(info.size)}
                    </div>
                  </div>
                  <button type="button" className="cbx-btn" disabled={busy !== null} onClick={() => void askRestore(info)}>
                    Restore…
                  </button>
                  <button type="button" className="cbx-btn" disabled={busy !== null} onClick={() => void askMerge(info)} title="Compare it with the cart and take its changes object by object (a branch)">
                    Merge…
                  </button>
                  <button type="button" className="cbx-btn" disabled={busy !== null} aria-label={`Delete ${info.name}`} onClick={() => void remove(info)}>
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
