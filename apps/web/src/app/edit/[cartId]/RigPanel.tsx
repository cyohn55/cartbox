"use client";

/**
 * RigPanel — authors a segmented-character rig from the cart's own sprites. The
 * user assigns the currently selected sprite block to a named part and sets its
 * depth; the panel composites those parts through the layered-scene preview, so
 * a flat sprite set gains pseudo-3D volume under pan and yaw. Rig state lives
 * here for the session (preview-only, not yet persisted to the cart).
 */

import { useMemo, useState } from "react";
import {
  spriteRigToPlanes,
  upsertRigPart,
  removeRigPart,
  findSpriteRigPart,
  RIG_PART_TEMPLATES,
  DEFAULT_RIG_UNITS_PER_PIXEL,
  type SpriteRig,
  type SpriteSheet,
  type SpritePage,
} from "@cartbox/editor";

import { LayeredSceneView } from "./LayeredSceneView";

interface RigPanelProps {
  sheet: SpriteSheet;
  /** The sprite currently selected in the editor, offered for assignment. */
  page: SpritePage;
  tile: number;
  blockTiles: number;
  /** Bumps when pixels change, so the preview re-reads the blocks. */
  version: number;
  /** Controlled rig state, owned by the workbench so Save can persist it. */
  rig: SpriteRig;
  onRigChange: (rig: SpriteRig) => void;
}

const DEPTH_RANGE = 8;

export function RigPanel({ sheet, page, tile, blockTiles, version, rig, onRigChange }: RigPanelProps) {
  const firstTemplate = RIG_PART_TEMPLATES[0]?.name ?? "torso";
  const [target, setTarget] = useState<string>(firstTemplate);

  // Re-read the blocks whenever the rig or the sprite pixels change.
  const planes = useMemo(
    () => spriteRigToPlanes(sheet, rig),
    // `version` is intentionally a dependency: pixel edits must refresh planes.
    [sheet, rig, version],
  );

  const assignSelected = () => {
    const template = RIG_PART_TEMPLATES.find((entry) => entry.name === target);
    const existing = findSpriteRigPart(rig, target);
    onRigChange(
      upsertRigPart(rig, {
        name: target,
        page,
        baseTile: tile,
        blockTiles,
        // Keep an already-tuned depth when reassigning a part's sprite.
        depthOffset: existing?.depthOffset ?? template?.depthOffset ?? 0,
        offsetX: 0,
        offsetY: 0,
        unitsPerPixel: DEFAULT_RIG_UNITS_PER_PIXEL,
      }),
    );
  };

  const setDepth = (name: string, depthOffset: number) => {
    const part = findSpriteRigPart(rig, name);
    if (!part) return;
    onRigChange(upsertRigPart(rig, { ...part, depthOffset }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          Assign sprite #{tile.toString().padStart(3, "0")} ({blockTiles}×{blockTiles}) to
        </span>
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          {RIG_PART_TEMPLATES.map((template) => (
            <option key={template.name} value={template.name}>
              {template.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={assignSelected}>
          {findSpriteRigPart(rig, target) ? "Update part" : "Add part"}
        </button>
      </div>

      {rig.parts.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
          Assign sprites to parts (cape, back arm, torso, head, fore arm) to build a rig. Each part
          gets its own depth, so it shifts by that depth as the camera pans or yaws.
        </p>
      ) : (
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {rig.parts.map((part) => (
              <li key={part.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 64 }}>{part.name}</span>
                <span className="data" style={{ width: 60, color: "var(--muted)" }}>
                  #{part.baseTile.toString().padStart(3, "0")} {part.blockTiles}×{part.blockTiles}
                </span>
                <input
                  type="range"
                  min={-DEPTH_RANGE}
                  max={DEPTH_RANGE}
                  step={0.5}
                  value={part.depthOffset}
                  onChange={(event) => setDepth(part.name, Number(event.target.value))}
                  style={{ flex: 1 }}
                  title="Depth (negative = toward camera)"
                />
                <span className="data" style={{ width: 34, textAlign: "right" }}>
                  {part.depthOffset.toFixed(1)}
                </span>
                <button type="button" onClick={() => onRigChange(removeRigPart(rig, part.name))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <LayeredSceneView planes={planes} pivotDepth={rig.pivotDepth} viewWidth={200} viewHeight={150} displayScale={2} />
        </>
      )}
    </div>
  );
}
