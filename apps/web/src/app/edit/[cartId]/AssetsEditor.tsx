"use client";

/**
 * The Assets tab: one place to author everything the cart's art is made of.
 *
 * Sprites and sculpts used to be two tabs, which made them look like two
 * unrelated tools. They are not — they are the same job in different mediums,
 * and they already reached into each other (the sprite editor previews its block
 * as a voxel extrusion; the sculptor embeds a pixel pad to draw the tiles that
 * skin it). This container makes that one surface: a medium switch, the cart's
 * named assets, and whichever editor the active medium needs.
 *
 * What lives here is exactly what must survive a medium switch:
 *
 * - the **active palette colour**, so picking a colour is picking it in both
 *   mediums rather than in one of two disconnected pickers;
 * - the **sprite selection** (page, tile, block size), because a named sprite
 *   asset is a coordinate into the sheet and something has to hold it;
 * - **which asset** is open.
 *
 * Everything else — tools, brush sizes, camera, lighting — stays in the editor it
 * belongs to, because none of it means anything in the other medium.
 */

import { useMemo, useState } from "react";
import {
  type MaterialMap,
  type MaterialSwatches,
  type NormalMap,
  type SpriteRig,
  type SpriteSheet,
} from "@cartbox/editor";

import {
  createAssetId,
  defaultAssetName,
  isSpriteBlockAsset,
  removeAsset,
  renameAsset,
  spriteBlockAssets,
  upsertAsset,
  SPRITE_BLOCK_KIND,
  VOXEL_GRID_KIND,
  type CartAsset,
  type SpriteBlockAsset,
} from "@/lib/cartAssets";
import { decodeVoxelSidecar, encodeVoxelSidecar, primaryVoxelAsset } from "@/lib/voxelSidecar";
import type { PendingVoxelEdit } from "@/lib/backdropPropsStore";

import styles from "./editor.module.css";
import { AssetStrip, type AssetMedium } from "./AssetStrip";
import {
  blockIdAt,
  resolveSculptId,
  sculptsForMedium,
  selectionForBlock,
  shapeForMedium,
} from "./assetSelection";
import { SpriteEditor, type SpriteSelection } from "./SpriteEditor";
import { VoxelEditor } from "./VoxelEditor";
import { seededGridPayload } from "./voxelSeed";

/** The block a new cart opens on — sprite 1, one tile square. */
const INITIAL_SELECTION: SpriteSelection = { page: 0, tile: 1, tilesPerSide: 1 };

/**
 * What an empty list means, which differs by medium.
 *
 * The 3D wording is deliberate: the sculptor always shows *something* — a fresh
 * model opens on a starting slab — but that slab is not saved, and so is not an
 * asset, until it is edited. Saying "no sculpts yet" while a model is plainly on
 * screen reads as a bug, so the hint says what is actually true.
 */
const EMPTY_HINT: Record<AssetMedium, string> = {
  pixels: "No named sprites yet — draw a block, then New to name it.",
  voxels: "Nothing saved yet — the model on screen is added once you edit it.",
  hexels: "Nothing saved yet — the model on screen is added once you edit it.",
};

interface AssetsEditorProps {
  sheet: SpriteSheet;
  normals: NormalMap;
  height: MaterialMap;
  specular: MaterialMap;
  roughness: MaterialMap;
  emissive: MaterialMap;
  swatches: MaterialSwatches;
  onSwatchesChange: (swatches: MaterialSwatches) => void;
  rig: SpriteRig;
  onRigChange: (rig: SpriteRig) => void;
  /** The cart's authoring payload — assets and the map's columns. */
  voxel: string | null;
  onVoxelChange: (payload: string) => void;
  /** The open bank. Sprite assets are coordinates into *its* sheet. */
  bank: number;
  /** Bumped by undo/redo and bank switches; remounts the editor below. */
  revision: number;
  /** A backdrop voxel prop handed over to re-sculpt, or null. */
  pendingVoxel?: PendingVoxelEdit | null;
}

