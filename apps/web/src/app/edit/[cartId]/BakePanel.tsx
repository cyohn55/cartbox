"use client";

/**
 * Texture baking in the Mesh tab (HALO_INFINITE_STYLE_ROADMAP.md I15): bake a
 * mesh's ambient occlusion, curvature and thickness into its occlusion and
 * relief maps (see textureBake.ts in @cartbox/editor), which feed the material
 * graph's Occlusion, Curvature and Thickness inputs and its wear masks. A mesh
 * without texture coordinates is given a unique layout first.
 */

import { useEffect, useMemo, useState } from "react";

import { bakeSurfaceMaps, meshBounds, type BakedMaps, type DecodedTexture, type MeshAsset } from "@cartbox/editor";

import { RailGroup, RailHint } from "./railControls";

const SIZES = [64, 128, 256, 512] as const;
const field: React.CSSProperties = { width: 64, padding: "4px 6px", borderRadius: 6 };

/** One channel of a map as a grey data URL, for a thumbnail. */
function channelUrl(t: DecodedTexture, channel: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = t.width;
  canvas.height = t.height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(t.width, t.height);
  for (let i = 0; i < t.width * t.height; i += 1) {
    const v = t.data[i * 4 + channel]!;
    image.data.set([v, v, v, 255], i * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function BakePanel({ mesh, onBaked }: { mesh: MeshAsset; onBaked: (next: MeshAsset) => void }) {
  const extent = useMemo(() => {
    const b = meshBounds(mesh);
    return b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1 : 1;
  }, [mesh]);
  const [size, setSize] = useState<number>(256);
  const [rays, setRays] = useState(32);
  const [aoDistance, setAoDistance] = useState(+(extent / 4).toFixed(2));
  const [thicknessDistance, setThicknessDistance] = useState(+(extent / 5).toFixed(2));
  const [curvatureRadius, setCurvatureRadius] = useState(+(extent / 100).toFixed(3));
  const [busy, setBusy] = useState(false);
  const [baked, setBaked] = useState<readonly BakedMaps[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A new mesh: fresh defaults, no stale thumbnails.
  useEffect(() => {
    setAoDistance(+(extent / 4).toFixed(2));
    setThicknessDistance(+(extent / 5).toFixed(2));
    setCurvatureRadius(+(extent / 100).toFixed(3));
  }, [extent]);
  const bake = () => {
    setBusy(true);
    setNote("Baking…");
    // Let the note paint before the (synchronous) bake runs.
    setTimeout(() => {
      try {
        const start = performance.now();
        const out = bakeSurfaceMaps(mesh, { size, rays, aoDistance, thicknessDistance, curvatureRadius });
        setBaked(out.maps);
        onBaked(out.mesh);
        setNote(`Baked ${out.maps.length} map pair${out.maps.length === 1 ? "" : "s"} in ${((performance.now() - start) / 1000).toFixed(1)} s.`);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }, 20);
  };
  const number = (label: string, value: number, set: (v: number) => void, title: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }} title={title}>
      {label}
      <input type="number" step={0.01} min={0.001} value={value} onChange={(e) => set(Math.max(0.001, Number(e.target.value) || 0.001))} style={field} aria-label={label} />
    </label>
  );
  return (
    <RailGroup label="Bake maps">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 12 }}>
          Size{" "}
          <select aria-label="Bake size" value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}²
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Rays{" "}
          <select aria-label="Bake rays" value={rays} onChange={(e) => setRays(Number(e.target.value))}>
            {[16, 32, 64, 128].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {number("Occlusion reach", aoDistance, setAoDistance, "How far away something still darkens a point (world units)")}
        {number("Thickness reach", thicknessDistance, setThicknessDistance, "How thick reads as solid (world units)")}
        {number("Edge width", curvatureRadius, setCurvatureRadius, "How far an edge's curvature spreads across the surface (world units)")}
      </div>
      <button type="button" onClick={bake} disabled={busy}>
        {busy ? "Baking…" : "Bake occlusion, curvature and thickness"}
      </button>
      {baked && baked[0] && (
        <div style={{ display: "flex", gap: 6 }} aria-label="Baked maps">
          {[
            ["Occlusion", baked[0].occlusion, 0],
            ["Curvature", baked[0].relief, 1],
            ["Thinness", baked[0].relief, 2],
          ].map(([label, t, c]) => (
            <figure key={label as string} style={{ margin: 0, textAlign: "center", fontSize: 11 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={channelUrl(t as DecodedTexture, c as number)} alt={`${label as string} map`} width={64} height={64} style={{ imageRendering: "pixelated", borderRadius: 4 }} />
              <figcaption>{label as string}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {note && <RailHint>{note}</RailHint>}
      <RailHint>Feeds the graph&apos;s Occlusion, Curvature and Thickness inputs and its wear masks; the occlusion also shades ambient light. A mesh without texture coordinates gets a unique layout.</RailHint>
    </RailGroup>
  );
}
