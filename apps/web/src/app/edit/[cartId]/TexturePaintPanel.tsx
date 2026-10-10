"use client";

/**
 * Texture painting in the Mesh tab (LOCKOUT_MULTIPLAYER_ROADMAP.md L17): the
 * Paint panel — the part and layer being painted (base colour, roughness,
 * metal, emissive or the team-colour mask), the brush, unwrapping, and the
 * UV view, where the layer's map shows under the part's UVs and can be
 * painted directly, or its islands picked, moved, turned, scaled and packed.
 * The same brush paints on the model in the preview (see MeshEditor). The
 * logic is texturePaint.ts, uvUnwrap.ts and materialSets.ts in
 * @cartbox/editor; this holds the image being painted while a stroke lasts,
 * and saves it into the material (or the material set the copy wears) as a
 * PNG when the stroke ends.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PAINT_LAYERS,
  blankLayer,
  encodePaintImage,
  materialFor,
  packIslands,
  paintImageFrom,
  paintLayer,
  paintTexels,
  patchMaterial,
  pickIsland,
  transformIsland,
  unwrapPrimitive,
  uvIslands,
  type EncodedImage,
  type MeshAsset,
  type MeshMaterial,
  type PaintImage,
  type TexturePaintLayer,
} from "@cartbox/editor";

import { decodeImage } from "@/lib/meshImport";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

const UV_VIEW = 256;

/** The image being painted: its part and layer, its pixels, how the material changes when it is first saved, and a counter that redraws. */
interface PaintTarget {
  readonly primitive: number;
  readonly layer: TexturePaintLayer;
  readonly set: string | null;
  readonly image: PaintImage;
  readonly patch: Partial<MeshMaterial>;
  /** The encoded image this was last saved as (so saving it doesn't reload it). */
  readonly saved: EncodedImage | null;
}

export interface TexturePaint {
  readonly primitive: number;
  setPrimitive: (primitive: number) => void;
  readonly layer: TexturePaintLayer;
  setLayer: (layer: TexturePaintLayer) => void;
  readonly color: [number, number, number];
  setColor: (color: [number, number, number]) => void;
  readonly value: number;
  setValue: (value: number) => void;
  readonly radius: number;
  setRadius: (radius: number) => void;
  readonly opacity: number;
  setOpacity: (opacity: number) => void;
  readonly size: number;
  setSize: (size: number) => void;
  /** The image being painted (null while it loads, or when the part has no UVs). */
  readonly target: PaintTarget | null;
  /** Bumped by every dab, so views redraw. */
  readonly version: number;
  /** One dab at a UV. */
  dab: (uv: readonly [number, number]) => void;
  /** The stroke ends: the image is saved into the material. */
  endStroke: () => void;
}

/**
 * The paint state for a mesh: which part and layer, the brush, and the image
 * being painted — the slot's own map, decoded, or a fresh one filled with
 * what the material shows there now.
 */
