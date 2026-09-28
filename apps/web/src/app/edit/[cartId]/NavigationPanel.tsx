"use client";

/**
 * Navigation in the Mesh tab (ENGINE_ROADMAP.md, Phase 6): bake the scene's
 * walkable surface for a body of a given size, so characters the cart turns
 * into agents (cartbox.agent / cartbox.moveto) find their own way round the map.
 * See navmesh.ts in @cartbox/editor and navmeshBake.ts.
 */

import { useState } from "react";

import { DEFAULT_NAV_AGENT, readNavMesh, type NavAgent } from "@cartbox/editor";

import { setMeshNavMesh, type MeshSidecar } from "@/lib/meshSidecar";
import { bakeSceneNavMesh } from "@/lib/navmeshBake";
import { RailGroup, RailHint, RangeControl } from "./railControls";

export function NavigationPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const stored = sidecar.navmesh ? readNavMesh(sidecar.navmesh) : null;
  const [agent, setAgent] = useState<NavAgent>(() => stored?.agent ?? DEFAULT_NAV_AGENT);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof NavAgent) => (value: number) => setAgent((a) => ({ ...a, [key]: value }));
  const bake = () => {
    try {
      const { mesh, stored: next } = bakeSceneNavMesh(sidecar, agent);
      setError(mesh.heights.length === 0 ? "Nothing to walk on: the scene has no flat surface for a body this size." : null);
      onChange(setMeshNavMesh(sidecar, mesh.heights.length > 0 ? next : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <RailGroup label="Navigation" advanced>
      <RangeControl label="Body radius" nested min={0.1} max={2} step={0.05} value={agent.radius} onChange={set("radius")} ariaLabel="Agent radius" display={agent.radius.toFixed(2)} />
      <RangeControl label="Body height" nested min={0.5} max={4} step={0.1} value={agent.height} onChange={set("height")} ariaLabel="Agent height" display={agent.height.toFixed(1)} />
      <RangeControl label="Step up" nested min={0} max={1.5} step={0.05} value={agent.climb} onChange={set("climb")} ariaLabel="Agent step height" display={agent.climb.toFixed(2)} />
      <RangeControl label="Steepest slope" nested min={5} max={80} step={1} value={agent.maxSlope} onChange={set("maxSlope")} ariaLabel="Agent max slope" display={`${agent.maxSlope}°`} />
      <RangeControl label="Drop down" nested min={0} max={12} step={0.5} value={agent.maxDrop} onChange={set("maxDrop")} ariaLabel="Agent max drop" display={agent.maxDrop.toFixed(1)} />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button type="button" className="cbx-btn" onClick={bake}>
          {stored ? "Rebake" : "Bake navigation"}
        </button>
        {stored && (
          <button type="button" className="cbx-btn" onClick={() => onChange(setMeshNavMesh(sidecar, null))}>
            Clear
          </button>
        )}
      </div>
      {error && <RailHint>{error}</RailHint>}
      <RailHint>
        {stored
          ? `Baked: ${stored.heights.length.toLocaleString()} walkable cells, ${(stored.drops.length / 2).toLocaleString()} drop-offs. Rebake after moving the level's geometry.`
          : "Bake a walkable surface from the scene's still objects. In code, cartbox.agent(key, x, y, z) places a character and cartbox.moveto(key, x, y, z) sends it: it finds its own way, keeps clear of other agents, and cartbox.agentpos(key) says where it got to."}
      </RailHint>
    </RailGroup>
  );
}
