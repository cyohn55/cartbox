"use client";

/**
 * The material graph editor (ENGINE_PARITY_ROADMAP.md EP7): a node canvas over
 * the editor, as Unity's Shader Graph and Unreal's Material Editor have.
 *
 * - **Nodes** come from the palette (surface inputs, patterns, maths) or a
 *   starter graph; drag a node by its title, × removes it.
 * - **Wires** run from a node's output (its right edge) to another node's
 *   input or to one of the material's outputs; drop a wire on an input that
 *   already has one to replace it, click a wired input to unwire it. A wire
 *   that would loop back is refused.
 * - **Params** (a value's colour, noise scale, fresnel power…) are edited on
 *   the node.
 * - **Preview:** a lit sphere wearing the material, animated when the graph
 *   reads time; the scene view shows it on the real mesh.
 *
 * Fully controlled: the graph comes in, every edit goes out through `onChange`
 * (a node drag only when it's dropped, so the scene isn't rebuilt per pixel).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { GRAPH_NODES, GRAPH_OUTPUTS, compileGraph, type GraphNode, type GraphOp, type GraphOutput, type MaterialGraph, type MeshMaterial } from "@cartbox/editor";

import {
  GRAPH_PRESETS,
  NODE_HEADER,
  NODE_ROW,
  NODE_WIDTH,
  OUTPUT_AT,
  addNode,
  connect,
  disconnect,
  inputPort,
  materialPort,
  moveNode,
  outputPort,
  removeNode,
  renderGraphPreview,
  setOutput,
  setParams,
} from "@/lib/materialGraphEdit";
import styles from "./editor.module.css";

const OUTPUT_LABELS: Record<GraphOutput, string> = {
  baseColor: "Base colour",
  alpha: "Alpha",
  emissive: "Emissive",
  metallic: "Metallic",
  roughness: "Roughness",
};
const CATEGORIES: { id: "input" | "pattern" | "maths"; label: string }[] = [
  { id: "input", label: "Inputs" },
  { id: "pattern", label: "Patterns" },
  { id: "maths", label: "Maths" },
];
const PREVIEW = 128;

/** Rows of params a node shows under its inputs. */
function paramRows(op: GraphOp): number {
  return op === "constant" ? 1 : op === "noise" ? 2 : op === "fresnel" || op === "texture" || op === "split" ? 1 : 0;
}
function nodeHeight(node: GraphNode): number {
  return NODE_HEADER + (GRAPH_NODES[node.op].inputs.length + paramRows(node.op)) * NODE_ROW + 6;
}

const hex = (v: readonly number[]) => `#${v.map((c) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, "0")).join("")}`;
const unhex = (s: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0, 0, 0];
};
const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
};

