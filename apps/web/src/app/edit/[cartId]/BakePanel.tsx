"use client";

/**
 * Texture baking in the Mesh tab (HALO_INFINITE_STYLE_ROADMAP.md I15): bake a
 * mesh's ambient occlusion, curvature and thickness into its occlusion and
 * relief maps (see textureBake.ts in @cartbox/editor), which feed the material
 * graph's Occlusion, Curvature and Thickness inputs and its wear masks. A mesh
 * without texture coordinates is given a unique layout first.
 *
 * High-to-low (AAA_FIDELITY_ROADMAP.md F9a): with a detailed source mesh
 * loaded (OBJ or GLB), the same panel bakes its normals, occlusion, curvature,
 * thickness, height, position and IDs onto this mesh's texture space
 * (highToLowBake.ts), by ray distances or a cage.
 */

import { useEffect, useMemo, useState } from "react";

import { bakeHighToLow, bakeSurfaceMaps, meshBounds, parseGlb, parseObj, type BakedMaps, type DecodedTexture, type HighToLowMaps, type MeshAsset } from "@cartbox/editor";

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

/** A map's colour as a data URL, for a thumbnail. */
function rgbUrl(t: DecodedTexture): string {
  const canvas = document.createElement("canvas");
  canvas.width = t.width;
  canvas.height = t.height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(t.width, t.height);
  image.data.set(t.data);
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
  // High-to-low (F9a): the detailed source, and how far rays reach above and below this mesh to find it.
  const [high, setHigh] = useState<MeshAsset | null>(null);
  const [front, setFront] = useState(+(extent * 0.02).toFixed(3));
  const [back, setBack] = useState(+(extent * 0.02).toFixed(3));
  const [highMaps, setHighMaps] = useState<HighToLowMaps | null>(null);
  const loadHigh = async (file: File) => {
    try {
      const lower = file.name.toLowerCase();
      const mesh = lower.endsWith(".glb") ? parseGlb(new Uint8Array(await file.arrayBuffer()), file.name) : parseObj(await file.text());
      setHigh(mesh);
      const triangles = mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
      setNote(`Loaded ${file.name}: ${triangles.toLocaleString()} triangles.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const bakeFromHigh = () => {
    if (!high) return;
    setBusy(true);
    setNote("Baking from the high mesh…");
    setTimeout(() => {
      try {
        const start = performance.now();
        const out = bakeHighToLow(mesh, high, { size, rays: Math.min(rays, 32), front, back, aoDistance, thicknessDistance, curvatureRadius });
        setHighMaps(out.maps[0] ?? null);
        onBaked(out.mesh);
        const missed = out.maps.reduce((worst, m) => Math.max(worst, 1 - m.coverage), 0);
        setNote(`Baked ${out.maps.length} set${out.maps.length === 1 ? "" : "s"} in ${((performance.now() - start) / 1000).toFixed(1)} s${missed > 0.01 ? `; ${(missed * 100).toFixed(0)}% of texels found nothing (widen the ray reach)` : ""}.`);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }, 20);
  };
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
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 12 }} title="A detailed mesh to bake onto this one (OBJ or GLB), in the same place">
          High mesh <input type="file" accept=".obj,.glb" aria-label="High-poly source mesh" onChange={(e) => e.target.files?.[0] && void loadHigh(e.target.files[0])} />
        </label>
        {number("Ray front", front, setFront, "How far above this mesh's surface rays start looking for the high mesh (world units)")}
        {number("Ray back", back, setBack, "How far below it they keep looking (world units)")}
      </div>
      <button type="button" onClick={bakeFromHigh} disabled={busy || !high}>
        Bake normals and maps from the high mesh
      </button>
      {highMaps && (
        <div style={{ display: "flex", gap: 6 }} aria-label="High-to-low maps">
          {[
            ["Normal", highMaps.normal, -1],
            ["Height", highMaps.relief, 0],
            ["ID", highMaps.id, -1],
          ].map(([label, t, c]) => (
            <figure key={label as string} style={{ margin: 0, textAlign: "center", fontSize: 11 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={(c as number) < 0 ? rgbUrl(t as DecodedTexture) : channelUrl(t as DecodedTexture, c as number)} alt={`${label as string} map`} width={64} height={64} style={{ imageRendering: "pixelated", borderRadius: 4 }} />
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
