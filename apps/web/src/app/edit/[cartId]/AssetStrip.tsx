"use client";

/**
 * The Assets tab's browser: which medium is open, which asset is being edited,
 * and the actions that manage the list.
 *
 * It sits above the editors rather than inside either one's rail, because it is
 * the one control that belongs to *both* — the rails below it switch wholesale
 * when the medium changes, and a control that vanished with them would be
 * unreachable.
 *
 * Purely presentational and fully controlled: it renders the list it is handed
 * and reports intent. Deciding what "new" means for a medium, or what happens to
 * the selection when an asset is deleted, belongs to the container that owns the
 * cart's payload.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SpriteSheet } from "@cartbox/editor";

import type { CartAsset } from "@/lib/cartAssets";

import { AssetThumb } from "./AssetThumb";
import styles from "./editor.module.css";
import { useOverflowMenuSlot } from "./overflowMenu";
import { SegmentedControl } from "./railControls";

/**
 * What the tab is editing. Pixels is the sprite sheet; the two 3D mediums are
 * the same sculptor over different lattices, which is a property of the sculpt
 * and so of the asset — picking one here filters the list to it and decides the
 * shape of anything new.
 */
export type AssetMedium = "pixels" | "voxels" | "hexels";

export const MEDIUM_OPTIONS: readonly { id: AssetMedium; label: string; hint: string }[] = [
  { id: "pixels", label: "Pixels", hint: "Sprites, tiles and their material channels" },
  { id: "voxels", label: "Voxels", hint: "Sculpts built from cubes on the integer grid" },
  { id: "hexels", label: "Hexels", hint: "Sculpts built from close-packed rhombic cells" },
];

