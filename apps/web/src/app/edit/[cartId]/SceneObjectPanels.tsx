"use client";

/**
 * Scene objects in the Mesh tab (ENGINE_ROADMAP.md, Phase 1): the Hierarchy — the
 * cart's placed meshes as a tree, children under their parents — and the
 * Inspector sections for the selected object's parent, tags and custom
 * properties. The cart's code reaches the same data through cartbox.find,
 * cartbox.tagged and cartbox.prop.
 */

import { useState } from "react";

import { SCENE_PROP_MAX, SCENE_TAG_MAX, isSceneKey, type ScenePropValue } from "@cartbox/editor";

import {
  hierarchyRows,
  parentCandidates,
  setMeshParent,
  setMeshProp,
  setMeshTags,
  type MeshSidecar,
  type MeshSidecarEntry,
} from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint } from "./railControls";

const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 };

/** The placed meshes as a tree; click a row to select it. */
export function HierarchyPanel({
  sidecar,
  selectedId,
  onSelect,
}: {
  sidecar: MeshSidecar;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rows = hierarchyRows(sidecar);
  return (
    <RailGroup label={`Hierarchy · ${sidecar.meshes.length}`}>
      {rows.length === 0 ? (
        <RailHint>No meshes yet. Import one above.</RailHint>
      ) : (
        <div role="tree" aria-label="Scene hierarchy" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {rows.map(({ entry, depth, hasChildren }) => (
            <button
              key={entry.id}
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={entry.id === selectedId}
              className={styles.toolBtn}
              onClick={() => onSelect(entry.id)}
              style={{
                justifyContent: "flex-start",
                paddingLeft: 8 + depth * 14,
                outline: entry.id === selectedId ? "2px solid #7db8fc" : "none",
              }}
              title={entry.tags?.length ? `${entry.name} · ${entry.tags.join(", ")}` : entry.name}
            >
              <span aria-hidden style={{ opacity: 0.55, width: 12, flex: "none" }}>
                {hasChildren ? "▾" : depth > 0 ? "·" : ""}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 - depth * 14 }}>
                {entry.name}
              </span>
              {entry.tags && entry.tags.length > 0 && (
                <span aria-hidden style={{ marginLeft: "auto", opacity: 0.55, fontSize: 11 }}>
                  #{entry.tags.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </RailGroup>
  );
}

/** Parent picker for the selected object (children move with their parent). */
export function ParentPicker({
  sidecar,
  entry,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  onChange: (next: MeshSidecar) => void;
}) {
  const candidates = parentCandidates(sidecar, entry.id);
  return (
    <RailGroup label="Parent">
      <select
        aria-label="Parent object"
        value={entry.parent ?? ""}
        onChange={(event) => onChange(setMeshParent(sidecar, entry.id, event.target.value || null))}
        style={inputStyle}
      >
        <option value="">None (top level)</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <RailHint>
        {entry.parent
          ? "Its transform is relative to the parent, and it moves with it in the game."
          : "Pick a parent to group this object under another one."}
      </RailHint>
    </RailGroup>
  );
}

/** Tags on the selected object, for cartbox.tagged / cartbox.hastag. */
export function TagEditor({
  sidecar,
  entry,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  onChange: (next: MeshSidecar) => void;
}) {
  const [draft, setDraft] = useState("");
  const tags = entry.tags ?? [];
  const valid = isSceneKey(draft.trim()) && !tags.includes(draft.trim());
  const add = () => {
    if (!valid) return;
    onChange(setMeshTags(sidecar, entry.id, [...tags, draft.trim()]));
    setDraft("");
  };
  return (
    <RailGroup label="Tags">
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {tags.map((tag) => (
            <span key={tag} className={styles.toolBtn} style={{ padding: "2px 6px", gap: 4, width: "auto" }}>
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => onChange(setMeshTags(sidecar, entry.id, tags.filter((t) => t !== tag)))}
                style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {tags.length < SCENE_TAG_MAX && (
        <form
          style={{ display: "flex", gap: 4 }}
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            aria-label="New tag"
            placeholder="enemy"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            style={inputStyle}
          />
          <button type="submit" className={styles.toolBtn} disabled={!valid} style={{ width: "auto" }}>
            Add
          </button>
        </form>
      )}
      <RailHint>Letters, digits and _ (not starting with a digit). In code: cartbox.tagged(&quot;enemy&quot;).</RailHint>
    </RailGroup>
  );
}

type PropType = "number" | "text" | "bool";
const typeOf = (v: ScenePropValue): PropType => (typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "text");
const convert = (v: ScenePropValue, type: PropType): ScenePropValue =>
  type === "number" ? (Number.isFinite(Number(v)) ? Number(v) : 0) : type === "bool" ? v === true || v === "true" : String(v);

/** Custom properties on the selected object, for cartbox.prop. */
export function PropertyEditor({
  sidecar,
  entry,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  onChange: (next: MeshSidecar) => void;
}) {
  const [key, setKey] = useState("");
  const props = Object.entries(entry.props ?? {});
  const set = (k: string, v: ScenePropValue | null) => onChange(setMeshProp(sidecar, entry.id, k, v));
  const newKey = key.trim();
  const canAdd = isSceneKey(newKey) && !(entry.props && newKey in entry.props) && props.length < SCENE_PROP_MAX;
  return (
    <RailGroup label="Properties">
      {props.map(([k, v]) => (
        <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 84px 1fr auto", gap: 4, marginBottom: 4, alignItems: "center" }}>
          <span className="data" title={k} style={{ overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>
            {k}
          </span>
          <select aria-label={`${k} type`} value={typeOf(v)} onChange={(event) => set(k, convert(v, event.target.value as PropType))} style={inputStyle}>
            <option value="number">Number</option>
            <option value="text">Text</option>
            <option value="bool">On/off</option>
          </select>
          {typeof v === "boolean" ? (
            <input type="checkbox" aria-label={`${k} value`} checked={v} onChange={(event) => set(k, event.target.checked)} />
          ) : (
            <input
              aria-label={`${k} value`}
              type={typeof v === "number" ? "number" : "text"}
              value={String(v)}
              onChange={(event) => set(k, typeof v === "number" ? Number(event.target.value) || 0 : event.target.value)}
              style={inputStyle}
            />
          )}
          <button
            type="button"
            aria-label={`Remove property ${k}`}
            onClick={() => set(k, null)}
            style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }}
          >
            ×
          </button>
        </div>
      ))}
      {props.length < SCENE_PROP_MAX && (
        <form
          style={{ display: "flex", gap: 4 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canAdd) return;
            set(newKey, 0);
            setKey("");
          }}
        >
          <input aria-label="New property name" placeholder="hp" value={key} onChange={(event) => setKey(event.target.value)} style={inputStyle} />
          <button type="submit" className={styles.toolBtn} disabled={!canAdd} style={{ width: "auto" }}>
            Add
          </button>
        </form>
      )}
      <RailHint>
        In code: cartbox.prop(&quot;{entry.name}&quot;, &quot;{props[0]?.[0] ?? "hp"}&quot;, default).
      </RailHint>
    </RailGroup>
  );
}

/** How the cart's code reaches this object. */
export function CodeHint({ entry }: { entry: MeshSidecarEntry }) {
  return (
    <RailGroup label="In code">
      <code className="data" style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {`local o = cartbox.find(${JSON.stringify(entry.name)})\ncartbox.meshpose(o, x, y, z, yaw)`}
      </code>
      <RailHint>Names are how code finds objects; keep them unique.</RailHint>
    </RailGroup>
  );
}
