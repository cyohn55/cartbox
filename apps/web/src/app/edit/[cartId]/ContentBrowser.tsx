"use client";

/**
 * The content browser (ENGINE_PARITY_ROADMAP.md EP4): a drawer under the Mesh
 * tab's view listing every asset the cart's 3D scene is built from (see
 * contentBrowser.ts), in folders by kind, searchable, with thumbnails. Drag a
 * mesh or prefab into the scene view to place it where it lands (or press
 * Place); select an asset to see what uses it, select those objects, and rename
 * it safely — references in the scene and, optionally, string literals in the
 * cart's code follow the new name.
 */

import { useEffect, useMemo, useState } from "react";

import { deserializeMeshAsset, meshBounds, renderMesh, type MeshAsset } from "@cartbox/editor";

import { ASSET_KINDS, codeReferences, collectAssets, filterAssets, renamable, renameAsset, renameInCode, sceneReferences, type AssetKind, type ContentAsset } from "@/lib/contentBrowser";
import { decodeMeshTextures } from "@/lib/meshImport";
import type { MeshSidecar } from "@/lib/meshSidecar";
import styles from "./editor.module.css";

/** The drag payload's type, read by the scene view's drop handler. */
export const ASSET_DRAG_TYPE = "application/x-cartbox-asset";

const THUMB = 64;
/** Thumbnails already drawn, by mesh payload (shared across browsers and remounts). */
const thumbCache = new Map<string, string>();

/** The cart's code, when the browser may read (and, on a rename, update) it. */
export interface CodeAccess {
  getText(): string;
  setText(text: string): void;
}

async function meshThumbnail(payload: string): Promise<string | null> {
  const cached = thumbCache.get(payload);
  if (cached) return cached;
  let mesh: MeshAsset;
  try {
    mesh = deserializeMeshAsset(payload);
  } catch {
    return null;
  }
  const bounds = meshBounds(mesh);
  if (!bounds) return null;
  const radius = 0.5 * Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const out = new Uint8ClampedArray(THUMB * THUMB * 4);
  const textures = await decodeMeshTextures(mesh).catch(() => undefined);
  renderMesh(mesh, {
    camera: { yaw: 0.7, pitch: 0.35, distance: radius / Math.sin((25 * Math.PI) / 180) + radius },
    size: THUMB,
    out,
    depth: new Float32Array(THUMB * THUMB),
    textures: textures ?? undefined,
    background: [0, 0, 0, 0],
  });
  const canvas = document.createElement("canvas");
  canvas.width = THUMB;
  canvas.height = THUMB;
  canvas.getContext("2d")?.putImageData(new ImageData(out, THUMB, THUMB), 0, 0);
  const url = canvas.toDataURL("image/png");
  thumbCache.set(payload, url);
  return url;
}

const GLYPHS: Record<AssetKind, string> = { mesh: "▲", prefab: "◆", material: "●", texture: "▦", effect: "✦", decal: "◍", debris: "⁂" };

