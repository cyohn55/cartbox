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

import { useState } from "react";
import type { SpriteSheet } from "@cartbox/editor";

import type { CartAsset } from "@/lib/cartAssets";

import { AssetThumb } from "./AssetThumb";
import styles from "./editor.module.css";
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
  onRename: (id: string) => void;
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

  return (
    <div className={styles.assetStrip}>
      <SegmentedControl
        options={MEDIUM_OPTIONS}
        selected={medium}
        onSelect={onMediumChange}
        ariaLabel="Asset medium"
      />

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
          assets.map((asset) => (
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
              onDoubleClick={() => onRename(asset.id)}
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
          ))
        )}
      </div>

      <div className={styles.assetActions}>
        <button type="button" className="cbx-btn" onClick={onCreate} title="Create a new asset in this medium">
          New
        </button>
        {onBrowseLibrary && (
          <button
            type="button"
            className="cbx-btn"
            onClick={onBrowseLibrary}
            title="Insert a ready-made asset from the library"
          >
            Library
          </button>
        )}
        <button
          type="button"
          className="cbx-btn"
          onClick={() => active && onRename(active.id)}
          disabled={!active}
          title={active ? `Rename “${active.name}”` : "Select an asset to rename it"}
        >
          Rename
        </button>
        <button
          type="button"
          className="cbx-btn"
          onClick={() => active && onDuplicate(active.id)}
          disabled={!active}
          title={active ? `Duplicate “${active.name}”` : "Select an asset to duplicate it"}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="cbx-btn"
          onClick={() => active && onDelete(active.id)}
          disabled={!active}
          title={active ? `Delete “${active.name}”` : "Select an asset to delete it"}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
