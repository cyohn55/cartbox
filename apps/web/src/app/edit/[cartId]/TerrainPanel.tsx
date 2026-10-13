"use client";

/**
 * Terrain tools in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP10): add a
 * terrain, pick a brush — raise, lower, smooth, flatten, noise, paint a layer,
 * cut or fill holes — and drag over the ground in the scene view, as Unity's
 * Terrain tools and Unreal's Landscape mode work. See terrainBrush.ts in
 * @cartbox/editor and terrainEdit.ts.
 */

import { useRef, useState } from "react";

import {
  FOLIAGE_PRESETS,
  MAX_EROSION_DROPLETS,
  MAX_VISTA_HAZE,
  exportHeightmap,
  foliageRandom,
  hydraulicErosion,
  importHeightmap,
  layerCopies,
  thermalErosion,
  type FoliageLayer,
  type FoliagePreset,
  type Terrain,
} from "@cartbox/editor";

import { addFoliage, foliageOn, removeFoliage, replaceFoliage } from "@/lib/foliageEdit";
import { type MeshSidecar } from "@/lib/meshSidecar";
import { addTerrain, findTerrain, removeTerrain, replaceTerrain, type TerrainBrushSettings, type TerrainTool } from "@/lib/terrainEdit";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl } from "./railControls";

/** What the Terrain panel has up: which terrain, which tool (null = select objects as usual), and the brush. */
export interface TerrainEditState extends TerrainBrushSettings {
  readonly id: string | null;
  readonly tool: TerrainTool | null;
}

export const INITIAL_TERRAIN_EDIT: TerrainEditState = { id: null, tool: null, radius: 4, strength: 0.5 };

const SCULPT: readonly { readonly op: "raise" | "lower" | "smooth" | "flatten" | "noise"; readonly label: string; readonly glyph: string; readonly hint: string }[] = [
  { op: "raise", label: "Raise", glyph: "▲", hint: "Lift the ground under the brush" },
  { op: "lower", label: "Lower", glyph: "▼", hint: "Sink the ground under the brush" },
  { op: "smooth", label: "Smooth", glyph: "≈", hint: "Even out bumps and ridges" },
  { op: "flatten", label: "Flatten", glyph: "▬", hint: "Level the ground to the height where the stroke starts" },
  { op: "noise", label: "Noise", glyph: "⁂", hint: "Roughen the ground with bumps" },
];

/** A new vista's haze: a third of the sky shows through ground a kilometre out. */
const DEFAULT_VISTA_HAZE = 0.35;

const same = (a: TerrainTool | null, b: TerrainTool): boolean => JSON.stringify(a) === JSON.stringify(b);