export function GraphEditor({
  material,
  onChange,
  onClose,
}: {
  material: MeshMaterial;
  /** The next graph, or undefined to take it off the material. */
  onChange: (graph: MaterialGraph | undefined) => void;
  onClose: () => void;
}) {
  const graph = material.graph!;
  const [pan, setPan] = useState({ x: 20, y: 20 });
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ kind: "pan" | "node"; id?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);

  // The graph as shown: a node being dragged sits where the pointer is.
  const shown = useMemo(() => (drag ? moveNode(graph, drag.id, drag.x, drag.y) : graph), [graph, drag]);
  const byId = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown]);

  // --- Preview ---------------------------------------------------------------------------
  const previewRef = useRef<HTMLCanvasElement>(null);
  const animated = useMemo(() => compileGraph(graph)?.steps.some((s) => s.op === "time") ?? false, [graph]);
  useEffect(() => {
    const canvas = previewRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = -1;
    const start = performance.now();
    const paint = (now: number) => {
      const time = (now - start) / 1000;
      if (last < 0 || (animated && now - last > 120)) {
        last = now;
        const pixels = renderGraphPreview(material, PREVIEW, time);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), PREVIEW, PREVIEW), 0, 0);
      }
      if (animated) raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [material, animated]);

  // --- Pointer gestures --------------------------------------------------------------------
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - pan.x, y: clientY - rect.top - pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (wire) {
      const p = toCanvas(e.clientX, e.clientY);
      setWire({ ...wire, x: p.x, y: p.y });
      return;
    }
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === "pan") setPan({ x: g.originX + dx, y: g.originY + dy });
    else setDrag({ id: g.id!, x: g.originX + dx, y: g.originY + dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (wire) {
      // Dropped on a port? Ports carry where they lead in data attributes.
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-port]");
      if (target?.dataset.node && target.dataset.input) onChange(connect(graph, wire.from, target.dataset.node, target.dataset.input));
      else if (target?.dataset.output) onChange(setOutput(graph, target.dataset.output as GraphOutput, wire.from));
      setWire(null);
    }
    if (gesture.current?.kind === "node" && drag) onChange(moveNode(graph, drag.id, drag.x, drag.y));
    gesture.current = null;
    setDrag(null);
  };

  const add = (op: GraphOp) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const at = { x: (rect ? rect.width / 2 : 300) - pan.x - NODE_WIDTH / 2 + (graph.nodes.length % 5) * 14, y: 60 - pan.y + (graph.nodes.length % 7) * 18 };
    onChange(addNode(graph, op, at).graph);
  };

  // --- Wires --------------------------------------------------------------------------------
  const wires: { key: string; d: string }[] = [];
  for (const node of shown.nodes) {
    GRAPH_NODES[node.op].inputs.forEach(([name], i) => {
      const from = node.inputs?.[name];
      const source = from ? byId.get(from) : undefined;
      if (source) wires.push({ key: `${node.id}.${name}`, d: curve(outputPort(source), inputPort(node, i)) });
    });
  }
  for (const output of GRAPH_OUTPUTS) {
    const source = shown.outputs[output] ? byId.get(shown.outputs[output]!) : undefined;
    if (source) wires.push({ key: `out.${output}`, d: curve(outputPort(source), materialPort(output, GRAPH_OUTPUTS)) });
  }
  const pending = wire && byId.get(wire.from) ? curve(outputPort(byId.get(wire.from)!), { x: wire.x, y: wire.y }) : null;

  const port: React.CSSProperties = { width: 12, height: 12, borderRadius: 6, border: "2px solid #9ad", background: "#123", flex: "0 0 auto", cursor: "crosshair" };
  const number = (value: number, onValue: (v: number) => void, step = 0.1, label = "") => (
    <input
      type="number"
      aria-label={label}
      step={step}
      value={Number(value.toFixed(3))}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onValue(v);
      }}
      style={{ width: 58, fontSize: 11, padding: "1px 3px" }}
    />
  );

  return (
    <div
      role="dialog"
      aria-label="Material graph"
      style={{ position: "fixed", inset: "4vh 3vw", zIndex: 60, display: "flex", flexDirection: "column", background: "#0d1118", border: "1px solid #2a3444", borderRadius: 10, boxShadow: "0 20px 60px rgba(0,0,0,0.6)", color: "#dde", overflow: "hidden" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid #223" }}>
        <strong style={{ fontSize: 13 }}>Material graph — {material.name || "material"}</strong>
        <select
          aria-label="Start from"
          value=""
          onChange={(e) => {
            const preset = GRAPH_PRESETS[e.target.value];
            if (preset) onChange(preset.graph());
          }}
          style={{ fontSize: 12 }}
        >
          <option value="">Start from…</option>
          {Object.entries(GRAPH_PRESETS).map(([name, preset]) => (
            <option key={name} value={name} title={preset.hint}>
              {name}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.toolBtn} onClick={() => onChange(undefined)} title="Take the graph off: the material's own settings apply again">
          Remove graph
        </button>
        <button type="button" className={styles.toolBtn} onClick={onClose}>
          Done
        </button>
      </div>
      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        <div style={{ width: 150, flex: "0 0 auto", overflowY: "auto", padding: 8, borderRight: "1px solid #223", display: "flex", flexDirection: "column", gap: 4 }}>
          <canvas ref={previewRef} width={PREVIEW} height={PREVIEW} aria-label="Preview" style={{ width: PREVIEW, height: PREVIEW, borderRadius: 6, alignSelf: "center" }} />
          {CATEGORIES.map((cat) => (
            <div key={cat.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>{cat.label}</div>
              {(Object.keys(GRAPH_NODES) as GraphOp[])
                .filter((op) => GRAPH_NODES[op].category === cat.id)
                .map((op) => (
                  <button key={op} type="button" className={styles.toolBtn} style={{ fontSize: 11, padding: "2px 6px", textAlign: "left" }} onClick={() => add(op)}>
                    + {GRAPH_NODES[op].label}
                  </button>
                ))}
            </div>
          ))}
        </div>
        <div
          ref={canvasRef}
          style={{ position: "relative", flex: "1 1 auto", overflow: "hidden", touchAction: "none", cursor: gesture.current?.kind === "pan" ? "grabbing" : "default", backgroundImage: "radial-gradient(#223 1px, transparent 1px)", backgroundSize: "20px 20px", backgroundPosition: `${pan.x}px ${pan.y}px` }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, originX: pan.x, originY: pan.y };
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div style={{ position: "absolute", left: pan.x, top: pan.y, pointerEvents: "none" }}>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={1} height={1} aria-hidden>
              {wires.map((w) => (
                <path key={w.key} d={w.d} stroke="#6cf" strokeWidth={2} fill="none" opacity={0.85} />
              ))}
              {pending && <path d={pending} stroke="#ffd84a" strokeWidth={2} fill="none" strokeDasharray="5 4" />}
            </svg>
          </div>
          <div style={{ position: "absolute", left: pan.x, top: pan.y }}>
            {shown.nodes.map((node) => {
              const def = GRAPH_NODES[node.op];
              const p = node.params ?? {};
              return (
                <div
                  key={node.id}
                  style={{ position: "absolute", left: node.x ?? 0, top: node.y ?? 0, width: NODE_WIDTH, height: nodeHeight(node), background: "#18202c", border: "1px solid #34445a", borderRadius: 6, fontSize: 11, boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}
                >
                  <div
                    style={{ height: NODE_HEADER, display: "flex", alignItems: "center", gap: 4, padding: "0 4px 0 8px", background: def.category === "maths" ? "#243048" : def.category === "pattern" ? "#3a2a48" : "#24402e", borderRadius: "6px 6px 0 0", cursor: "grab", position: "relative" }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest("button,[data-port]")) return;
                      canvasRef.current?.setPointerCapture(e.pointerId);
                      gesture.current = { kind: "node", id: node.id, startX: e.clientX, startY: e.clientY, originX: node.x ?? 0, originY: node.y ?? 0 };
                    }}
                  >
                    <span style={{ flex: 1, fontWeight: 600 }}>{def.label}</span>
                    <button type="button" aria-label={`Remove ${def.label}`} onClick={() => onChange(removeNode(graph, node.id))} style={{ background: "none", border: "none", color: "#889", cursor: "pointer", fontSize: 13 }}>
                      ×
                    </button>
                    <span
                      data-port="out"
                      title="Drag to an input"
                      style={{ ...port, position: "absolute", right: -7, top: NODE_HEADER / 2 - 6, borderColor: "#6cf" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        canvasRef.current?.setPointerCapture(e.pointerId);
                        const at = outputPort(node);
                        setWire({ from: node.id, x: at.x, y: at.y });
                      }}
                    />
                  </div>
                  {def.inputs.map(([name]) => {
                    const wired = Boolean(node.inputs?.[name]);
                    return (
                      <div key={name} style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 6, marginLeft: -7 }}>
                        <span
                          data-port="in"
                          data-node={node.id}
                          data-input={name}
                          title={wired ? "Click to unwire" : "Drop a wire here"}
                          style={{ ...port, background: wired ? "#6cf" : "#123" }}
                          onClick={() => wired && onChange(disconnect(graph, node.id, name))}
                        />
                        <span style={{ opacity: wired ? 1 : 0.7 }}>{name}</span>
                      </div>
                    );
                  })}
                  {node.op === "constant" && (
                    <div style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
                      <input type="color" aria-label="Colour" value={hex(p.value as number[])} onChange={(e) => onChange(setParams(graph, node.id, { value: unhex(e.target.value) }))} style={{ width: 28, height: 18, padding: 0, border: "none", background: "none" }} />
                      {number((p.value as number[])[0]!, (v) => onChange(setParams(graph, node.id, { value: v })), 0.1, "Value")}
                    </div>
                  )}
                  {node.op === "fresnel" && (
                    <div style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
                      power {number(p.power as number, (v) => onChange(setParams(graph, node.id, { power: v })), 0.5, "Power")}
                    </div>
                  )}
                  {node.op === "noise" && (
                    <>
                      <div style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
                        scale {number(p.scale as number, (v) => onChange(setParams(graph, node.id, { scale: v })), 0.5, "Scale")}
                      </div>
                      <div style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
                        octaves
                        <select aria-label="Octaves" value={p.octaves as number} onChange={(e) => onChange(setParams(graph, node.id, { octaves: Number(e.target.value) }))} style={{ fontSize: 11 }}>
                          {[1, 2, 3, 4].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                  {node.op === "texture" && (
                    <div style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
                      <select aria-label="Channel" value={p.channel as string} onChange={(e) => onChange(setParams(graph, node.id, { channel: e.target.value }))} style={{ fontSize: 11 }}>
                        <option value="rgb">colour</option>
                        <option value="a">alpha</option>
                      </select>
                    </div>
                  )}
                  {node.op === "split" && (
                    <div style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
                      <select aria-label="Component" value={p.component as number} onChange={(e) => onChange(setParams(graph, node.id, { component: Number(e.target.value) }))} style={{ fontSize: 11 }}>
                        <option value={0}>x / r</option>
                        <option value={1}>y / g</option>
                        <option value={2}>z / b</option>
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ position: "absolute", left: OUTPUT_AT.x, top: OUTPUT_AT.y, width: NODE_WIDTH, background: "#22180f", border: "1px solid #6a4a2a", borderRadius: 6, fontSize: 11 }}>
              <div style={{ height: NODE_HEADER, display: "flex", alignItems: "center", padding: "0 8px", fontWeight: 600, background: "#4a3018", borderRadius: "6px 6px 0 0" }}>Material output</div>
              {GRAPH_OUTPUTS.map((output) => {
                const wired = Boolean(graph.outputs[output]);
                return (
                  <div key={output} style={{ height: NODE_ROW, display: "flex", alignItems: "center", gap: 6, marginLeft: -7 }}>
                    <span
                      data-port="material"
                      data-output={output}
                      title={wired ? "Click to give it back to the material" : "Drop a wire here"}
                      style={{ ...port, background: wired ? "#fa6" : "#123", borderColor: "#fa6" }}
                      onClick={() => wired && onChange(setOutput(graph, output, null))}
                    />
                    <span style={{ opacity: wired ? 1 : 0.6 }}>{OUTPUT_LABELS[output]}</span>
                  </div>
                );
              })}
              <div style={{ height: 6 }} />
            </div>
          </div>
        </div>
      </div>
      <div style={{ padding: "4px 10px", fontSize: 11, opacity: 0.6, borderTop: "1px solid #223" }}>
        Drag from a node&apos;s right edge to an input or a material output · click a wired input to unwire it · drag the background to pan
      </div>
    </div>
  );
}
