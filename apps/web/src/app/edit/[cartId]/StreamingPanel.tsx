"use client";

/**
 * Spatial loading in the Mesh tab (ENGINE_ROADMAP.md, Phase 4): for a big
 * single map, load objects by distance from the camera (or the point the cart
 * sets with cartbox.streamfocus) instead of all at once. See streaming.ts in
 * @cartbox/editor.
 */

import { DEFAULT_STREAM_RANGE, MAX_STREAM_RANGE, MIN_STREAM_RANGE } from "@cartbox/editor";

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
      <RailHint>
        {streaming
          ? `${counts.spatial} object${counts.spatial === 1 ? "" : "s"} load within ${streaming.range} units of the camera; ${counts.always} always loaded. A published cart fetches each one's textures as you approach. In code, cartbox.streamfocus(x, y, z) loads around the player instead of the camera.`
          : "For a big single map: objects draw and simulate only while the camera is near them, and their textures download as it approaches. Objects in levels load with their level."}
      </RailHint>
    </RailGroup>
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
          ? "Drawn and simulated however far away (use it for things that move across the map, like the player)."
          : "Loads while the camera is within range of it (its children come with it)."}
      </RailHint>
    </RailGroup>
  );
}
