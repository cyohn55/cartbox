"use client";

/**
 * Baked lighting in the Mesh tab (HALO2_STYLE_ROADMAP.md, H1): bake light maps
 * for the scene's still objects — soft shade in corners and under overhangs,
 * and sunlight bounced off nearby surfaces — which every renderer multiplies
 * into the ambient and sky light. See lightmap.ts in @cartbox/editor and
 * lightBake.ts.
 */

import { useState } from "react";

import { bakeSceneLighting, clearSceneLighting, lightingStats } from "@/lib/lightBake";
import type { MeshSidecar } from "@/lib/meshSidecar";
import { RailGroup, RailHint, RangeControl } from "./railControls";

export function LightingBakePanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const [density, setDensity] = useState(4);
  const [rays, setRays] = useState(48);
  const [distance, setDistance] = useState(7);
  const [probeSpacing, setProbeSpacing] = useState(2.5);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stats = lightingStats(sidecar);
  const bake = async () => {
    setError(null);
    setProgress(0);
    try {
      onChange(await bakeSceneLighting(sidecar, { density, rays, distance, probeSpacing }, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };
  const baking = progress !== null;
  return (
    <RailGroup label="Baked lighting" advanced>
      <RangeControl label="Detail" nested min={1} max={12} step={1} value={density} onChange={setDensity} ariaLabel="Light map texels per unit" display={`${density}/unit`} />
      <RangeControl label="Quality" nested min={16} max={128} step={16} value={rays} onChange={setRays} ariaLabel="Light bake rays per texel" display={`${rays} rays`} />
      <RangeControl label="Shade reach" nested min={1} max={20} step={0.5} value={distance} onChange={setDistance} ariaLabel="Light bake shade distance" display={distance.toFixed(1)} />
      <RangeControl label="Light probes" nested min={0} max={8} step={0.5} value={probeSpacing} onChange={setProbeSpacing} ariaLabel="Light probe spacing" display={probeSpacing > 0 ? `every ${probeSpacing.toFixed(1)}` : "none"} />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button type="button" className="cbx-btn" onClick={() => void bake()} disabled={baking || stats.still === 0}>
          {baking ? `Baking… ${Math.round((progress ?? 0) * 100)}%` : stats.baked > 0 ? "Rebake lighting" : "Bake lighting"}
        </button>
        {stats.baked > 0 && !baking && (
          <button type="button" className="cbx-btn" onClick={() => onChange(clearSceneLighting(sidecar))}>
            Clear
          </button>
        )}
      </div>
      {error && <RailHint>{error}</RailHint>}
      <RailHint>
        {stats.baked > 0
          ? `${stats.baked} of ${stats.still} still objects carry baked light${stats.probes > 0 ? `, and ${stats.probes} light probes light what moves among them` : ""}. Rebake after moving them or changing the sun.`
          : "Bakes soft shade into corners, under overhangs and between nearby objects, plus sunlight bounced off bright surfaces, for everything that doesn't move — and a grid of light probes, so moving objects darken in the shade and pick up the bounce too."}
      </RailHint>
    </RailGroup>
  );
}