export function AssetsEditor({
  sheet,
  normals,
  height,
  specular,
  roughness,
  emissive,
  swatches,
  onSwatchesChange,
  rig,
  onRigChange,
  voxel,
  onVoxelChange,
  bank,
  revision,
  pendingVoxel = null,
}: AssetsEditorProps) {
  const sidecar = useMemo(() => decodeVoxelSidecar(voxel), [voxel]);
  const assets = sidecar.assets;

  // A prop handed over from the backdrop manager is a sculpt, so open on it.
  const [medium, setMedium] = useState<AssetMedium>(pendingVoxel ? "voxels" : "pixels");
  const [selection, setSelection] = useState<SpriteSelection>(INITIAL_SELECTION);
  const [color, setColor] = useState(1);
  const [activeVoxelId, setActiveVoxelId] = useState<string | null>(null);

  const shape = shapeForMedium(medium);
  const sculptsOfShape = useMemo(() => sculptsForMedium(assets, medium), [assets, medium]);
  const blocksOfBank = useMemo(() => spriteBlockAssets(assets, bank), [assets, bank]);

  const resolvedVoxelId = resolveSculptId(sculptsOfShape, activeVoxelId);
  const visibleAssets: readonly CartAsset[] = medium === "pixels" ? blocksOfBank : sculptsOfShape;
  const activeId = medium === "pixels" ? blockIdAt(blocksOfBank, selection) : resolvedVoxelId;

  /** Write an asset list back to the cart (feeds the undo timeline and the save). */
  const commitAssets = (next: readonly CartAsset[]) =>
    onVoxelChange(encodeVoxelSidecar({ ...sidecar, assets: next }));

  const selectAsset = (id: string) => {
    const asset = assets.find((entry) => entry.id === id);
    if (!asset) return;
    if (isSpriteBlockAsset(asset)) {
      // Selecting a sprite asset moves the editor to the block it names.
      setSelection(selectionForBlock(asset));
      return;
    }
    setActiveVoxelId(asset.id);
  };

  const createAsset = () => {
    if (medium === "pixels") {
      // A sprite asset names wherever the editor already is; there is nothing to
      // create in the sheet, since the pixels exist whether or not they have a name.
      const named: SpriteBlockAsset = {
        kind: SPRITE_BLOCK_KIND,
        id: createAssetId(),
        name: defaultAssetName(SPRITE_BLOCK_KIND, assets),
        bank,
        page: selection.page,
        tile: selection.tile,
        tilesPerSide: selection.tilesPerSide,
      };
      commitAssets(upsertAsset(assets, named));
      return;
    }

    // A sculpt needs a body to exist at all, so it is created seeded — the same
    // starting slab opening a fresh sculpt gives you.
    const id = createAssetId();
    commitAssets(
      upsertAsset(assets, {
        kind: VOXEL_GRID_KIND,
        id,
        name: defaultAssetName(VOXEL_GRID_KIND, assets),
        grid: seededGridPayload(shape ?? "cube"),
        spriteMaterials: [],
      }),
    );
    setActiveVoxelId(id);
  };

  const promptRename = (id: string) => {
    const asset = assets.find((entry) => entry.id === id);
    if (!asset) return;
    const name = window.prompt(`Rename “${asset.name}”`, asset.name);
    if (name === null) return;
    commitAssets(renameAsset(assets, id, name));
  };

  const confirmDelete = (id: string) => {
    const asset = assets.find((entry) => entry.id === id);
    if (!asset) return;
    const warning = isSpriteBlockAsset(asset)
      ? `Forget “${asset.name}”? The pixels stay on the sheet — only the name goes.`
      : `Delete “${asset.name}”? The sculpt is deleted with it.`;
    if (!window.confirm(warning)) return;
    if (activeVoxelId === id) setActiveVoxelId(null);
    commitAssets(removeAsset(assets, id));
  };

  const switchMedium = (next: AssetMedium) => {
    setMedium(next);
    // Leave the voxel selection to resolve itself against the new lattice: the
    // fallback picks that medium's first sculpt, so a stale id never sticks.
    if (next !== "pixels") setActiveVoxelId(null);
  };

  return (
    // One grid item, not two: the workbench's rows are `52px 1fr`, so a tab that
    // added a second child would take the body's row and squash the editor.
    <div className={styles.assetsPane}>
      <AssetStrip
        medium={medium}
        onMediumChange={switchMedium}
        assets={visibleAssets}
        activeId={activeId}
        onSelect={selectAsset}
        onCreate={createAsset}
        onRename={promptRename}
        onDelete={confirmDelete}
        emptyHint={EMPTY_HINT[medium]}
      />

      {medium === "pixels" ? (
        <SpriteEditor
          key={`sprites:${bank}:${revision}`}
          sheet={sheet}
          normals={normals}
          height={height}
          specular={specular}
          roughness={roughness}
          emissive={emissive}
          swatches={swatches}
          onSwatchesChange={onSwatchesChange}
          rig={rig}
          onRigChange={onRigChange}
          selection={selection}
          onSelectionChange={setSelection}
          color={color}
          onColorChange={setColor}
        />
      ) : (
        // Keyed on the sculpt and the lattice: the sculptor seeds its grid once on
        // mount, so switching asset or medium has to be a remount, not a re-render.
        <VoxelEditor
          key={`voxel:${medium}:${resolvedVoxelId ?? "primary"}:${bank}:${revision}`}
          sheet={sheet}
          model={voxel}
          onModelChange={onVoxelChange}
          assetId={resolvedVoxelId}
          pendingEdit={pendingVoxel}
          color={color}
          onColorChange={setColor}
        />
      )}
    </div>
  );
}

/** Whether a cart has a sculpt at all — used to open on the right medium. */
export function hasSculpt(payload: string | null): boolean {
  return primaryVoxelAsset(decodeVoxelSidecar(payload)) !== null;
}