const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export function TerrainPanel({
  sidecar,
  onChange,
  edit,
  onEdit,
}: {
  sidecar: MeshSidecar;
  onChange: (next: MeshSidecar) => void;
  edit: TerrainEditState;
  onEdit: (next: TerrainEditState) => void;
}) {
  const [size, setSize] = useState(64);
  const [samples, setSamples] = useState(65);
  const stored = sidecar.terrains ?? [];
  const id = edit.id && stored.some((t) => t.id === edit.id) ? edit.id : (stored[0]?.id ?? null);
  const terrain = id ? findTerrain(sidecar, id) : null;
  const pick = (tool: TerrainTool) => onEdit({ ...edit, id, tool: same(edit.tool, tool) ? null : tool });
  const toolButton = (tool: TerrainTool, label: string, glyph: string, hint: string) => (
    <button
      key={label}
      type="button"
      className={`${styles.toolBtn} ${same(edit.tool, tool) ? styles.toolBtnActive : ""}`}
      aria-pressed={same(edit.tool, tool)}
      onClick={() => pick(tool)}
      title={hint}
    >
      <span className={styles.toolGlyph} aria-hidden>
        {glyph}
      </span>
      {label}
    </button>
  );

  const add = () => {
    const made = addTerrain(sidecar, { size, samples });
    onChange(made.sidecar);
    onEdit({ ...edit, id: made.id, tool: { kind: "sculpt", op: "raise" } });
  };

  return (
    <RailGroup label="Terrain">
      {stored.length > 1 && (
        <select aria-label="Terrain to edit" value={id ?? ""} onChange={(event) => onEdit({ ...edit, id: event.target.value })} style={{ width: "100%", marginBottom: 6 }}>
          {stored.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {terrain ? (
        <>
          <div className={styles.toolGroup}>{SCULPT.map((s) => toolButton({ kind: "sculpt", op: s.op }, s.label, s.glyph, s.hint))}</div>
          <div className={styles.toolGroup} style={{ marginTop: 6 }}>
            {toolButton({ kind: "hole", fill: false }, "Cut hole", "◌", "Cut the ground away (a cave mouth, a pit)")}
            {toolButton({ kind: "hole", fill: true }, "Fill hole", "●", "Put cut ground back")}
          </div>
          <div className={styles.toolGroup} style={{ marginTop: 6 }}>
            {toolButton({ kind: "stamp", stamp: "hills" }, "Hills", "◠", "Press rolling hills into the ground")}
            {toolButton({ kind: "stamp", stamp: "ridges" }, "Ridges", "⋀", "Press sharp ridges and crests into the ground")}
            {toolButton({ kind: "stamp", stamp: "terraces" }, "Terraces", "☰", "Step the ground into flat treads and short risers, like layered sandstone")}
            {toolButton({ kind: "ramp" }, "Ramp", "◢", "Drag from one spot to another: a smooth incline between their heights, the brush's width")}
          </div>
          <div className={styles.toolGroup} style={{ marginTop: 6 }}>
            {toolButton({ kind: "erode", erosion: "hydraulic" }, "Rain", "☂", "Erode with rain: gullies down the slopes, silt at their feet")}
            {toolButton({ kind: "erode", erosion: "thermal" }, "Weather", "⛰", "Let over-steep ground slump into scree")}
          </div>
          {edit.tool?.kind === "stamp" && edit.tool.stamp === "terraces" && (
            <RangeControl label="Step" nested min={0.25} max={10} step={0.25} value={edit.step ?? 2} onChange={(step) => onEdit({ ...edit, id, step })} ariaLabel="Terrace step height" display={`${(edit.step ?? 2).toFixed(2)} m`} />
          )}
          <RangeControl label="Brush size" nested min={0.5} max={Math.max(2, Math.min(terrain.size[0], terrain.size[1]) / 3)} step={0.25} value={edit.radius} onChange={(radius) => onEdit({ ...edit, id, radius })} ariaLabel="Brush radius" display={`${edit.radius.toFixed(2)} m`} />
          <RangeControl label="Strength" nested min={0.05} max={1} step={0.05} value={edit.strength} onChange={(strength) => onEdit({ ...edit, id, strength })} ariaLabel="Brush strength" display={`${Math.round(edit.strength * 100)}%`} />

          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>Layers — pick one to paint it</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
            {terrain.layers.map((layer, k) => {
              const tool: TerrainTool = { kind: "paint", layer: k };
              const active = same(edit.tool, tool);
              return (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="color"
                    aria-label={`${layer.material.name} colour`}
                    value={hex(layer.material.baseColorFactor)}
                    onChange={(event) => {
                      const [r, g, b] = rgb(event.target.value);
                      const layers = terrain.layers.map((l, i) => (i === k ? { ...l, material: { ...l.material, baseColorFactor: [r, g, b, l.material.baseColorFactor[3]] as [number, number, number, number] } } : l));
                      onChange(replaceTerrain(sidecar, { ...terrain, layers }));
                    }}
                    style={{ width: 28, height: 22, padding: 0, border: "none", background: "none" }}
                  />
                  <button type="button" className={`${styles.toolBtn} ${active ? styles.toolBtnActive : ""}`} aria-pressed={active} onClick={() => pick(tool)} style={{ flex: 1 }} title={`Paint ${layer.material.name}`}>
                    {layer.material.name}
                    {layer.paintOnly ? " (painted only)" : ""}
                  </button>
                </div>
              );
            })}
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 10 }} title="Project each layer's texture from all three axes, so steep cliffs aren't streaked by a texture laid flat from above (flat ground looks the same)">
            <input type="checkbox" checked={Boolean(terrain.triplanar)} onChange={(event) => onChange(replaceTerrain(sidecar, { ...terrain, triplanar: event.target.checked || undefined }))} />
            Triplanar cliffs
          </label>
          {terrain.blend && (
            <RangeControl
              label="Layer edges"
              min={0}
              max={1}
              step={0.05}
              value={terrain.blend.sharpness ?? 0}
              onChange={(sharpness) => onChange(replaceTerrain(sidecar, { ...terrain, blend: { ...terrain.blend!, sharpness: sharpness > 0 ? sharpness : undefined } }))}
              ariaLabel="Layer edge sharpness"
              display={terrain.blend.sharpness ? `${Math.round(terrain.blend.sharpness * 100)}% by height` : "even fade"}
            />
          )}

          <FoliageSection sidecar={sidecar} onChange={onChange} terrainId={terrain.id} edit={edit} onEdit={(next) => onEdit({ ...next, id })} />

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 10 }} title="Draw this terrain (and its foliage) once into the sky from the play space, instead of as geometry: far mountains and forests for nothing per frame">
            <input type="checkbox" checked={Boolean(terrain.vista)} onChange={(event) => onChange(replaceTerrain(sidecar, { ...terrain, vista: event.target.checked ? { haze: DEFAULT_VISTA_HAZE } : undefined }))} />
            Distant vista (drawn into the sky)
          </label>
          {terrain.vista && (
            <>
              <RangeControl label="Haze" nested min={0} max={MAX_VISTA_HAZE} step={0.01} value={terrain.vista.haze} onChange={(haze) => onChange(replaceTerrain(sidecar, { ...terrain, vista: { haze } }))} ariaLabel="Vista haze" display={`${Math.round(terrain.vista.haze * 100)}% at 1 km`} />
              <RailHint>Needs the sky dome (Lighting). Seen from the play space's centre; nothing stands on it or collides with it, so keep it beyond where anyone can go.</RailHint>
            </>
          )}

          <LandscapePasses terrain={terrain} onTerrain={(next) => onChange(replaceTerrain(sidecar, next))} />

          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {terrain.paint && (
              <button type="button" className="cbx-btn" onClick={() => onChange(replaceTerrain(sidecar, { ...terrain, paint: undefined }))} title="Forget the painting: the layers follow their slope and height rules again">
                Clear paint
              </button>
            )}
            {terrain.holes && (
              <button type="button" className="cbx-btn" onClick={() => onChange(replaceTerrain(sidecar, { ...terrain, holes: undefined }))}>
                Fill all holes
              </button>
            )}
            <button
              type="button"
              className="cbx-btn"
              onClick={() => {
                onChange(removeTerrain(sidecar, terrain.id));
                onEdit({ ...edit, id: null, tool: null });
              }}
            >
              Delete terrain
            </button>
          </div>
          <RailHint>
            {edit.tool
              ? "Drag over the ground in the scene view to brush it. Alt-drag still orbits; click the tool again to go back to selecting."
              : "Pick a tool, then drag over the ground in the scene view."}
          </RailHint>
        </>
      ) : null}
      <details style={{ marginTop: 6 }} open={stored.length === 0}>
        <summary style={{ cursor: "pointer", fontSize: 12 }}>{stored.length === 0 ? "New terrain" : "Add another terrain"}</summary>
        <RangeControl label="Size" nested min={16} max={4096} step={16} value={size} onChange={setSize} ariaLabel="New terrain size" display={`${size} m`} />
        <RangeControl label="Detail" nested min={17} max={257} step={16} value={samples} onChange={setSamples} ariaLabel="New terrain heights per side" display={`${samples} × ${samples}`} />
        <button type="button" className="cbx-btn" onClick={add} style={{ marginTop: 6 }}>
          Add terrain
        </button>
        <RailHint>A flat landscape to sculpt: rock shows on steep faces and snow up high on its own, and you can paint any layer anywhere.</RailHint>
      </details>
    </RailGroup>
  );
}

