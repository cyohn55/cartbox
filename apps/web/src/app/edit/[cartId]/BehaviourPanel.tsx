"use client";

/**
 * Behaviour trees in the Mesh tab (AAA_PRODUCTION_ROADMAP.md K4): the scene's
 * trees, each edited as an outline of nodes (add a child, change a node's
 * settings, remove it). The cart runs them per agent with cartbox.bt; see
 * behaviourTree.ts in @cartbox/editor.
 */

import { useState } from "react";

import { BT_COMPARES, BT_NODE_TYPES, btChildren, btIds, newBtNode, replaceBtNode, type BehaviourTree, type BtNode, type BtNodeType } from "@cartbox/editor";

import { setMeshBehaviours, type MeshSidecar } from "@/lib/meshSidecar";
import { RailGroup, RailHint } from "./railControls";

const box = { border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 6 } as const;
const row = { fontSize: 12, display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" } as const;

/** One node's row and its children's, indented. */
function NodeRow({ node, depth, root, onRoot }: { node: BtNode; depth: number; root: BtNode; onRoot: (next: BtNode) => void }) {
  const set = (patch: Partial<BtNode>) => onRoot(replaceBtNode(root, node.id, { ...node, ...patch }));
  const kids = btChildren(node.type);
  const canAdd = kids === "many" || (kids === "one" && (node.children?.length ?? 0) === 0);
  const num = (label: string, value: number | undefined, apply: (v: number) => void, step = 0.1) => (
    <label style={row}>
      {label}
      <input type="number" step={step} value={value ?? ""} aria-label={`${node.id} ${label}`} onChange={(e) => apply(Number(e.target.value))} style={{ width: 56 }} />
    </label>
  );
  return (
    <div style={{ marginLeft: depth * 10, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={row}>
        <strong>{node.type}</strong>
        <input aria-label={`${node.id} label`} placeholder={node.id} defaultValue={node.label ?? ""} onBlur={(e) => set({ label: e.target.value || undefined })} style={{ width: 80 }} />
        {node.type === "action" && <input aria-label={`${node.id} action`} defaultValue={node.action ?? ""} onBlur={(e) => set({ action: e.target.value })} style={{ width: 80 }} title="The function the cart registers with cartbox.bt.action(name, fn)" />}
        {(node.type === "condition" || node.type === "set") && <input aria-label={`${node.id} key`} defaultValue={node.key ?? ""} onBlur={(e) => set({ key: e.target.value })} style={{ width: 70 }} title="Blackboard key" />}
        {node.type === "condition" && (
          <select aria-label={`${node.id} test`} value={node.op ?? "truthy"} onChange={(e) => set({ op: e.target.value as BtNode["op"] })}>
            {BT_COMPARES.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        )}
        {(node.type === "set" || (node.type === "condition" && node.op !== "truthy" && node.op !== "falsy")) && (
          <input
            aria-label={`${node.id} value`}
            defaultValue={node.value === undefined ? "" : String(node.value)}
            onBlur={(e) => {
              const t = e.target.value;
              set({ value: t === "true" ? true : t === "false" ? false : t !== "" && Number.isFinite(Number(t)) ? Number(t) : t });
            }}
            style={{ width: 60 }}
          />
        )}
        {(node.type === "wait" || node.type === "cooldown") && num("s", node.seconds, (v) => set({ seconds: v }))}
        {node.type === "repeat" && num("×", node.count, (v) => set({ count: Math.round(v) }), 1)}
        {node.type === "parallel" && num("need", node.need, (v) => set({ need: Math.round(v) }), 1)}
        {canAdd && (
          <select
            aria-label={`Add a child to ${node.id}`}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const child = newBtNode(e.target.value as BtNodeType, btIds(root));
              set({ children: [...(node.children ?? []), child] });
            }}
          >
            <option value="">+ child</option>
            {BT_NODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        {node !== root && (
          <button type="button" className="cbx-btn" aria-label={`Remove ${node.id}`} onClick={() => onRoot(replaceBtNode(root, node.id, null))}>
            ×
          </button>
        )}
      </div>
      {(node.children ?? []).map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} root={root} onRoot={onRoot} />
      ))}
    </div>
  );
}

export function BehaviourPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const trees = sidecar.behaviours ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const write = (next: readonly BehaviourTree[]) => onChange(setMeshBehaviours(sidecar, next));
  return (
    <RailGroup label="Behaviour trees" collapsible defaultOpen={trees.length > 0}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {trees.map((tree) => (
          <div key={tree.name} style={box}>
            <div style={row}>
              <button type="button" className="cbx-btn" style={{ flex: 1, textAlign: "left" }} aria-expanded={open === tree.name} onClick={() => setOpen(open === tree.name ? null : tree.name)}>
                {tree.name} <span style={{ opacity: 0.55, fontSize: 11 }}>· {btIds(tree.root).size} nodes</span>
              </button>
              <button type="button" className="cbx-btn" aria-label={`Delete tree ${tree.name}`} onClick={() => write(trees.filter((t) => t.name !== tree.name))}>
                ×
              </button>
            </div>
            {open === tree.name && (
              <div style={{ marginTop: 6 }}>
                <NodeRow node={tree.root} depth={0} root={tree.root} onRoot={(root) => write(trees.map((t) => (t.name === tree.name ? { ...t, root } : t)))} />
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          className="cbx-btn"
          onClick={() => {
            const name = window.prompt("Tree name (letters, digits, _ . -)")?.trim();
            if (!name || trees.some((t) => t.name === name)) return;
            write([...trees, { name, root: { id: "root", type: "selector", children: [] } }]);
            setOpen(name);
          }}
        >
          + Tree
        </button>
        <RailHint>
          In code: <code>local bot = cartbox.bt.new(&quot;name&quot;, obj)</code>, then <code>cartbox.bt.tick(bot, dt)</code> each frame; register actions with <code>cartbox.bt.action(name, fn)</code>.
          <code> cartbox.bt.watch(bot)</code> shows the running node in the console.
        </RailHint>
      </div>
    </RailGroup>
  );
}
