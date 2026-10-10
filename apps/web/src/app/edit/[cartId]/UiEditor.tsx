"use client";

/**
 * The UI tab (ENGINE_PARITY_ROADMAP.md EP13): author menus and HUDs as
 * documents of widgets — pick a document, add panels, text, buttons, bars,
 * sliders, lists and images, place them by anchor on the console's screen
 * (drag them in the preview), bind what they show, and try the d-pad focus
 * the cart will get. The cart drives them with cartbox.ui (see uiSdk.ts).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { HOLO_KINDS, HOLO_RGB, UI_KINDS, layoutUi, renderHoloDocument, uiNavigation, type UiDocument, type UiKind, type UiPlaced, type UiWidget } from "@cartbox/editor";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { addUiDocument, addWidget, findWidget, flattenWidgets, removeUiDocument, removeWidget, reorderWidget, replaceUiDocument, uiDocuments, updateWidget } from "@/lib/uiEdit";
import { drawUiPreview, parsePreviewBindings, sampleBindings, widgetAt } from "@/lib/uiPreview";
import styles from "./editor.module.css";
import { RailGroup, RailHint } from "./railControls";

type Rgb = readonly [number, number, number];

const ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0], [0.5, 0], [1, 0],
  [0, 0.5], [0.5, 0.5], [1, 0.5],
  [0, 1], [0.5, 1], [1, 1],
];

const KIND_LABEL: Record<UiKind, string> = { panel: "Panel", text: "Text", button: "Button", bar: "Bar", slider: "Slider", list: "List", image: "Image", arc: "Arc", radar: "Radar" };

const hex = (c: readonly number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export function UiEditor({
  sidecar,
  onSidecarChange,
  width,
  height,
  palette,
}: {
  sidecar: MeshSidecar;
  onSidecarChange: (next: MeshSidecar) => void;
  width: number;
  height: number;
  palette: readonly Rgb[];
}) {
  const docs = uiDocuments(sidecar);
  const [docName, setDocName] = useState<string | null>(docs[0]?.name ?? null);
  const doc = docs.find((d) => d.name === docName) ?? docs[0] ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<UiKind>("text");
  const [bindingText, setBindingText] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const placedRef = useRef<UiPlaced[]>([]);
  const drag = useRef<{ id: string; x: number; y: number; offset: readonly [number, number] } | null>(null);
  const widget = doc && selected ? findWidget(doc, selected) : null;

  const bindings = useMemo(() => (doc ? { ...sampleBindings(doc), ...parsePreviewBindings(bindingText) } : {}), [doc, bindingText]);
  const setDoc = (next: UiDocument) => doc && onSidecarChange(replaceUiDocument(sidecar, doc.name, next));
  const setWidget = (patch: Partial<UiWidget>) => doc && widget && setDoc(updateWidget(doc, widget.id, patch));

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = "#11131c";
    ctx.fillRect(0, 0, width, height);
    // A faint grid every 40 pixels, to line things up by eye.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    for (let x = 40; x < width; x += 40) ctx.strokeRect(x + 0.5, 0, 0, height);
    for (let y = 40; y < height; y += 40) ctx.strokeRect(0, y + 0.5, width, 0);
    if (doc?.style === "holo") {
      // A holo document (I12): drawn as the player draws it, in true colour over the frame.
      const image = ctx.getImageData(0, 0, width, height);
      renderHoloDocument(image.data, width, height, doc, { bindings, time: 0.6 });
      ctx.putImageData(image, 0, 0);
      placedRef.current = layoutUi(doc, width, height);
      const sel = placedRef.current.find((p) => p.widget.id === selected);
      if (sel) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w, sel.h);
        ctx.setLineDash([]);
      }
    } else placedRef.current = doc ? drawUiPreview(ctx, doc, { width, height, palette, bindings, focus, selected }) : [];
  }, [doc, width, height, palette, bindings, focus, selected]);

  /** A pointer event in screen pixels of the console. */
  const toScreen = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * width, ((event.clientY - rect.top) / rect.height) * height] as const;
  };

  /** Try the d-pad: focus moves the way the cart's will. */
  const onKey = (event: React.KeyboardEvent) => {
    if (!doc) return;
    const dirs: Record<string, number> = { ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3 };
    const dir = dirs[event.key];
    if (dir === undefined) return;
    event.preventDefault();
    const placed = layoutUi(doc, width, height);
    const nav = uiNavigation(placed);
    const at = placed.findIndex((p) => p.widget.id === focus);
    const firstFocusable = [...nav.keys()][0];
    const from = at >= 0 && nav.has(at) ? at : firstFocusable;
    if (from === undefined) return;
    const to = at >= 0 && nav.has(at) ? nav.get(from)![dir]! : from;
    if (to >= 0) setFocus(placed[to]!.widget.id);
  };

  const colour = (label: string, key: "color" | "fill" | "border" | "focusFill" | "focusColor", optional = true) => (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.7 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 2 }}>
        {optional && (
          <button type="button" aria-label={`${label}: none`} title="None" onClick={() => setWidget({ [key]: undefined })} style={{ width: 16, height: 16, border: widget?.[key] === undefined ? "2px solid #7db8fc" : "1px solid #444", background: "repeating-linear-gradient(45deg,#333 0 3px,#222 3px 6px)" }} />
        )}
        {palette.slice(0, 16).map((c, i) => (
          <button key={i} type="button" aria-label={`${label}: colour ${i}`} title={`Colour ${i}`} onClick={() => setWidget({ [key]: i })} style={{ width: 16, height: 16, background: `rgb(${c[0]},${c[1]},${c[2]})`, border: widget?.[key] === i ? "2px solid #7db8fc" : "1px solid #444" }} />
        ))}
      </div>
    </div>
  );
  const num = (label: string, value: number, onChange: (v: number) => void) => (
    <label style={{ fontSize: 12, display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
      {label}
      <input type="number" value={value} onChange={(event) => Number.isFinite(Number(event.target.value)) && onChange(Number(event.target.value))} style={{ minWidth: 0 }} />
    </label>
  );
  const binding = (label: string, key: "value" | "visible" | "tint", hint: string) => (
    <label style={{ fontSize: 12, display: "flex", flexDirection: "column", marginTop: 4 }} title={hint}>
      {label}
      <input value={widget?.[key] ?? ""} placeholder="none" onChange={(event) => setWidget({ [key]: /^\w+$/.test(event.target.value) ? event.target.value : undefined })} />
    </label>
  );

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* Left: documents and the widget tree */}
      <aside style={{ width: 240, padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <RailGroup label="Documents">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {docs.map((d) => (
              <button key={d.name} type="button" className={`${styles.toolBtn} ${doc?.name === d.name ? styles.toolBtnActive : ""}`} onClick={() => { setDocName(d.name); setSelected(null); setFocus(null); }}>
                {d.name}
              </button>
            ))}
          </div>
          <button type="button" className="cbx-btn" style={{ marginTop: 6 }} onClick={() => { const made = addUiDocument(sidecar); onSidecarChange(made.sidecar); setDocName(made.name); setSelected(null); }}>
            New document
          </button>
          {doc && (
            <>
              <input key={doc.name} aria-label="Document name" defaultValue={doc.name} style={{ marginTop: 6, width: "100%" }} onBlur={(event) => { const name = event.target.value.trim(); if (/^\w{1,32}$/.test(name) && name !== doc.name && !docs.some((d) => d.name === name)) { onSidecarChange(replaceUiDocument(sidecar, doc.name, { ...doc, name })); setDocName(name); } }} />
              <button type="button" className="cbx-btn" style={{ marginTop: 4 }} onClick={() => { onSidecarChange(removeUiDocument(sidecar, doc.name)); setDocName(null); setSelected(null); }}>
                Delete document
              </button>
              <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 8 }} title="Drawn by the player in true colour over the finished frame: vector text at any size, thin glowing lines, arcs and a radar, curving toward the screen's edges (needs the 3D runtime)">
                <input type="checkbox" checked={doc.style === "holo"} onChange={(event) => setDoc(event.target.checked ? { ...doc, style: "holo", curve: doc.curve ?? 0.4, glow: doc.glow ?? 1 } : { name: doc.name, widgets: doc.widgets })} />
                Holographic
              </label>
              {doc.style === "holo" && (
                <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                  {num("Curve", doc.curve ?? 0, (v) => setDoc({ ...doc, curve: Math.max(0, Math.min(1, v)) }))}
                  {num("Glow", doc.glow ?? 1, (v) => setDoc({ ...doc, glow: Math.max(0, Math.min(2, v)) }))}
                </div>
              )}
            </>
          )}
        </RailGroup>
        {doc && (
          <RailGroup label="Widgets">
            <div role="tree" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {flattenWidgets(doc.widgets).map(({ widget: w, depth }) => (
                <button key={w.id} type="button" role="treeitem" aria-selected={selected === w.id} className={`${styles.toolBtn} ${selected === w.id ? styles.toolBtnActive : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setSelected(w.id)}>
                  <span style={{ opacity: 0.55, fontSize: 11, width: 46 }}>{KIND_LABEL[w.kind]}</span> {w.id}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              <select aria-label="Widget kind" value={kind} onChange={(event) => setKind(event.target.value as UiKind)} style={{ flex: 1, minWidth: 0 }}>
                {UI_KINDS.filter((k) => doc.style === "holo" || !HOLO_KINDS.has(k)).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <button type="button" className="cbx-btn" onClick={() => { const made = addWidget(doc, kind, widget?.kind === "panel" ? widget.id : null); setDoc(made.doc); setSelected(made.id); }} title={widget?.kind === "panel" ? `Add inside ${widget.id}` : "Add to the screen"}>
                {widget?.kind === "panel" ? "Add inside" : "Add"}
              </button>
            </div>
            {widget && (
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <button type="button" className="cbx-btn" onClick={() => setDoc(reorderWidget(doc, widget.id, -1))} title="Draw earlier (under its siblings)">
                  ↑
                </button>
                <button type="button" className="cbx-btn" onClick={() => setDoc(reorderWidget(doc, widget.id, 1))} title="Draw later (over its siblings)">
                  ↓
                </button>
                <button type="button" className="cbx-btn" onClick={() => { setDoc(removeWidget(doc, widget.id)); setSelected(null); }}>
                  Delete
                </button>
              </div>
            )}
          </RailGroup>
        )}
      </aside>

      {/* Centre: the preview at the console's resolution */}
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: 12, gap: 8 }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {doc ? (
            <canvas
              ref={canvasRef}
              tabIndex={0}
              aria-label={`${doc.name} preview — click a widget to select it, drag to move it, arrow keys try the focus`}
              onKeyDown={onKey}
              onPointerDown={(event) => {
                event.currentTarget.focus();
                const [x, y] = toScreen(event);
                const id = widgetAt(placedRef.current, x, y);
                setSelected(id);
                const w = id ? findWidget(doc, id) : null;
                if (w) {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = { id: w.id, x, y, offset: w.offset };
                }
              }}
              onPointerMove={(event) => {
                const d = drag.current;
                if (!d) return;
                const [x, y] = toScreen(event);
                setDoc(updateWidget(doc, d.id, { offset: [Math.round(d.offset[0] + x - d.x), Math.round(d.offset[1] + y - d.y)] }));
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              style={{ maxWidth: "100%", maxHeight: "100%", aspectRatio: `${width} / ${height}`, imageRendering: "pixelated", border: "1px solid #2a2d3a", cursor: "default", outline: "none" }}
            />
          ) : (
            <RailHint>Make a document — a start menu, a pause screen, a HUD — and lay out its widgets here.</RailHint>
          )}
        </div>
        {doc && (
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            Preview values
            <input value={bindingText} onChange={(event) => setBindingText(event.target.value)} placeholder="score=12; items=Slayer,Oddball,King; hp=0.4" style={{ flex: 1 }} />
          </label>
        )}
      </section>

      {/* Right: the selected widget */}
      <aside style={{ width: 270, padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        {widget && doc ? (
          <RailGroup label={`${KIND_LABEL[widget.kind]} · ${widget.id}`}>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column" }}>
              Id (what cartbox.ui.update returns, and cartbox.ui.on listens to)
              <input key={widget.id} defaultValue={widget.id} onBlur={(event) => { const id = event.target.value.trim(); if (/^[\w-]{1,32}$/.test(id) && id !== widget.id && !findWidget(doc, id)) { setDoc(updateWidget(doc, widget.id, { id })); setSelected(id); } }} />
            </label>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>Anchor — where it hangs on its parent</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 22px)", gap: 3, marginTop: 4 }}>
              {ANCHORS.map(([ax, ay]) => {
                const on = widget.anchor[0] === ax && widget.anchor[1] === ay;
                return <button key={`${ax},${ay}`} type="button" aria-label={`Anchor ${ax},${ay}`} aria-pressed={on} onClick={() => setWidget({ anchor: [ax, ay], pivot: [ax, ay], offset: [0, 0] })} style={{ width: 22, height: 22, background: on ? "#7db8fc" : "#2a2d3a", border: "1px solid #444" }} />;
              })}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              {num("X", widget.offset[0], (v) => setWidget({ offset: [v, widget.offset[1]] }))}
              {num("Y", widget.offset[1], (v) => setWidget({ offset: [widget.offset[0], v] }))}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              {num("Width", widget.size[0], (v) => setWidget({ size: [Math.max(0, v), widget.size[1]] }))}
              {num("Height", widget.size[1], (v) => setWidget({ size: [widget.size[0], Math.max(0, v)] }))}
            </div>
            {(widget.kind === "text" || widget.kind === "button") && (
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", marginTop: 6 }}>
                Text ({"{key}"} shows a binding)
                <input value={widget.text ?? ""} onChange={(event) => setWidget({ text: event.target.value })} />
              </label>
            )}
            {(widget.kind === "text" || widget.kind === "button" || widget.kind === "list") && (
              <div style={{ display: "flex", gap: 4, marginTop: 6, alignItems: "flex-end" }}>
                {num("Size", widget.scale ?? 1, (v) => setWidget({ scale: Math.max(1, Math.min(4, Math.round(v))) }))}
                <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
                  <input type="checkbox" checked={Boolean(widget.small)} onChange={(event) => setWidget({ small: event.target.checked || undefined })} />
                  Small font
                </label>
              </div>
            )}
            {(widget.kind === "text" || widget.kind === "button" || widget.kind === "list") && (
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} type="button" className={`${styles.toolBtn} ${(widget.align ?? "left") === a ? styles.toolBtnActive : ""}`} style={{ flex: 1, justifyContent: "center" }} onClick={() => setWidget({ align: a })}>
                    {a}
                  </button>
                ))}
              </div>
            )}
            {widget.kind === "list" && num("Row height", widget.row ?? 12, (v) => setWidget({ row: Math.max(4, v) }))}
            {doc.style === "holo" && (
              <>
                <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                  Colour
                  <input type="color" aria-label="Holo colour" value={hex(widget.rgb ?? HOLO_RGB)} onChange={(event) => setWidget({ rgb: fromHex(event.target.value) })} />
                </label>
                {(widget.kind === "text" || widget.kind === "button" || widget.kind === "list") && num("Text height (px)", widget.textSize ?? (widget.scale ?? 1) * 6, (v) => setWidget({ textSize: Math.max(2, Math.min(256, v)) }))}
                {widget.kind === "arc" && (
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    {num("Start °", widget.start ?? 0, (v) => setWidget({ start: v }))}
                    {num("Sweep °", widget.sweep ?? 360, (v) => setWidget({ sweep: Math.max(-360, Math.min(360, v)) }))}
                    {num("Segments", widget.segments ?? 1, (v) => setWidget({ segments: Math.max(1, Math.min(64, Math.round(v))) }))}
                  </div>
                )}
                {num("Line (px)", widget.thickness ?? 1.5, (v) => setWidget({ thickness: Math.max(0.5, Math.min(64, v)) }))}
              </>
            )}
            {widget.kind === "image" && (
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                {num("Sprite", widget.sprite ?? 0, (v) => setWidget({ sprite: Math.max(0, Math.round(v)) }))}
                {num("Tiles W", widget.tiles?.[0] ?? 1, (v) => setWidget({ tiles: [Math.max(1, v), widget.tiles?.[1] ?? 1] }))}
                {num("Tiles H", widget.tiles?.[1] ?? 1, (v) => setWidget({ tiles: [widget.tiles?.[0] ?? 1, Math.max(1, v)] }))}
              </div>
            )}
            {widget.kind !== "image" && colour(widget.kind === "panel" ? "Colour (unused)" : widget.kind === "bar" || widget.kind === "slider" ? "Fill colour" : "Text colour", "color", false)}
            {widget.kind !== "image" && colour("Background", "fill")}
            {(widget.kind === "panel" || widget.kind === "bar" || widget.kind === "button") && colour("Outline", "border")}
            {(widget.kind === "button" || widget.kind === "list") && colour(widget.kind === "list" ? "Selected row" : "Focused background", "focusFill")}
            {(widget.kind === "button" || widget.kind === "list" || widget.kind === "slider") && colour(widget.kind === "list" ? "Selected text" : "Focused colour", "focusColor")}
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 10 }}>Bindings — set from code with cartbox.ui.set(key, value)</div>
            {(widget.kind === "bar" || widget.kind === "slider" || widget.kind === "list" || widget.kind === "arc") && binding(widget.kind === "list" ? "Items" : "Value (0..1)", "value", widget.kind === "list" ? "A table of strings, or { text, color }" : "A number from 0 to 1")}
            {widget.kind === "radar" && binding("Blips", "value", "A table of numbers, three a blip: x and y (−1..1 across the radar, y down) and kind (0 friendly, 1 hostile, 2 objective)")}
            {binding("Visible while", "visible", "Drawn only while this binding is truthy")}
            {binding("Colour from", "tint", doc.style === "holo" ? "A colour as \"#rrggbb\" that overrides the colour while set" : "A palette index that overrides the colour while set")}
          </RailGroup>
        ) : (
          <RailHint>Select a widget (in the list or the preview) to edit it.</RailHint>
        )}
        {doc && (
          <RailHint>
            In code: cartbox.ui.show(&quot;{doc.name}&quot;) puts it up; cartbox.ui.set(&quot;score&quot;, 12) fills {"{score}"}; each tick call cartbox.ui.update() (d-pad focus, A presses: it returns the id) and cartbox.ui.draw().
          </RailHint>
        )}
      </aside>
    </div>
  );
}
