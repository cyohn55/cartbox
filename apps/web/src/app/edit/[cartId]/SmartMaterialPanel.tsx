"use client";

/**
 * Smart materials in the Mesh tab (AAA_FIDELITY_ROADMAP.md F9b): a layer stack
 * (smartMaterials.ts in @cartbox/editor) painted into a primitive's texture
 * set from its bakes (the occlusion and relief maps of I15, the normal map of
 * F9a). Each layer fills colour, metalness, roughness, height and glow through
 * a mask generated from the bakes, brushed by hand in texture space, or
 * anchored to another layer's. The set exports as PNGs named for its UDIM
 * tile, and a mesh spanning several tiles can be split into one primitive a
 * tile.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  SMART_PRESETS,
  applyTextureSet,
  decodePngRgba,
  paintSmartStack,
  splitUdim,
  textureSetFiles,
  udimTiles,
  type BrushDab,
  type DecodedTexture,
  type EncodedImage,
  type MeshAsset,
  type SmartBakes,
  type SmartLayer,
  type SmartMaskKind,
  type SmartStack,
  type SmartTextureSet,
} from "@cartbox/editor";

import { RailGroup, RailHint } from "./railControls";

const SIZES = [256, 512, 1024, 2048, 4096] as const;
const MASKS: readonly { id: SmartMaskKind; label: string }[] = [
  { id: "full", label: "Everywhere" },
  { id: "edgeWear", label: "Edge wear" },
  { id: "dirt", label: "Dirt" },
  { id: "rust", label: "Rust" },
  { id: "id", label: "ID colour" },
  { id: "noise", label: "Noise" },
  { id: "paint", label: "Brush" },
  { id: "anchor", label: "Anchor" },
];
const row: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12 };
const small: React.CSSProperties = { width: 56, padding: "2px 4px", borderRadius: 4 };

const hex = (c: readonly [number, number, number]) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

async function decode(image: EncodedImage | null | undefined): Promise<DecodedTexture | null> {
  if (!image || image.bytes.length === 0 || image.mime !== "image/png") return null;
  try {
    const d = await decodePngRgba(image.bytes);
    return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
  } catch {
    return null;
  }
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SmartMaterialPanel({ mesh, onEdit }: { mesh: MeshAsset; onEdit: (next: MeshAsset) => void }) {
  const [primitive, setPrimitive] = useState(0);
  const p = mesh.primitives[Math.min(primitive, mesh.primitives.length - 1)];
  const [stack, setStack] = useState<SmartStack>(() => p?.material.smartStack ?? SMART_PRESETS[0]!.stack);
  const [selected, setSelected] = useState<string | null>(null);
  const [size, setSize] = useState<number>(1024);
  const [brush, setBrush] = useState({ radius: 0.03, hardness: 0.6, erase: false });
  const [set, setSet] = useState<SmartTextureSet | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // A different primitive: its own stack.
  useEffect(() => {
    if (p?.material.smartStack) setStack(p.material.smartStack);
  }, [p]);
  const tiles = useMemo(() => (p ? udimTiles(p) : []), [p]);
  const patchLayer = (id: string, next: Partial<SmartLayer>) => setStack((s) => ({ ...s, layers: s.layers.map((l) => (l.id === id ? { ...l, ...next } : l)) }));
  const move = (id: string, by: number) =>
    setStack((s) => {
      const i = s.layers.findIndex((l) => l.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= s.layers.length) return s;
      const layers = [...s.layers];
      [layers[i], layers[j]] = [layers[j]!, layers[i]!];
      return { ...s, layers };
    });
  const add = (paint: boolean) => {
    const id = `layer${Date.now().toString(36)}`;
    setStack((s) => ({ ...s, layers: [...s.layers, { id, name: paint ? "Brushed" : "Fill", baseColor: [0.5, 0.5, 0.5], ...(paint ? { mask: { kind: "paint" as const } } : {}) }] }));
    setSelected(id);
  };
  const paint = async () => {
    if (!p) return;
    setNote("Painting…");
    const bakes: SmartBakes = { occlusion: await decode(p.material.occlusionImage), relief: await decode(p.material.reliefImage), normal: await decode(p.material.normalImage) };
    const start = performance.now();
    const out = paintSmartStack(stack, size, bakes, p.material);
    setSet(out);
    onEdit({ ...mesh, primitives: mesh.primitives.map((q, i) => (i === primitive ? { ...q, material: applyTextureSet(q.material, out, stack) } : q)) });
    setNote(`Painted ${out.size}² in ${((performance.now() - start) / 1000).toFixed(1)} s${bakes.occlusion || bakes.relief ? "" : " (no bakes yet: generated masks read flat; bake maps first)"}.`);
  };
  // The base colour as painted, under the brush.
  useEffect(() => {
    const c = canvas.current;
    const t = set?.baseColor;
    if (!c || !t) return;
    c.width = t.width;
    c.height = t.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(t.width, t.height);
    img.data.set(t.data);
    ctx.putImageData(img, 0, 0);
  }, [set]);
  const layer = stack.layers.find((l) => l.id === selected) ?? null;
  const dab = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!layer || e.buttons !== 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    const d: BrushDab = { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, radius: brush.radius, hardness: brush.hardness, strength: brush.erase ? -1 : 1 };
    const mask = layer.mask ?? { kind: "paint" as const };
    patchLayer(layer.id, { mask: { ...mask, strokes: [...(mask.strokes ?? []), d] } });
  };
  if (!p) return null;
  return (
    <RailGroup label="Smart material">
      <div style={row}>
        {mesh.primitives.length > 1 && (
          <label>
            Part{" "}
            <select aria-label="Smart material part" value={primitive} onChange={(e) => setPrimitive(Number(e.target.value))}>
              {mesh.primitives.map((q, i) => (
                <option key={i} value={i}>
                  {q.material.name || `Part ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <select aria-label="Smart material preset" value="" onChange={(e) => e.target.value && setStack(SMART_PRESETS[Number(e.target.value)]!.stack)}>
          <option value="">Preset…</option>
          {SMART_PRESETS.map((s, i) => (
            <option key={s.name} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => add(false)}>+ Fill</button>
        <button type="button" onClick={() => add(true)}>+ Brush</button>
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} aria-label="Smart material layers">
        {stack.layers.map((l) => (
          <li key={l.id} style={{ marginBottom: 4 }}>
            <div style={row}>
              <input type="checkbox" checked={l.visible !== false} aria-label={`${l.name} visible`} onChange={(e) => patchLayer(l.id, { visible: e.target.checked })} />
              <button type="button" onClick={() => setSelected(l.id === selected ? null : l.id)} aria-pressed={l.id === selected} style={{ fontWeight: l.id === selected ? 700 : 400 }}>
                {l.name}
              </button>
              <button type="button" aria-label={`Move ${l.name} down`} onClick={() => move(l.id, -1)}>↓</button>
              <button type="button" aria-label={`Move ${l.name} up`} onClick={() => move(l.id, 1)}>↑</button>
              <button type="button" aria-label={`Remove ${l.name}`} onClick={() => setStack((s) => ({ ...s, layers: s.layers.filter((x) => x.id !== l.id) }))}>✕</button>
            </div>
            {l.id === selected && (
              <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
                <div style={row}>
                  <input type="text" value={l.name} aria-label="Layer name" onChange={(e) => patchLayer(l.id, { name: e.target.value.slice(0, 64) })} style={{ width: 110 }} />
                  <label>
                    Opacity <input type="number" min={0} max={1} step={0.05} value={l.opacity ?? 1} style={small} aria-label="Layer opacity" onChange={(e) => patchLayer(l.id, { opacity: Number(e.target.value) })} />
                  </label>
                </div>
                <div style={row}>
                  <label>
                    Colour <input type="color" value={hex(l.baseColor ?? [0.5, 0.5, 0.5])} aria-label="Layer colour" onChange={(e) => patchLayer(l.id, { baseColor: fromHex(e.target.value) })} />
                  </label>
                  {(["metallic", "roughness", "height"] as const).map((k) => (
                    <label key={k}>
                      {k === "metallic" ? "Metal" : k === "roughness" ? "Rough" : "Height"}{" "}
                      <input type="number" min={k === "height" ? -1 : 0} max={1} step={0.05} value={l[k] ?? ""} placeholder="—" style={small} aria-label={`Layer ${k}`} onChange={(e) => patchLayer(l.id, { [k]: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    </label>
                  ))}
                </div>
                <div style={row}>
                  <label>
                    Mask{" "}
                    <select aria-label="Layer mask" value={l.mask?.kind ?? "full"} onChange={(e) => patchLayer(l.id, { mask: { ...(l.mask ?? {}), kind: e.target.value as SmartMaskKind } })}>
                      {MASKS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {l.mask?.kind === "anchor" && (
                    <select aria-label="Anchor layer" value={l.mask.anchor ?? ""} onChange={(e) => patchLayer(l.id, { mask: { ...l.mask!, anchor: e.target.value } })}>
                      <option value="">Layer…</option>
                      {stack.layers.filter((x) => x.id !== l.id).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {l.mask && !["full", "paint", "anchor", "id"].includes(l.mask.kind) &&
                    (["level", "width", "breakup"] as const).map((k) => (
                      <label key={k}>
                        {k[0]!.toUpperCase() + k.slice(1)}{" "}
                        <input type="number" min={0} max={1} step={0.05} value={l.mask![k] ?? (k === "level" ? 0.5 : k === "width" ? 0.1 : 0)} style={small} aria-label={`Mask ${k}`} onChange={(e) => patchLayer(l.id, { mask: { ...l.mask!, [k]: Number(e.target.value) } })} />
                      </label>
                    ))}
                  {l.mask && (
                    <label>
                      <input type="checkbox" checked={l.mask.invert === true} aria-label="Invert mask" onChange={(e) => patchLayer(l.id, { mask: { ...l.mask!, invert: e.target.checked } })} /> Invert
                    </label>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div style={row}>
        <label>
          Size{" "}
          <select aria-label="Texture set size" value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}²
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void paint()}>Paint texture set</button>
        {set && (
          <button type="button" onClick={() => textureSetFiles(p.material.name || "material", set, tiles[0] ?? 1001).forEach((f) => download(f.name, f.bytes))}>
            Export PNGs
          </button>
        )}
        {tiles.length > 1 && (
          <button type="button" onClick={() => onEdit(splitUdim(mesh))} title={`Its texture coordinates span ${tiles.length} UDIM tiles (${tiles.join(", ")}): one primitive, and texture set, a tile`}>
            Split UDIM tiles
          </button>
        )}
      </div>
      {set && (
        <>
          <div style={row}>
            <label>
              Brush <input type="number" min={0.002} max={0.3} step={0.005} value={brush.radius} style={small} aria-label="Brush radius" onChange={(e) => setBrush({ ...brush, radius: Number(e.target.value) })} />
            </label>
            <label>
              Hardness <input type="number" min={0} max={1} step={0.1} value={brush.hardness} style={small} aria-label="Brush hardness" onChange={(e) => setBrush({ ...brush, hardness: Number(e.target.value) })} />
            </label>
            <label>
              <input type="checkbox" checked={brush.erase} aria-label="Erase" onChange={(e) => setBrush({ ...brush, erase: e.target.checked })} /> Erase
            </label>
          </div>
          <canvas
            ref={canvas}
            aria-label="Texture space: brush the selected layer's mask"
            onPointerDown={dab}
            onPointerMove={dab}
            style={{ width: 192, height: 192, imageRendering: "pixelated", borderRadius: 4, cursor: layer ? "crosshair" : "default", touchAction: "none" }}
          />
        </>
      )}
      {note && <RailHint>{note}</RailHint>}
      <RailHint>Masks read the part&apos;s baked occlusion and relief (Bake maps above, or from a high mesh): edge wear from curvature, dirt from occlusion, rust from height and crevices. Select a layer to brush its mask on the texture, then paint again.</RailHint>
    </RailGroup>
  );
}