const PRESETS: readonly FoliagePreset[] = FOLIAGE_PRESETS;

/**
 * Foliage on the terrain (EP11): its layers — paint or erase each with the
 * brush, fill it across the ground by slope and height, and set its density,
 * size, slope alignment and draw distance.
 */
/**
 * Whole-terrain passes (P2a): rain and weathering over all the ground, and
 * the heights out to and in from a 16-bit heightmap PNG (World Machine,
 * Gaea, a DEM). Each pass is one undo step.
 */
function LandscapePasses({ terrain, onTerrain }: { terrain: Terrain; onTerrain: (next: Terrain) => void }) {
  const [droplets, setDroplets] = useState(40_000);
  const [talus, setTalus] = useState(35);
  const [seed, setSeed] = useState(1);
  const [range, setRange] = useState(Math.round(Math.min(terrain.size[0], terrain.size[1]) / 4));
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const exportMap = () => {
    const { png } = exportHeightmap(terrain);
    const url = URL.createObjectURL(new Blob([png.slice().buffer as ArrayBuffer], { type: "image/png" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${terrain.name || "terrain"}-heightmap.png`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>Whole landscape</div>
      <RangeControl label="Raindrops" nested min={1000} max={MAX_EROSION_DROPLETS} step={1000} value={droplets} onChange={setDroplets} ariaLabel="Raindrops for erosion" display={`${Math.round(droplets / 1000)}k`} />
      <RangeControl label="Repose" nested min={15} max={60} step={1} value={talus} onChange={setTalus} ariaLabel="Steepest slope that stands" display={`${talus}°`} />
      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        <button
          type="button"
          className="cbx-btn"
          title="Run that many raindrops over all the ground (each run a new pattern)"
          onClick={() => {
            onTerrain(hydraulicErosion(terrain, { droplets, seed }));
            setSeed(seed + 1);
          }}
        >
          Rain on it all
        </button>
        <button type="button" className="cbx-btn" title="Slump every slope steeper than the repose angle" onClick={() => onTerrain(thermalErosion(terrain, { iterations: 40, talus }))}>
          Weather it all
        </button>
      </div>
      <RangeControl label="Import height" nested min={1} max={500} step={1} value={range} onChange={setRange} ariaLabel="Height of white in an imported heightmap" display={`${range} m`} />
      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        <button type="button" className="cbx-btn" title="Save the heights as a 16-bit greyscale PNG (it remembers its own height range)" onClick={exportMap}>
          Export heightmap
        </button>
        <button type="button" className="cbx-btn" title="Load heights from a greyscale PNG (8 or 16 bits): black is the ground's base, white the import height" onClick={() => fileRef.current?.click()}>
          Import heightmap…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try {
              onTerrain(await importHeightmap(terrain, new Uint8Array(await file.arrayBuffer()), [0, range]));
              setProblem(null);
            } catch (error) {
              setProblem(error instanceof Error ? error.message : "That file couldn't be read");
            }
          }}
        />
      </div>
      {problem && <RailHint>{problem}</RailHint>}
    </>
  );
}

function FoliageSection({
  sidecar,
  onChange,
  terrainId,
  edit,
  onEdit,
}: {
  sidecar: MeshSidecar;
  onChange: (next: MeshSidecar) => void;
  terrainId: string;
  edit: TerrainEditState;
  onEdit: (next: TerrainEditState) => void;
}) {
  const [source, setSource] = useState<string>("preset:boulder");
  const layers = foliageOn(sidecar, terrainId);
  const terrain = (sidecar.terrains ?? []).find((t) => t.id === terrainId);
  const activeId = edit.tool?.kind === "foliage" ? edit.tool.layer : null;
  const [open, setOpen] = useState<string | null>(null);
  const shown = activeId ?? open;
  const set = (found: { layer: FoliageLayer; mesh: string }, patch: Partial<FoliageLayer>) => onChange(replaceFoliage(sidecar, { ...found.layer, ...patch }, found.mesh));
  const add = () => {
    const made = source.startsWith("preset:") ? addFoliage(sidecar, terrainId, { preset: source.slice(7) as FoliagePreset }) : addFoliage(sidecar, terrainId, { from: source.slice(7) });
    if (!made) return;
    onChange(made.sidecar);
    setOpen(made.id);
    onEdit({ ...edit, tool: { kind: "foliage", layer: made.id, erase: false } });
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, opacity: 0.7 }}>Foliage — scatter meshes over the ground</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {layers.map((found) => {
          const { layer } = found;
          const painting = edit.tool?.kind === "foliage" && edit.tool.layer === layer.id && !edit.tool.erase;
          const erasing = edit.tool?.kind === "foliage" && edit.tool.layer === layer.id && edit.tool.erase;
          const total = terrain ? layerCopiesCount(sidecar, found) : layer.copies.length;
          return (
            <div key={layer.id} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 6 }}>
              <button type="button" className="cbx-btn" style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(shown === layer.id ? null : layer.id)} aria-expanded={shown === layer.id} title="Show this layer's settings">
                {shown === layer.id ? "▾" : "▸"} {layer.name} · {total.toLocaleString()}
              </button>
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <button type="button" className={`${styles.toolBtn} ${painting ? styles.toolBtnActive : ""}`} aria-pressed={painting} style={{ flex: 1, justifyContent: "center" }} title={`Paint ${layer.name} with the brush`} onClick={() => onEdit({ ...edit, tool: painting ? null : { kind: "foliage", layer: layer.id, erase: false } })}>
                  Paint
                </button>
                <button type="button" className={`${styles.toolBtn} ${erasing ? styles.toolBtnActive : ""}`} aria-pressed={erasing} style={{ flex: 1, justifyContent: "center" }} title="Erase painted copies with the brush" onClick={() => onEdit({ ...edit, tool: erasing ? null : { kind: "foliage", layer: layer.id, erase: true } })}>
                  Erase
                </button>
              </div>
              {shown === layer.id && (
                <>
                  <RangeControl label="Density" nested min={0.1} max={100} step={0.1} value={layer.density} onChange={(density) => set(found, { density })} ariaLabel={`${layer.name} density`} display={`${layer.density.toFixed(1)} / 100 m²`} />
                  <RangeControl label="Smallest" nested min={0.1} max={5} step={0.05} value={layer.scale[0]} onChange={(v) => set(found, { scale: [v, Math.max(v, layer.scale[1])] })} ariaLabel={`${layer.name} smallest size`} display={`×${layer.scale[0].toFixed(2)}`} />
                  <RangeControl label="Largest" nested min={0.1} max={5} step={0.05} value={layer.scale[1]} onChange={(v) => set(found, { scale: [Math.min(v, layer.scale[0]), v] })} ariaLabel={`${layer.name} largest size`} display={`×${layer.scale[1].toFixed(2)}`} />
                  <RangeControl label="Follow slope" nested min={0} max={1} step={0.05} value={layer.align} onChange={(align) => set(found, { align })} ariaLabel={`${layer.name} slope alignment`} display={`${Math.round(layer.align * 100)}%`} />
                  <RangeControl label="Draw distance" nested min={10} max={600} step={10} value={layer.cull} onChange={(cull) => set(found, { cull })} ariaLabel={`${layer.name} draw distance`} display={`${layer.cull} m`} />
                  <RangeControl label="Sway" nested min={0} max={4} step={0.1} value={layer.wind ?? 0} onChange={(wind) => set(found, { wind: wind > 0 ? wind : undefined })} ariaLabel={`${layer.name} sway in the wind`} display={layer.wind ? layer.wind.toFixed(1) : "stiff"} />
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(layer.fill)}
                      onChange={(event) => set(found, { fill: event.target.checked ? { seed: Math.floor(foliageRandom(Date.now())() * 1e6), up: [0.6, 1] } : undefined })}
                    />
                    Fill the ground by rules
                  </label>
                  {layer.fill && (
                    <>
                      <RangeControl label="Steepest slope" nested min={0} max={90} step={1} value={Math.round((Math.acos(Math.max(0, Math.min(1, layer.fill.up?.[0] ?? 0))) * 180) / Math.PI)} onChange={(deg) => set(found, { fill: { ...layer.fill!, up: [Math.cos((deg * Math.PI) / 180), 1] } })} ariaLabel={`${layer.name} steepest slope`} display={`${Math.round((Math.acos(Math.max(0, Math.min(1, layer.fill.up?.[0] ?? 0))) * 180) / Math.PI)}°`} />
                      <button type="button" className="cbx-btn" onClick={() => set(found, { fill: { ...layer.fill!, seed: layer.fill!.seed + 1 } })} title="Scatter the filled copies differently">
                        Reseed
                      </button>
                    </>
                  )}
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    {layer.copies.length > 0 && (
                      <button type="button" className="cbx-btn" onClick={() => set(found, { copies: [] })}>
                        Clear painted
                      </button>
                    )}
                    <button
                      type="button"
                      className="cbx-btn"
                      onClick={() => {
                        onChange(removeFoliage(sidecar, layer.id));
                        if (activeId === layer.id) onEdit({ ...edit, tool: null });
                      }}
                    >
                      Remove layer
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        <select aria-label="New foliage mesh" value={source} onChange={(event) => setSource(event.target.value)} style={{ flex: 1, minWidth: 0 }}>
          {PRESETS.map((p) => (
            <option key={p} value={`preset:${p}`}>
              {p}
            </option>
          ))}
          {sidecar.meshes.map((m) => (
            <option key={m.id} value={`object:${m.id}`}>
              {m.name} (scene object)
            </option>
          ))}
        </select>
        <button type="button" className="cbx-btn" onClick={add}>
          Add foliage
        </button>
      </div>
    </div>
  );
}

/** How many copies a layer has, filled ones included. */
function layerCopiesCount(sidecar: MeshSidecar, found: { layer: FoliageLayer }): number {
  if (!found.layer.fill) return found.layer.copies.length;
  const terrain = findTerrain(sidecar, found.layer.terrain);
  return terrain ? layerCopies(terrain, found.layer).length : found.layer.copies.length;
}