export function useTexturePaint(mesh: MeshAsset | null, set: string | null, onCommit: (next: MeshAsset) => void): TexturePaint {
  const [primitive, setPrimitive] = useState(0);
  const [layer, setLayer] = useState<TexturePaintLayer>("baseColor");
  const [color, setColor] = useState<[number, number, number]>([0.76, 0.6, 0.42]);
  const [value, setValue] = useState(1);
  const [radius, setRadius] = useState(6);
  const [opacity, setOpacity] = useState(0.8);
  const [size, setSize] = useState(512);
  const [target, setTarget] = useState<PaintTarget | null>(null);
  const [version, setVersion] = useState(0);
  const dirty = useRef(false);
  const part = mesh && primitive < mesh.primitives.length ? primitive : 0;
  const p = mesh?.primitives[part];
  const material = mesh ? materialFor(mesh, part, set) : null;
  const slot = paintLayer(layer).slot;
  const current = (material?.[slot] as EncodedImage | null | undefined) ?? null;

  // Load the image to paint when the part, layer or set changes, or the map is replaced from elsewhere.
  useEffect(() => {
    if (!material || !p?.uvs) {
      setTarget(null);
      return;
    }
    // Already the one wanted (a fresh map not yet painted is remade at a new size).
    const same = target && target.primitive === part && target.layer === layer && target.set === set && target.saved === current;
    if (same && (current || dirty.current || target.image.width === size)) return;
    // Roughness and metal share one map: switching between them keeps the pixels.
    if (target && target.primitive === part && target.set === set && paintLayer(target.layer).slot === slot && target.saved === current) {
      setTarget({ ...target, layer });
      return;
    }
    let cancelled = false;
    if (!current || current.bytes.length === 0) {
      const fresh = blankLayer(material, layer, size);
      setTarget({ primitive: part, layer, set, image: fresh.image, patch: fresh.patch, saved: null });
      dirty.current = false;
      return;
    }
    setTarget(null);
    void decodeImage(current.bytes, current.mime, true)
      .then((decoded) => {
        if (!cancelled) setTarget({ primitive: part, layer, set, image: paintImageFrom(decoded), patch: {}, saved: current });
      })
      .catch(() => {
        if (!cancelled) setTarget(null);
      });
    return () => {
      cancelled = true;
    };
    // `target` is read only to see whether it already is what's wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, part, layer, set, current, size, p?.uvs]);

  const dab = useCallback(
    (uv: readonly [number, number]) => {
      if (!target) return;
      const scalar = layer === "roughness" || layer === "metal" || layer === "teamMask";
      if (paintTexels(target.image, layer, [uv[0], uv[1]], scalar ? [value] : color, { radius, opacity, hardness: 0.5 })) {
        dirty.current = true;
        setVersion((v) => v + 1);
      }
    },
    [target, layer, value, color, radius, opacity],
  );
  const endStroke = useCallback(() => {
    if (!mesh || !target || !dirty.current) return;
    dirty.current = false;
    const image = encodePaintImage(target.image);
    setTarget({ ...target, patch: {}, saved: image });
    onCommit(patchMaterial(mesh, target.primitive, { ...target.patch, [paintLayer(target.layer).slot]: image }, target.set));
  }, [mesh, target, onCommit]);

  return {
    primitive: part,
    setPrimitive,
    layer,
    setLayer,
    color,
    setColor,
    value,
    setValue,
    radius,
    setRadius,
    opacity,
    setOpacity,
    size,
    setSize,
    target: target && target.primitive === part && target.layer === layer && target.set === set ? target : null,
    version,
    dab,
    endStroke,
  };
}

const toHex = (rgb: readonly number[]) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0, 0, 0];
};

/**
 * The UV view: the part's map for the layer, its UVs over it, and either the
 * brush (drag to paint) or its islands (click to pick one, drag to move it).
 */
