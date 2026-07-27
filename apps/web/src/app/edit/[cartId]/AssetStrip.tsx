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

import type { CartAsset } from "@/lib/cartAssets";

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
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  /** Copy explaining what an unnamed medium means, shown when the list is empty. */
  emptyHint: string;
}

export function AssetStrip({
  medium,
  onMediumChange,
  assets,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  emptyHint,
}: AssetStripProps) {
  const active = assets.find((asset) => asset.id === activeId) ?? null;

  return (
    <div className={styles.assetStrip}>
      <SegmentedControl
        options={MEDIUM_OPTIONS}
        selected={medium}
        onSelect={onMediumChange}
        ariaLabel="Asset medium"
      />

      <div className={styles.assetList} role="tablist" aria-label="Assets">
        {assets.length === 0 ? (
          <span className={styles.assetEmpty}>{emptyHint}</span>
        ) : (
          assets.map((asset) => (
            <button
              key={asset.id}
              type="button"
              role="tab"
              className={`${styles.assetChip} ${asset.id === activeId ? styles.assetChipActive : ""}`}
              aria-selected={asset.id === activeId}
              onClick={() => onSelect(asset.id)}
              onDoubleClick={() => onRename(asset.id)}
              title={`${asset.name} — double-click to rename`}
            >
              {asset.name}
            </button>
          ))
        )}
      </div>

      <div className={styles.assetActions}>
        <button type="button" className="cbx-btn" onClick={onCreate} title="Create a new asset in this medium">
          New
        </button>
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
