"use client";

/**
 * Spatial loading in the Mesh tab (ENGINE_ROADMAP.md, Phase 4): for a big
 * single map, load objects by distance from the camera (or the point the cart
 * sets with cartbox.streamfocus) instead of all at once. See streaming.ts in
 * @cartbox/editor.
 */

import { useMemo, useState } from "react";

import { DEFAULT_CELL_SIZE, DEFAULT_STREAM_RANGE, MAX_STREAM_RANGE, MIN_CELL_SIZE, MIN_STREAM_RANGE } from "@cartbox/editor";

import { cellStates, sidecarCells } from "@/lib/worldPartitionView";
import { setMeshAlwaysLoaded, setMeshStreaming, type MeshSidecar, type MeshSidecarEntry } from "@/lib/meshSidecar";
import { RailGroup, RailHint, RangeControl } from "./railControls";

/** Objects that load by distance, and those kept loaded, when streaming is on. */
function streamCounts(sidecar: MeshSidecar): { spatial: number; always: number } {
  let spatial = 0;
  let always = 0;
  for (const m of sidecar.meshes) {
    if (m.parent || m.level) continue; // children load with their parent; levels load themselves
    if (m.alwaysLoaded) always += 1;
    else spatial += 1;
  }
  return { spatial, always };
}

export function StreamingPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const streaming = sidecar.streaming ?? null;
  const counts = streamCounts(sidecar);
  return (
    <RailGroup label="Streaming" advanced>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <input
          type="checkbox"
          aria-label="Load objects by distance"
          checked={streaming !== null}
          onChange={(event) => onChange(setMeshStreaming(sidecar, event.target.checked ? { range: DEFAULT_STREAM_RANGE } : null))}
        />
        Load objects by distance
      </label>
      {streaming && (
        <RangeControl
          label="Loading range"
          nested
          min={MIN_STREAM_RANGE}
          max={Math.min(MAX_STREAM_RANGE, 500)}
          step={5}
          value={streaming.range}
          onChange={(range) => onChange(setMeshStreaming(sidecar, { range }))}
          ariaLabel="Streaming loading range"
          display={`${streaming.range}`}
        />
      )}
      {streaming && (
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input
            type="checkbox"
            aria-label="Load by grid cells"
            checked={streaming.cell !== undefined}
            onChange={(event) => onChange(setMeshStreaming(sidecar, { range: streaming.range, ...(event.target.checked ? { cell: DEFAULT_CELL_SIZE } : {}) }))}
          />
          Load by grid cells (world partition)
        </label>
      )}
      {streaming?.cell !== undefined && (
        <RangeControl
          label="Cell size"
          nested
          min={MIN_CELL_SIZE}
          max={256}
          step={8}
          value={streaming.cell}
          onChange={(cell) => onChange(setMeshStreaming(sidecar, { range: streaming.range, cell }))}
          ariaLabel="World partition cell size"
          display={`${streaming.cell}`}
        />
      )}
      {streaming?.cell !== undefined && <WorldPartitionMap sidecar={sidecar} range={streaming.range} cell={streaming.cell} />}
      <RailHint>
        {streaming
          ? `${counts.spatial} object${counts.spatial === 1 ? "" : "s"} load within ${streaming.range} units of the camera; ${counts.always} always loaded. A published cart fetches each one's textures as you approach. In code, cartbox.streamfocus(x, y, z) loads around the player instead of the camera.`
          : "For a big single map: objects draw and simulate only while the camera is near them, and their textures download as it approaches. Objects in levels load with their level."}
      </RailHint>
    </RailGroup>
  );
}

const STATE_FILL = { loaded: "var(--accent, #4a8)", held: "color-mix(in srgb, var(--accent, #4a8) 45%, transparent)", out: "var(--surface-2, #333)" } as const;

/**
 * The world partition (F6d), from above: the scene's cells on the ground
 * plane, shaded by what would be loaded with the focus where you click (the
 * scene's centre to start), each labelled with its objects.
 */
function WorldPartitionMap({ sidecar, range, cell }: { sidecar: MeshSidecar; range: number; cell: number }) {
  const cells = useMemo(() => sidecarCells(sidecar, cell), [sidecar, cell]);
  const bounds = useMemo(() => {
    if (cells.length === 0) return null;
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of cells) {
      x0 = Math.min(x0, c.i * cell);
      z0 = Math.min(z0, c.j * cell);
      x1 = Math.max(x1, (c.i + 1) * cell);
      z1 = Math.max(z1, (c.j + 1) * cell);
    }
    return { x0, z0, x1, z1 };
  }, [cells, cell]);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  if (!bounds) return <RailHint>No objects load by distance yet.</RailHint>;
  const at: [number, number] = focus ?? [(bounds.x0 + bounds.x1) / 2, (bounds.z0 + bounds.z1) / 2];
  const states = cellStates(cells, range, at);
  const w = bounds.x1 - bounds.x0;
  const h = bounds.z1 - bounds.z0;
  const loaded = states.filter((s) => s === "loaded").length;
  return (
    <div>
      <svg
        viewBox={`${bounds.x0} ${bounds.z0} ${w} ${h}`}
        style={{ width: "100%", aspectRatio: `${w} / ${h}`, maxHeight: 220, cursor: "crosshair", background: "var(--surface-1, #222)", borderRadius: 4 }}
        role="img"
        aria-label="World partition cells"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setFocus([bounds.x0 + ((event.clientX - box.left) / box.width) * w, bounds.z0 + ((event.clientY - box.top) / box.height) * h]);
        }}
      >
        {cells.map((c, k) => (
          <g key={`${c.i},${c.j}`}>
            <rect x={c.i * cell} y={c.j * cell} width={cell} height={cell} fill={STATE_FILL[states[k]!]} stroke="var(--border, #555)" strokeWidth={cell * 0.02} />
            <text x={(c.i + 0.5) * cell} y={(c.j + 0.5) * cell} fontSize={cell * 0.28} textAnchor="middle" dominantBaseline="central" fill="currentColor">
              {c.members.length}
            </text>
          </g>
        ))}
        <circle cx={at[0]} cy={at[1]} r={range} fill="none" stroke="currentColor" strokeDasharray={`${cell * 0.1}`} strokeWidth={cell * 0.02} />
        <circle cx={at[0]} cy={at[1]} r={cell * 0.06} fill="currentColor" />
      </svg>
      <RailHint>
        {`${cells.length} cell${cells.length === 1 ? "" : "s"} of ${cell} units; ${loaded} loaded with the focus where you clicked. Each loads whole, nearest first, its textures decoded off the main thread, and gives its textures and geometry back when it leaves range.`}
      </RailHint>
    </div>
  );
}

/** Inspector: keep this object loaded however far away, when the scene streams. */
export function StreamingPicker({ sidecar, entry, onChange }: { sidecar: MeshSidecar; entry: MeshSidecarEntry; onChange: (next: MeshSidecar) => void }) {
  if (!sidecar.streaming || entry.parent || entry.level) return null;
  return (
    <RailGroup label="Streaming">
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <input
          type="checkbox"
          aria-label="Always loaded"
          checked={entry.alwaysLoaded === true}
          onChange={(event) => onChange(setMeshAlwaysLoaded(sidecar, entry.id, event.target.checked))}
        />
        Always loaded
      </label>
      <RailHint>
        {entry.alwaysLoaded
          ? "Drawn and simulated however far away."
          : "Loads while the camera is within range of it — where it is now, if code or physics moves it (its children come with it)."}
      </RailHint>
    </RailGroup>
  );
}