function UvView({ mesh, paint, tool, island, onIsland, onEdit }: { mesh: MeshAsset; paint: TexturePaint; tool: "paint" | "islands"; island: number; onIsland: (island: number) => void; onEdit: (next: MeshAsset) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const p = mesh.primitives[paint.primitive];
  const islands = useMemo(() => (p?.uvs ? uvIslands(p) : []), [p]);
  const [drag, setDrag] = useState<{ from: [number, number]; to: [number, number] } | null>(null);
  const painting = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !p) return;
    canvas.width = UV_VIEW;
    canvas.height = UV_VIEW;
    ctx.fillStyle = "#1b1e2b";
    ctx.fillRect(0, 0, UV_VIEW, UV_VIEW);
    const image = paint.target?.image;
    if (image) {
      const tile = document.createElement("canvas");
      tile.width = image.width;
      tile.height = image.height;
      tile.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tile, 0, 0, UV_VIEW, UV_VIEW);
    }
    if (!p.uvs) return;
    const shift = drag ? [drag.to[0] - drag.from[0], drag.to[1] - drag.from[1]] : [0, 0];
    const at = (v: number, moved: boolean): [number, number] => [(p.uvs![v * 2]! + (moved ? shift[0]! : 0)) * UV_VIEW, (1 - p.uvs![v * 2 + 1]! - (moved ? shift[1]! : 0)) * UV_VIEW];
    const picked = new Set(islands[island]?.triangles ?? []);
    ctx.lineWidth = 1;
    for (let t = 0; t < p.indices.length / 3; t += 1) {
      const moved = picked.has(t);
      const [a, b, c] = [0, 1, 2].map((k) => at(p.indices[t * 3 + k]!, moved)) as [[number, number], [number, number], [number, number]];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.closePath();
      if (moved) {
        ctx.fillStyle = "rgba(255, 176, 58, 0.3)";
        ctx.fill();
      }
      ctx.strokeStyle = moved ? "#ffb03a" : "rgba(220, 230, 255, 0.55)";
      ctx.stroke();
    }
  }, [p, paint.target, paint.version, islands, island, drag]);

  const uvAt = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height];
  };
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={tool === "paint" ? "UV view — drag to paint the layer" : "UV view — click an island to pick it, drag to move it"}
      style={{ width: "100%", aspectRatio: "1", borderRadius: 6, touchAction: "none", cursor: tool === "paint" ? "crosshair" : "move", imageRendering: "pixelated" }}
      onPointerDown={(event) => {
        if (!p?.uvs) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const uv = uvAt(event);
        if (tool === "paint") {
          painting.current = true;
          paint.dab(uv);
          return;
        }
        const k = pickIsland(p, islands, uv);
        onIsland(k);
        if (k >= 0) setDrag({ from: uv, to: uv });
      }}
      onPointerMove={(event) => {
        if (tool === "paint" && painting.current) paint.dab(uvAt(event));
        else if (drag) setDrag({ ...drag, to: uvAt(event) });
      }}
      onPointerUp={() => {
        if (tool === "paint") {
          if (painting.current) paint.endStroke();
          painting.current = false;
          return;
        }
        const k = islands[island];
        if (drag && k && p && (drag.to[0] !== drag.from[0] || drag.to[1] !== drag.from[1])) {
          onEdit(withPrimitive(mesh, paint.primitive, transformIsland(p, k, { kind: "move", offset: [drag.to[0] - drag.from[0], drag.to[1] - drag.from[1]] })));
        }
        setDrag(null);
      }}
    />
  );
}

const withPrimitive = (mesh: MeshAsset, index: number, next: MeshAsset["primitives"][number]): MeshAsset => ({ ...mesh, primitives: mesh.primitives.map((p, i) => (i === index ? next : p)) });

