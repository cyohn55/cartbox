"use client";

/**
 * The visual script editor (ENGINE_PARITY_ROADMAP.md EP16): a component's
 * logic as a node graph, in the spirit of Unreal's Blueprints.
 *
 * - **Nodes** come from the palette: events start a chain, flow nodes branch,
 *   sequence and loop, actions do things, values and maths feed them. Drag a
 *   node by its title; × removes it. A node with a name setting (an action, a
 *   sound, a variable) edits it under the title.
 * - **Wires** run from an output pin (right) to an input pin (left): white
 *   execution wires order the actions, coloured data wires carry values. A
 *   wire only joins pins that fit; dropping onto a taken pin replaces it;
 *   clicking a wired input unwires it. An unwired input uses the value typed
 *   beside it.
 * - **Variables** are the component's fields, set per object in the inspector.
 * - **Lua:** what the graph compiles to, read-only, beside the canvas.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { SCRIPT_NODES, compileScriptGraph, type PinDef, type PinType, type ScriptCategory, type ScriptGraph, type ScriptNode, type ScriptNodeKind, type ScriptVariable } from "@cartbox/editor";

import {
  SCRIPT_NODE_HEADER,
  SCRIPT_NODE_WIDTH,
  SCRIPT_PARAM_ROW,
  SCRIPT_ROW,
  addScriptNode,
  addScriptVariable,
  connectScriptPins,
  disconnectScriptInput,
  freeScriptSpot,
  moveScriptNode,
  removeScriptNode,
  removeScriptVariable,
  scriptNodeHeight,
  scriptPinAt,
  setScriptParam,
  setScriptValue,
  updateScriptVariable,
} from "@/lib/scriptGraphEdit";
import styles from "./editor.module.css";

const CATEGORIES: { id: ScriptCategory; label: string; colour: string }[] = [
  { id: "event", label: "Events", colour: "#5a2424" },
  { id: "flow", label: "Flow", colour: "#3c3c4a" },
  { id: "action", label: "Actions", colour: "#24405a" },
  { id: "value", label: "Values", colour: "#24402e" },
  { id: "maths", label: "Maths & logic", colour: "#3a2a48" },
];
const PIN_COLOUR: Record<PinType, string> = { exec: "#eee", number: "#6cf", bool: "#f66", text: "#e7a", object: "#fb4", any: "#aaa" };

const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
};

type Def = { label: string; category: ScriptCategory; inputs: readonly PinDef[]; outputs: readonly PinDef[]; param?: { label: string; value: string }; doc: string };
const defOf = (kind: ScriptNodeKind) => SCRIPT_NODES[kind] as Def;

export function ScriptGraphEditor({ name, graph, onChange, onClose }: { name: string; graph: ScriptGraph; onChange: (graph: ScriptGraph) => void; onClose: () => void }) {
  const [pan, setPan] = useState({ x: 20, y: 20 });
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [wire, setWire] = useState<{ from: string; pin: string; x: number; y: number } | null>(null);
  const [varError, setVarError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ kind: "pan" | "node"; id?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const shown = useMemo(() => (drag ? moveScriptNode(graph, drag.id, drag.x, drag.y) : graph), [graph, drag]);
  const byId = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown]);
  const lua = useMemo(() => compileScriptGraph(graph, name), [graph, name]);
  const wiredInputs = useMemo(() => new Set(graph.wires.map((w) => `${w.to}:${w.toPin}`)), [graph]);

  // Open with the whole graph in view: zoomed out (never in) to fit it.
  useEffect(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || graph.nodes.length === 0) return;
    const minX = Math.min(...graph.nodes.map((n) => n.x));
    const minY = Math.min(...graph.nodes.map((n) => n.y));
    const width = Math.max(...graph.nodes.map((n) => n.x + SCRIPT_NODE_WIDTH)) - minX + 40;
    const height = Math.max(...graph.nodes.map((n) => n.y + scriptNodeHeight(n))) - minY + 40;
    const fit = Math.max(0.35, Math.min(1, rect.width / width, rect.height / height));
    setZoom(fit);
    setPan({ x: 20 - minX * fit, y: 20 - minY * fit });
    // Only on opening: later edits keep the view where the creator left it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toCanvas = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (wire) {
      const p = toCanvas(e.clientX, e.clientY);
      setWire({ ...wire, x: p.x, y: p.y });
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === "pan") setPan({ x: g.originX + dx, y: g.originY + dy });
    else setDrag({ id: g.id!, x: g.originX + dx / zoom, y: g.originY + dy / zoom });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (wire) {
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-pin-in]");
      if (target?.dataset.node && target.dataset.pinIn) {
        const next = connectScriptPins(graph, wire.from, wire.pin, target.dataset.node, target.dataset.pinIn);
        if (next) onChange(next);
      }
      setWire(null);
    }
    if (gesture.current?.kind === "node" && drag) onChange(moveScriptNode(graph, drag.id, drag.x, drag.y));
    gesture.current = null;
    setDrag(null);
  };

  const add = (kind: ScriptNodeKind) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const at = freeScriptSpot(graph, { x: ((rect ? rect.width / 3 : 200) - pan.x) / zoom, y: (40 - pan.y) / zoom }, kind);
    onChange(addScriptNode(graph, kind, at).graph);
  };

  const wires = shown.wires.flatMap((w) => {
    const a = byId.get(w.from);
    const b = byId.get(w.to);
    if (!a || !b) return [];
    const type = defOf(a.kind).outputs.find((p) => p.name === w.fromPin)?.type ?? "any";
    return [{ key: `${w.from}.${w.fromPin}>${w.to}.${w.toPin}`, d: curve(scriptPinAt(a, "out", w.fromPin), scriptPinAt(b, "in", w.toPin)), colour: PIN_COLOUR[type], exec: type === "exec" }];
  });
  const pendingFrom = wire ? byId.get(wire.from) : undefined;
  const pending = wire && pendingFrom ? curve(scriptPinAt(pendingFrom, "out", wire.pin), { x: wire.x, y: wire.y }) : null;

  const pinStyle = (type: PinType, filled: boolean): React.CSSProperties =>
    type === "exec"
      ? { width: 0, height: 0, borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderLeft: `9px solid ${filled ? PIN_COLOUR.exec : "#667"}`, flex: "0 0 auto", cursor: "crosshair" }
      : { width: 11, height: 11, borderRadius: 6, border: `2px solid ${PIN_COLOUR[type]}`, background: filled ? PIN_COLOUR[type] : "#123", flex: "0 0 auto", cursor: "crosshair" };

  const valueInput = (node: ScriptNode, pin: PinDef) => {
    const v = node.values?.[pin.name] ?? pin.value;
    const set = (value: number | boolean | string) => onChange(setScriptValue(graph, node.id, pin.name, value));
    if (pin.type === "object") return <span style={{ opacity: 0.5 }}>this</span>;
    if (pin.type === "bool") return <input type="checkbox" aria-label={pin.name} checked={v === true} onChange={(e) => set(e.target.checked)} />;
    if (pin.type === "number")
      return <input type="number" aria-label={pin.name} step="any" defaultValue={String(v ?? 0)} key={String(v)} onBlur={(e) => Number.isFinite(Number(e.target.value)) && set(Number(e.target.value))} style={{ width: 56, fontSize: 11, padding: "1px 3px" }} />;
    if (pin.type === "any")
      // A number, true/false, or else text.
      return (
        <input
          aria-label={pin.name}
          defaultValue={String(v ?? "")}
          key={`${typeof v}:${String(v)}`}
          onBlur={(e) => {
            const t = e.target.value;
            set(t.trim() !== "" && Number.isFinite(Number(t)) ? Number(t) : t === "true" ? true : t === "false" ? false : t);
          }}
          style={{ width: 70, fontSize: 11, padding: "1px 3px" }}
        />
      );
    return <input aria-label={pin.name} defaultValue={String(v ?? "")} key={String(v)} onBlur={(e) => set(e.target.value)} style={{ width: 70, fontSize: 11, padding: "1px 3px" }} />;
  };

  return (
    <div
      role="dialog"
      aria-label="Visual script"
      style={{ position: "fixed", inset: "4vh 3vw", zIndex: 60, display: "flex", flexDirection: "column", background: "#0d1118", border: "1px solid #2a3444", borderRadius: 10, boxShadow: "0 20px 60px rgba(0,0,0,0.6)", color: "#dde", overflow: "hidden", userSelect: "none" }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid #223" }}>
        <strong style={{ fontSize: 13 }}>Visual script — {name}</strong>
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.toolBtn} onClick={onClose}>
          Done
        </button>
      </div>
      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        <div style={{ width: 160, flex: "0 0 auto", overflowY: "auto", padding: 8, borderRight: "1px solid #223", display: "flex", flexDirection: "column", gap: 3 }}>
          {CATEGORIES.map((cat) => (
            <div key={cat.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>{cat.label}</div>
              {(Object.keys(SCRIPT_NODES) as ScriptNodeKind[])
                .filter((k) => defOf(k).category === cat.id)
                .map((k) => (
                  <button key={k} type="button" className={styles.toolBtn} title={defOf(k).doc} style={{ fontSize: 11, padding: "2px 6px", textAlign: "left" }} onClick={() => add(k)}>
                    + {defOf(k).label}
                  </button>
                ))}
            </div>
          ))}
        </div>
        <div
          ref={canvasRef}
          style={{ position: "relative", flex: "1 1 auto", overflow: "hidden", touchAction: "none", backgroundImage: "radial-gradient(#223 1px, transparent 1px)", backgroundSize: `${20 * zoom}px ${20 * zoom}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, originX: pan.x, originY: pan.y };
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const next = Math.min(1.5, Math.max(0.35, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            setPan({ x: mx - ((mx - pan.x) * next) / zoom, y: my - ((my - pan.y) * next) / zoom });
            setZoom(next);
          }}
        >
          <div style={{ position: "absolute", left: pan.x, top: pan.y, pointerEvents: "none", transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={1} height={1} aria-hidden>
              {wires.map((w) => (
                <path key={w.key} d={w.d} stroke={w.colour} strokeWidth={w.exec ? 3 : 2} fill="none" opacity={0.85} />
              ))}
              {pending && <path d={pending} stroke="#ffd84a" strokeWidth={2} fill="none" strokeDasharray="5 4" />}
            </svg>
          </div>
          <div style={{ position: "absolute", left: pan.x, top: pan.y, transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
            {shown.nodes.map((node) => {
              const def = defOf(node.kind);
              const rows = Math.max(def.inputs.length, def.outputs.length);
              return (
                <div
                  key={node.id}
                  title={def.doc}
                  style={{ position: "absolute", left: node.x, top: node.y, width: SCRIPT_NODE_WIDTH, height: scriptNodeHeight(node), background: "#18202c", border: "1px solid #34445a", borderRadius: 6, fontSize: 11, boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}
                >
                  <div
                    style={{ height: SCRIPT_NODE_HEADER, display: "flex", alignItems: "center", gap: 4, padding: "0 4px 0 8px", background: CATEGORIES.find((c) => c.id === def.category)!.colour, borderRadius: "6px 6px 0 0", cursor: "grab" }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest("button")) return;
                      canvasRef.current?.setPointerCapture(e.pointerId);
                      gesture.current = { kind: "node", id: node.id, startX: e.clientX, startY: e.clientY, originX: node.x, originY: node.y };
                    }}
                  >
                    <span style={{ flex: 1, fontWeight: 600 }}>{def.label}</span>
                    <button type="button" aria-label={`Remove ${def.label}`} onClick={() => onChange(removeScriptNode(graph, node.id))} style={{ background: "none", border: "none", color: "#aab", cursor: "pointer", fontSize: 13 }}>
                      ×
                    </button>
                  </div>
                  {def.param && (
                    <div style={{ height: SCRIPT_PARAM_ROW, display: "flex", alignItems: "center", gap: 4, padding: "0 8px" }}>
                      <span style={{ opacity: 0.7 }}>{def.param.label}</span>
                      {(node.kind === "getVar" || node.kind === "setVar") && graph.variables.length > 0 ? (
                        <select aria-label={def.param.label} value={node.param ?? ""} onChange={(e) => onChange(setScriptParam(graph, node.id, e.target.value))} style={{ flex: 1, minWidth: 0, fontSize: 11 }}>
                          {!graph.variables.some((v) => v.name === node.param) && <option value={node.param ?? ""}>{node.param || "(choose)"}</option>}
                          {graph.variables.map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input aria-label={def.param.label} defaultValue={node.param ?? def.param.value} key={node.param} onBlur={(e) => onChange(setScriptParam(graph, node.id, e.target.value.trim()))} style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "1px 3px" }} />
                      )}
                    </div>
                  )}
                  {Array.from({ length: rows }, (_, i) => {
                    const input = def.inputs[i];
                    const output = def.outputs[i];
                    const wired = input ? wiredInputs.has(`${node.id}:${input.name}`) : false;
                    return (
                      <div key={i} style={{ height: SCRIPT_ROW, display: "flex", alignItems: "center", gap: 5, position: "relative" }}>
                        {input && (
                          <span style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: -6, flex: 1, minWidth: 0 }}>
                            <span
                              data-pin-in={input.name}
                              data-node={node.id}
                              title={wired ? "Click to unwire" : "Drop a wire here"}
                              style={pinStyle(input.type, wired)}
                              onClick={() => wired && onChange(disconnectScriptInput(graph, node.id, input.name))}
                            />
                            {input.type !== "exec" && <span style={{ opacity: 0.75 }}>{input.name}</span>}
                            {input.type !== "exec" && !wired && valueInput(node, input)}
                          </span>
                        )}
                        {!input && <span style={{ flex: 1 }} />}
                        {output && (
                          <span style={{ display: "flex", alignItems: "center", gap: 5, marginRight: -6 }}>
                            <span style={{ opacity: 0.75 }}>{output.type === "exec" && output.name === "then" ? "" : output.name}</span>
                            <span
                              data-pin-out={output.name}
                              title="Drag to an input"
                              style={pinStyle(output.type, true)}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                canvasRef.current?.setPointerCapture(e.pointerId);
                                const at = scriptPinAt(node, "out", output.name);
                                setWire({ from: node.id, pin: output.name, x: at.x, y: at.y });
                              }}
                            />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ width: 280, flex: "0 0 auto", overflowY: "auto", padding: 8, borderLeft: "1px solid #223", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.6 }}>Variables (fields in the inspector)</div>
          {graph.variables.map((v) => (
            <div key={v.name} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11 }}>
              <input
                aria-label="Variable name"
                defaultValue={v.name}
                style={{ width: 80, fontSize: 11 }}
                onBlur={(e) => {
                  const next = updateScriptVariable(graph, v.name, { name: e.target.value.trim() });
                  setVarError(next ? null : "A name is letters, digits and _, not obj or origin, and not one already used.");
                  if (next) onChange(next);
                  else e.target.value = v.name;
                }}
              />
              <select aria-label={`${v.name} type`} value={v.type} onChange={(e) => onChange(updateScriptVariable(graph, v.name, { type: e.target.value as ScriptVariable["type"] }) ?? graph)} style={{ fontSize: 11 }}>
                {(["number", "bool", "text", "object"] as const).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {v.type === "bool" ? (
                <input type="checkbox" aria-label={`${v.name} starts as`} checked={v.value === true} onChange={(e) => onChange(updateScriptVariable(graph, v.name, { value: e.target.checked }) ?? graph)} />
              ) : v.type === "number" ? (
                <input type="number" step="any" aria-label={`${v.name} starts as`} defaultValue={String(v.value)} key={String(v.value)} style={{ width: 56, fontSize: 11 }} onBlur={(e) => Number.isFinite(Number(e.target.value)) && onChange(updateScriptVariable(graph, v.name, { value: Number(e.target.value) }) ?? graph)} />
              ) : (
                <input aria-label={`${v.name} starts as`} defaultValue={String(v.value)} key={String(v.value)} style={{ width: 56, fontSize: 11 }} onBlur={(e) => onChange(updateScriptVariable(graph, v.name, { value: e.target.value }) ?? graph)} />
              )}
              <button type="button" aria-label={`Remove ${v.name}`} onClick={() => onChange(removeScriptVariable(graph, v.name))} style={{ background: "none", border: "none", color: "#aab", cursor: "pointer" }}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className={styles.toolBtn} style={{ fontSize: 11 }} onClick={() => onChange(addScriptVariable(graph))}>
            + Variable
          </button>
          {varError && <div style={{ fontSize: 11, color: "#f99" }}>{varError}</div>}
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>Lua it compiles to</div>
          <pre aria-label="Compiled Lua" style={{ margin: 0, fontSize: 10, lineHeight: 1.35, whiteSpace: "pre-wrap", background: "#0a0d12", padding: 6, borderRadius: 4, userSelect: "text" }}>
            {lua}
          </pre>
        </div>
      </div>
      <div style={{ padding: "4px 10px", fontSize: 11, opacity: 0.6, borderTop: "1px solid #223" }}>
        Drag from an output (right) to an input (left) · white wires order actions, coloured ones carry values · click a wired input to unwire · drag the background to pan, wheel to zoom
      </div>
    </div>
  );
}