interface AssetStripProps {
  medium: AssetMedium;
  onMediumChange: (medium: AssetMedium) => void;
  /** The assets belonging to the active medium, already filtered by the owner. */
  assets: readonly CartAsset[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Open the asset library to insert a ready-made asset; omitted when the active
   *  medium has no library insert path yet, which hides the control. */
  onBrowseLibrary?: () => void;
  /** Commit a new name for an asset. Editing happens inline in the strip. */
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** Move `id` to sit before `beforeId`, or to the end when that is null. */
  onReorder: (id: string, beforeId: string | null) => void;
  /** Copy explaining what an unnamed medium means, shown when the list is empty. */
  emptyHint: string;
  /** Provides the pixels a sprite asset's thumbnail names. */
  sheet: SpriteSheet;
  /** Bumped when the sheet changes, so sprite thumbnails stay current. */
  version: number;
  /**
   * Callback ref for the slot that hosts the pixel editor's compact controls
   * (page, size, coverage, zoom, brush) — rendered here, on the medium toggle's
   * line, via a portal from the editor. Only mounted for the pixels medium.
   */
  controlsRef?: (node: HTMLDivElement | null) => void;
  /**
   * Callback ref for the slot inside the "…" menu that hosts the pixel editor's
   * import/export actions, so every file action shares one overflow button.
   */
  menuExtrasRef?: (node: HTMLDivElement | null) => void;
}

export function AssetStrip({
  medium,
  onMediumChange,
  assets,
  activeId,
  onSelect,
  onCreate,
  onBrowseLibrary,
  onRename,
  onDelete,
  onDuplicate,
  onReorder,
  emptyHint,
  sheet,
  version,
  controlsRef,
  menuExtrasRef,
}: AssetStripProps) {
  const active = assets.find((asset) => asset.id === activeId) ?? null;

  // The chip being dragged, and the one it would land before. Held here rather
  // than in the DOM because the drop target needs to render an insertion marker
  // while the drag is still in flight.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);

  const endDrag = () => {
    setDragging(null);
    setDropBefore(null);
  };

  // Inline rename: the chip being renamed and the draft text. Committing an empty
  // or unchanged name is a no-op, so a mis-fired rename never clears a name.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);

  // The workbench top bar offers its single "⋯" menu as a portal target. When
  // present, the strip's actions go *there* rather than growing a second "⋯" —
  // the whole editor keeps one overflow button. With no provider (the strip
  // rendered on its own), it falls back to its own menu below.
  const overflowSlot = useOverflowMenuSlot();
  const portalTarget = overflowSlot?.node ?? null;
  const closeMenu = overflowSlot ? overflowSlot.close : () => setActionsOpen(false);

  // Close the "…" menu on an outside click or Escape. The toggle button used to
  // close it with onBlur, but that fires *before* the button's own onClick — so
  // clicking the button while open closed then immediately reopened it, and it
  // never toggled shut. A document listener sidesteps that race entirely.
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    // Choosing any item (including the portaled import/export actions, which
    // cannot reach this state themselves) closes the menu. Native bubbling from
    // the portaled children reaches the list node even though React routes their
    // synthetic events elsewhere.
    const list = listRef.current;
    const onListClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("button")) setActionsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    list?.addEventListener("click", onListClick);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      list?.removeEventListener("click", onListClick);
    };
  }, [actionsOpen]);

  const startRename = (id: string) => {
    const asset = assets.find((entry) => entry.id === id);
    if (!asset) return;
    setRenamingId(id);
    setDraftName(asset.name);
  };
  const commitRename = () => {
    if (!renamingId) return;
    const trimmed = draftName.trim();
    const original = assets.find((entry) => entry.id === renamingId)?.name;
    if (trimmed && trimmed !== original) onRename(renamingId, trimmed);
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);

  // The asset verbs, shared by both homes: the workbench's single "⋯" menu when
  // it offers one, or the strip's own menu when it doesn't. New, Library, Rename,
  // Duplicate, Delete, and the pixel editor's import/export (portaled into the
  // extras slot). Each closes whichever menu it happens to live in.
  const actionItems = (
    <>
      <button
        type="button"
        role="menuitem"
        className={styles.fileMenuItem}
        onMouseDown={() => {
          onCreate();
          closeMenu();
        }}
      >
        New
      </button>
      {onBrowseLibrary && (
        <button
          type="button"
          role="menuitem"
          className={styles.fileMenuItem}
          onMouseDown={() => {
            onBrowseLibrary();
            closeMenu();
          }}
        >
          Library…
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={styles.fileMenuItem}
        disabled={!active}
        onMouseDown={() => {
          if (!active) return;
          startRename(active.id);
          closeMenu();
        }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.fileMenuItem}
        disabled={!active}
        onMouseDown={() => {
          if (!active) return;
          onDuplicate(active.id);
          closeMenu();
        }}
      >
        Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.fileMenuItem}
        disabled={!active}
        onMouseDown={() => {
          if (!active) return;
          onDelete(active.id);
          closeMenu();
        }}
      >
        Delete
      </button>
      {medium === "pixels" && <div ref={menuExtrasRef} className={styles.fileMenuExtras} />}
    </>
  );

  // With a provider (the workbench), the strip owns no button of its own — just
  // its items, portaled into the shared menu, plus a trailing divider so the file
  // actions below read as a separate group. The portal waits for the slot node,
  // so the strip never flashes its own button first. Standalone (no provider), it
  // keeps its original self-contained "⋯" menu.
  const ownMenu = (
    <div className={styles.fileMenu} ref={menuRef}>
      <button
        type="button"
        className="cbx-btn"
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        onClick={() => setActionsOpen((open) => !open)}
        title="Asset actions"
        aria-label="Asset actions"
      >
        ⋯
      </button>
      <div className={styles.fileMenuList} role="menu" hidden={!actionsOpen} ref={listRef}>
        {actionItems}
      </div>
    </div>
  );
  const assetActions = overflowSlot
    ? portalTarget &&
      createPortal(
        <>
          {actionItems}
          <div className={styles.fileMenuSep} role="separator" />
        </>,
        portalTarget,
      )
    : ownMenu;

  return (
    <div className={styles.assetStrip}>
      <SegmentedControl
        options={MEDIUM_OPTIONS}
        selected={medium}
        onSelect={onMediumChange}
        ariaLabel="Asset medium"
      />

      {/* The pixel editor portals its compact controls in here, so page / size /
          coverage / zoom / brush sit on the medium toggle's line. */}
      {medium === "pixels" && <div ref={controlsRef} className={styles.assetStripExtras} />}

      <div
        className={styles.assetList}
        role="tablist"
        aria-label="Assets"
        // Dropping past the last chip appends; without this the gap at the end of
        // the row rejects the drop and the drag silently does nothing.
        onDragOver={(event) => {
          if (!dragging) return;
          event.preventDefault();
          setDropBefore(null);
        }}
        onDrop={(event) => {
          if (!dragging) return;
          event.preventDefault();
          onReorder(dragging, dropBefore);
          endDrag();
        }}
      >
        {assets.length === 0 ? (
          <span className={styles.assetEmpty}>{emptyHint}</span>
        ) : (
          assets.map((asset) =>
            asset.id === renamingId ? (
              // Inline rename: a chip-shaped field over the thumbnail. Enter or
              // blur commits, Escape cancels — no OS dialog.
              <span
                key={asset.id}
                className={`${styles.assetChip} ${styles.assetChipEditing}`}
                data-asset={asset.id}
              >
                <AssetThumb asset={asset} sheet={sheet} version={version} />
                <input
                  className={styles.assetRenameInput}
                  value={draftName}
                  autoFocus
                  aria-label={`Rename ${asset.name}`}
                  onFocus={(event) => event.target.select()}
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                />
              </span>
            ) : (
              <button
                key={asset.id}
                type="button"
                role="tab"
                draggable
                data-asset={asset.id}
                className={[
                  styles.assetChip,
                  asset.id === activeId ? styles.assetChipActive : "",
                  asset.id === dragging ? styles.assetChipDragging : "",
                  dropBefore === asset.id && dragging !== asset.id ? styles.assetChipDropBefore : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-selected={asset.id === activeId}
                onClick={() => onSelect(asset.id)}
                onDoubleClick={() => startRename(asset.id)}
                onDragStart={(event) => {
                  setDragging(asset.id);
                  event.dataTransfer.effectAllowed = "move";
                  // Firefox ignores a drag that carries no data at all.
                  event.dataTransfer.setData("text/plain", asset.id);
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setDropBefore(asset.id);
                }}
                onDrop={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onReorder(dragging, asset.id);
                  endDrag();
                }}
                title={`${asset.name} — double-click to rename, drag to reorder`}
              >
                <AssetThumb asset={asset} sheet={sheet} version={version} />
                {asset.name}
              </button>
            ),
          )
        )}
      </div>

      {/* With a provider the actions portal into the workbench menu, so nothing
          lands here — the wrapper (and its gap in the strip) would only be an
          empty box, so the portal is rendered on its own instead. The wrapper
          stays for the standalone menu. */}
      {overflowSlot ? assetActions : <div className={styles.assetActions}>{assetActions}</div>}
    </div>
  );
}