export function TexturePaintPanel({ mesh, set, paint, onEdit }: { mesh: MeshAsset; set: string | null; paint: TexturePaint; onEdit: (next: MeshAsset) => void }) {
  const [tool, setTool] = useState<"paint" | "islands">("paint");
  const [island, setIsland] = useState(-1);
  const p = mesh.primitives[paint.primitive];
  const scalar = paint.layer === "roughness" || paint.layer === "metal" || paint.layer === "teamMask";
  const islands = p?.uvs ? uvIslands(p) : [];
  const picked = islands[island];
  const unwrapAll = () => onEdit({ ...mesh, primitives: mesh.primitives.map((q) => (q.uvs ? q : unwrapPrimitive(q))) });
  useEffect(() => setIsland(-1), [paint.primitive]);
  if (!p) return null;
  return (
    <RailGroup label="Paint">
      <select aria-label="Part to paint" value={paint.primitive} onChange={(e) => paint.setPrimitive(Number(e.target.value))} style={{ width: "100%", padding: "4px 6px", borderRadius: 6, marginBottom: 6 }}>
        {mesh.primitives.map((q, i) => (
          <option key={i} value={i}>
            {q.material.name || `part ${i + 1}`}
            {q.uvs ? "" : " (no UVs)"}
          </option>
        ))}
      </select>
      <SegmentedControl ariaLabel="Layer" wrap selected={paint.layer} onSelect={paint.setLayer} options={PAINT_LAYERS.map((l) => ({ id: l.id, label: l.label }))} />
      {set && <RailHint>Painting the “{set}” material set, which this copy wears.</RailHint>}
      {!p.uvs ? (
        <>
          <RailHint>This part has no UVs to paint through. Unwrap it first: each face is laid flat along the way it faces, and packed at one texel density.</RailHint>
          <div className={styles.toolGroup}>
            <button type="button" className={styles.toolBtn} onClick={() => onEdit(withPrimitive(mesh, paint.primitive, unwrapPrimitive(p)))}>
              Unwrap this part
            </button>
            <button type="button" className={styles.toolBtn} onClick={unwrapAll}>
              Unwrap every part without UVs
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "6px 0" }}>
            {scalar ? (
              <RangeControl
                label={paint.layer === "teamMask" ? "Team colour" : paint.layer === "metal" ? "Metal" : "Roughness"}
                min={0}
                max={1}
                step={0.01}
                value={paint.value}
                ariaLabel="Value to paint"
                display={paint.value.toFixed(2)}
                onChange={paint.setValue}
              />
            ) : (
              <>
                <input type="color" aria-label="Colour to paint" value={toHex(paint.color)} onChange={(e) => paint.setColor(fromHex(e.target.value))} style={{ width: 40, height: 28, padding: 0, border: "none", background: "none" }} />
                <span className={styles.hudLabel}>{paint.layer === "emissive" ? "glow colour" : "colour"}</span>
              </>
            )}
          </div>
          <RangeControl label="Radius" min={1} max={64} step={1} value={paint.radius} ariaLabel="Brush radius" display={`${paint.radius} px`} onChange={paint.setRadius} />
          <RangeControl label="Opacity" min={0.05} max={1} step={0.05} value={paint.opacity} ariaLabel="Brush opacity" display={paint.opacity.toFixed(2)} onChange={paint.setOpacity} />
          {!materialFor(mesh, paint.primitive, set)?.[paintLayer(paint.layer).slot] && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <span className={styles.hudLabel}>New map</span>
              <select aria-label="New map size" value={paint.size} onChange={(e) => paint.setSize(Number(e.target.value))} style={{ padding: "2px 4px", borderRadius: 6 }}>
                {[128, 256, 512, 1024].map((n) => (
                  <option key={n} value={n}>
                    {n} × {n}
                  </option>
                ))}
              </select>
            </div>
          )}
          <SegmentedControl
            ariaLabel="UV view tool"
            selected={tool}
            onSelect={setTool}
            options={[
              { id: "paint", label: "Paint", hint: "Drag on the UV view to paint the layer" },
              { id: "islands", label: "Islands", hint: "Click an island to pick it; drag to move it" },
            ]}
          />
          <div style={{ marginTop: 6 }}>
            <UvView mesh={mesh} paint={paint} tool={tool} island={island} onIsland={setIsland} onEdit={onEdit} />
          </div>
          {tool === "islands" && (
            <div className={styles.toolGroup}>
              <button type="button" className={styles.toolBtn} disabled={!picked} onClick={() => picked && onEdit(withPrimitive(mesh, paint.primitive, transformIsland(p, picked, { kind: "rotate", angle: Math.PI / 2 })))}>
                ⟲ 90°
              </button>
              <button type="button" className={styles.toolBtn} disabled={!picked} onClick={() => picked && onEdit(withPrimitive(mesh, paint.primitive, transformIsland(p, picked, { kind: "scale", factor: 1.25 })))}>
                Larger
              </button>
              <button type="button" className={styles.toolBtn} disabled={!picked} onClick={() => picked && onEdit(withPrimitive(mesh, paint.primitive, transformIsland(p, picked, { kind: "scale", factor: 0.8 })))}>
                Smaller
              </button>
              <button type="button" className={styles.toolBtn} onClick={() => onEdit(withPrimitive(mesh, paint.primitive, packIslands(p)))}>
                Pack
              </button>
              <button type="button" className={styles.toolBtn} title="Lay the part out afresh (maps painted on the old layout won't line up)" onClick={() => onEdit(withPrimitive(mesh, paint.primitive, unwrapPrimitive(p)))}>
                Re-unwrap
              </button>
            </div>
          )}
          <RailHint>
            {islands.length} island{islands.length === 1 ? "" : "s"}. Paint on the model in the preview or on the UV view; each stroke is saved into the
            material as a PNG. The team-colour layer is how much of a team&apos;s colour each texel takes. Right-drag orbits the preview.
          </RailHint>
        </>
      )}
    </RailGroup>
  );
}