export function ContentBrowser({
  sidecar,
  onSidecarChange,
  code,
  onSelectObjects,
  onPlace,
}: {
  sidecar: MeshSidecar;
  onSidecarChange: (sidecar: MeshSidecar) => void;
  code?: CodeAccess;
  onSelectObjects: (ids: string[]) => void;
  /** Place a mesh or prefab in the scene (where the view is looking). */
  onPlace: (asset: ContentAsset) => void;
}) {
  const [open, setOpen] = useState(true);
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [renameCode, setRenameCode] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  const assets = useMemo(() => collectAssets(sidecar), [sidecar]);
  const shown = useMemo(() => filterAssets(assets, kind, query), [assets, kind, query]);
  const selected = assets.find((a) => `${a.kind}:${a.key}` === selectedKey) ?? null;
  useEffect(() => setRename(selected?.name ?? ""), [selected?.name]);

  // Mesh and prefab thumbnails, drawn one at a time so the editor stays responsive.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const todo = shown.filter((a) => a.mesh && !thumbs[a.mesh]);
    void (async () => {
      for (const asset of todo) {
        if (cancelled) return;
        const url = await meshThumbnail(asset.mesh!);
        if (cancelled) return;
        if (url) setThumbs((t) => ({ ...t, [asset.mesh!]: url }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shown, open, thumbs]);

  // Texture previews as object URLs, released when they're no longer listed.
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const a of assets) if (a.image) next[a.key] = URL.createObjectURL(new Blob([a.image.bytes as BlobPart], { type: a.image.mime }));
    setImageUrls(next);
    return () => Object.values(next).forEach((u) => URL.revokeObjectURL(u));
  }, [assets]);

  const counts = useMemo(() => {
    const c = new Map<AssetKind, number>();
    for (const a of assets) c.set(a.kind, (c.get(a.kind) ?? 0) + 1);
    return c;
  }, [assets]);

  const codeLines = useMemo(() => (selected && code ? codeReferences(code.getText(), selected.name) : []), [selected, code]);

  /* eslint-disable @next/next/no-img-element -- in-memory data and blob URLs: nothing for an optimizer to fetch */
  const thumbOf = (a: ContentAsset) => {
    if (a.mesh && thumbs[a.mesh]) return <img src={thumbs[a.mesh]} alt="" width={THUMB} height={THUMB} style={{ imageRendering: "auto" }} />;
    if (a.image && imageUrls[a.key]) return <img src={imageUrls[a.key]} alt="" width={THUMB} height={THUMB} style={{ objectFit: "cover", borderRadius: 4 }} />;
    if (a.color) {
      const [r, g, b] = a.color.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
      return <span aria-hidden style={{ width: 40, height: 40, borderRadius: "50%", background: `radial-gradient(circle at 35% 35%, rgba(255,255,255,0.7), rgb(${r},${g},${b}) 45%, rgba(0,0,0,0.6))` }} />;
    }
    return (
      <span aria-hidden style={{ fontSize: 26, opacity: 0.75 }}>
        {GLYPHS[a.kind]}
      </span>
    );
  };
  /* eslint-enable @next/next/no-img-element */

  const doRename = () => {
    if (!selected) return;
    const next = renameAsset(sidecar, selected, rename);
    if (next === sidecar) return;
    onSidecarChange(next);
    if (code && renameCode) {
      const updated = renameInCode(code.getText(), selected.name, rename.trim());
      if (updated.count > 0) code.setText(updated.code);
    }
    setSelectedKey(`${selected.kind}:${selected.kind === "prefab" ? selected.key : rename.trim()}`);
  };

  return (
    <section aria-label="Content browser" style={{ borderTop: "1px solid var(--line, #262a3a)", display: "flex", flexDirection: "column", minHeight: open ? 230 : 0, maxHeight: 300 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px" }}>
        <button type="button" className={styles.toolBtn} aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Show or hide the content browser">
          {open ? "▾" : "▸"} Content · {assets.length}
        </button>
        {open && (
          <input
            type="search"
            aria-label="Search assets"
            placeholder="Search assets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: "0 1 260px", padding: "4px 8px", borderRadius: 6 }}
          />
        )}
      </div>
      {open && (
        <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 8, padding: "0 12px 10px" }}>
          <nav aria-label="Asset folders" style={{ display: "flex", flexDirection: "column", gap: 2, width: 140, flex: "none", overflowY: "auto", whiteSpace: "nowrap" }}>
            {[{ kind: "all" as const, label: "All" }, ...ASSET_KINDS].map((f) => (
              <button
                key={f.kind}
                type="button"
                className={styles.toolBtn}
                aria-pressed={kind === f.kind}
                onClick={() => setKind(f.kind)}
                style={{ justifyContent: "space-between" }}
              >
                <span>📁 {f.label}</span>
                <span style={{ opacity: 0.6, fontSize: 11 }}>{f.kind === "all" ? assets.length : (counts.get(f.kind) ?? 0)}</span>
              </button>
            ))}
          </nav>
          <div role="listbox" aria-label="Assets" style={{ flex: 1, minWidth: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 6, alignContent: "start" }}>
            {shown.length === 0 && <div style={{ opacity: 0.6, fontSize: 12, padding: 8 }}>{assets.length === 0 ? "Nothing here yet — import a model above." : "No assets match."}</div>}
            {shown.map((a) => {
              const id = `${a.kind}:${a.key}`;
              const placeable = a.kind === "mesh" || a.kind === "prefab";
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={id === selectedKey}
                  title={`${a.name} — ${a.detail}${placeable ? "\nDrag into the scene view to place it" : ""}`}
                  draggable={placeable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify({ kind: a.kind, key: a.key }));
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => setSelectedKey(id)}
                  onDoubleClick={() => placeable && onPlace(a)}
                  className={styles.toolBtn}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                    padding: 6,
                    height: "auto",
                    outline: id === selectedKey ? "2px solid #7db8fc" : "none",
                    cursor: placeable ? "grab" : "pointer",
                  }}
                >
                  <span style={{ width: THUMB, height: THUMB, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>{thumbOf(a)}</span>
                  <span style={{ fontSize: 11, width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                  <span style={{ fontSize: 10, opacity: 0.55, width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.detail}</span>
                </button>
              );
            })}
          </div>
          {selected && (
            <aside aria-label="Asset details" style={{ width: 230, flex: "none", overflowY: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 600 }}>
                {GLYPHS[selected.kind]} {selected.name}
              </div>
              <div style={{ opacity: 0.7 }}>{selected.detail}</div>
              {(selected.kind === "mesh" || selected.kind === "prefab") && (
                <button type="button" className={styles.toolBtn} onClick={() => onPlace(selected)} title="Place it where the scene view is looking (or drag it into the view)">
                  Place in scene
                </button>
              )}
              <div>
                Used by {selected.objects.length} object{selected.objects.length === 1 ? "" : "s"}
                {selected.objects.length > 0 && (
                  <button type="button" className={styles.toolBtn} style={{ marginLeft: 6 }} onClick={() => onSelectObjects([...selected.objects])}>
                    Select
                  </button>
                )}
              </div>
              {sceneReferences(sidecar, selected).map((line) => (
                <div key={line} style={{ opacity: 0.8 }}>
                  · {line}
                </div>
              ))}
              {code && (
                <div style={{ opacity: 0.8 }}>
                  {codeLines.length === 0 ? "Not named in the code" : `Named in the code on line${codeLines.length === 1 ? "" : "s"} ${codeLines.slice(0, 8).join(", ")}${codeLines.length > 8 ? "…" : ""}`}
                </div>
              )}
              {renamable(selected.kind) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                  <input aria-label="New asset name" value={rename} onChange={(e) => setRename(e.target.value)} style={{ padding: "4px 6px", borderRadius: 6 }} />
                  {code && codeLines.length > 0 && (
                    <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="checkbox" checked={renameCode} onChange={(e) => setRenameCode(e.target.checked)} />
                      Also update {codeLines.length} line{codeLines.length === 1 ? "" : "s"} of code
                    </label>
                  )}
                  <button type="button" className={styles.toolBtn} disabled={!rename.trim() || rename.trim() === selected.name} onClick={doRename}>
                    Rename
                  </button>
                </div>
              )}
            </aside>
          )}
        </div>
      )}
    </section>
  );
}
