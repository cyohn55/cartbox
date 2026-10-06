"use client";

/**
 * Scene objects in the Mesh tab (ENGINE_ROADMAP.md, Phase 1): the Hierarchy — the
 * cart's placed meshes as a tree, children under their parents — and the
 * Inspector sections for the selected object's parent, tags and custom
 * properties. The cart's code reaches the same data through cartbox.find,
 * cartbox.tagged and cartbox.prop.
 */

import { useEffect, useState } from "react";

import {
  DEFAULT_PHYSICS_SPEC,
  DEFAULT_SPRING_DAMPING,
  DEFAULT_SPRING_STIFFNESS,
  JOINT_KINDS,
  PHYSICS_BODY_KINDS,
  PHYSICS_SHAPE_KINDS,
  SCENE_PROP_MAX,
  SCENE_TAG_MAX,
  isSceneKey,
  type JointAxis,
  type MeshAsset,
  type JointKind,
  type JointSpec,
  type PhysicsBodyKind,
  type PhysicsShapeKind,
  type PhysicsSpec,
  type ScenePropValue,
} from "@cartbox/editor";

import {
  hierarchyRows,
  parentCandidates,
  setMeshParent,
  setMeshPhysics,
  setMeshPhysicsWorld,
  setMeshProp,
  setMeshTags,
  type MeshSidecar,
  type MeshSidecarEntry,
} from "@/lib/meshSidecar";
import {
  applyToPrefab,
  createPrefab,
  deletePrefab,
  findPrefab,
  overrideCount,
  placePrefab,
  prefabInstances,
  revertToPrefab,
  setPrefabPool,
  unlinkPrefab,
} from "@/lib/meshPrefabs";
import { addMeshClip, renameMeshClip, retargetClip, retimeClip, reverseClip, setMeshClip, trimClip } from "@cartbox/editor";
import { clearEntryLods, generateEntryLods, lodSummary } from "@/lib/meshLods";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl } from "./railControls";

const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 };

/** The placed meshes as a tree; click a row to select it. */
/** A scene command (EP3), from a shortcut or a hierarchy button. */
export type SceneCommand = "duplicate" | "copy" | "paste" | "delete" | "hide" | "unhideAll" | "isolate" | "lock" | "selectAll" | "deselect";

/**
 * The scene's objects as a tree. Click to select, Ctrl/Cmd-click to toggle one
 * in or out, Shift-click to add; each row has an eye (hide it and what's under
 * it in the scene view) and a lock (can't be picked or moved there). The
 * buttons and the scene shortcuts work on the whole selection.
 */
export function HierarchyPanel({
  sidecar,
  selectedIds,
  onSelect,
  hidden,
  locked,
  onToggleHidden,
  onToggleLocked,
  onCommand,
  onKey,
}: {
  sidecar: MeshSidecar;
  selectedIds: readonly string[];
  onSelect: (id: string, mods: { toggle: boolean; add: boolean }) => void;
  hidden?: ReadonlySet<string>;
  locked?: ReadonlySet<string>;
  onToggleHidden?: (id: string) => void;
  onToggleLocked?: (id: string) => void;
  onCommand?: (command: SceneCommand) => void;
  onKey?: (event: React.KeyboardEvent) => boolean;
}) {
  const rows = hierarchyRows(sidecar);
  const primary = selectedIds.at(-1) ?? null;
  const selected = new Set(selectedIds);
  return (
    <RailGroup label={`Hierarchy · ${sidecar.meshes.length}${selectedIds.length > 1 ? ` · ${selectedIds.length} selected` : ""}`}>
      {rows.length === 0 ? (
        <RailHint>No meshes yet. Import one above.</RailHint>
      ) : (
        <div
          role="tree"
          aria-label="Scene hierarchy"
          aria-multiselectable
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
          onKeyDown={(event) => {
            onKey?.(event);
          }}
        >
          {rows.map(({ entry, depth, hasChildren }) => {
            const isHidden = hidden?.has(entry.id) ?? false;
            const isLocked = locked?.has(entry.id) ?? false;
            return (
              <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <button
                  type="button"
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={selected.has(entry.id)}
                  className={styles.toolBtn}
                  onClick={(event) => onSelect(entry.id, { toggle: event.ctrlKey || event.metaKey, add: event.shiftKey })}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    justifyContent: "flex-start",
                    paddingLeft: 8 + depth * 14,
                    outline: entry.id === primary ? "2px solid #7db8fc" : selected.has(entry.id) ? "1px solid #7db8fc" : "none",
                    background: selected.has(entry.id) ? "rgba(125, 184, 252, 0.12)" : undefined,
                    opacity: isHidden ? 0.5 : 1,
                  }}
                  title={entry.tags?.length ? `${entry.name} · ${entry.tags.join(", ")}` : entry.name}
                >
                  <span aria-hidden style={{ opacity: 0.55, width: 12, flex: "none" }}>
                    {hasChildren ? "▾" : depth > 0 ? "·" : ""}
                  </span>
                  {entry.prefab && (
                    <span aria-hidden title="Part of a prefab copy" style={{ color: "#7db8fc", marginRight: 4, flex: "none" }}>
                      ◆
                    </span>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto", minWidth: 0, textAlign: "left" }}>{entry.name}</span>
                  {entry.tags && entry.tags.length > 0 && (
                    <span aria-hidden style={{ marginLeft: "auto", opacity: 0.55, fontSize: 11 }}>
                      #{entry.tags.length}
                    </span>
                  )}
                </button>
                {onToggleHidden && (
                  <button
                    type="button"
                    className={styles.toolBtn}
                    aria-pressed={isHidden}
                    aria-label={`${isHidden ? "Show" : "Hide"} ${entry.name} in the scene view`}
                    title={isHidden ? "Hidden in the scene view (H)" : "Hide in the scene view (H)"}
                    onClick={() => onToggleHidden(entry.id)}
                    style={{ flex: "none", width: 22, padding: 0, justifyContent: "center", opacity: isHidden ? 1 : 0.45 }}
                  >
                    {isHidden ? "◌" : "◉"}
                  </button>
                )}
                {onToggleLocked && (
                  <button
                    type="button"
                    className={styles.toolBtn}
                    aria-pressed={isLocked}
                    aria-label={`${isLocked ? "Unlock" : "Lock"} ${entry.name}`}
                    title={isLocked ? "Locked: can't be picked or moved in the scene view (L)" : "Lock (L)"}
                    onClick={() => onToggleLocked(entry.id)}
                    style={{ flex: "none", width: 22, padding: 0, justifyContent: "center", opacity: isLocked ? 1 : 0.35, fontSize: 11 }}
                  >
                    {isLocked ? "🔒" : "🔓"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {onCommand && rows.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          <button type="button" className={styles.toolBtn} disabled={selectedIds.length === 0} onClick={() => onCommand("duplicate")} title="Duplicate the selection (Ctrl+D)">
            Duplicate
          </button>
          <button type="button" className={styles.toolBtn} disabled={selectedIds.length === 0} onClick={() => onCommand("copy")} title="Copy the selection, also to paste into another cart (Ctrl+C)">
            Copy
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => onCommand("paste")} title="Paste copied objects (Ctrl+V)">
            Paste
          </button>
          <button type="button" className={styles.toolBtn} disabled={selectedIds.length === 0} onClick={() => onCommand("delete")} title="Delete the selection and what's under it (Delete)">
            Delete
          </button>
          <button type="button" className={styles.toolBtn} disabled={selectedIds.length === 0 && !hidden?.size} onClick={() => onCommand("isolate")} title="Show only the selection, or everything again (Shift+H)">
            Isolate
          </button>
          {hidden && hidden.size > 0 && (
            <button type="button" className={styles.toolBtn} onClick={() => onCommand("unhideAll")} title="Show everything (Alt+H)">
              Show all
            </button>
          )}
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
          : "Pick a parent to group this object under another one. It stays where it is."}
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

/**
 * The selected object's prefab: save it (and everything under it) as a prefab,
 * or — for part of a placed copy — apply its edits to every copy, revert, unlink.
 */
export function PrefabPanel({
  sidecar,
  entry,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  onChange: (next: MeshSidecar) => void;
}) {
  const [name, setName] = useState("");
  const link = entry.prefab;
  const prefab = link ? findPrefab(sidecar, link.id) : undefined;
  if (!link || !prefab) {
    return (
      <RailGroup label="Prefab">
        <form
          style={{ display: "flex", gap: 4 }}
          onSubmit={(event) => {
            event.preventDefault();
            onChange(createPrefab(sidecar, entry.id, name || entry.name).sidecar);
            setName("");
          }}
        >
          <input aria-label="Prefab name" placeholder={entry.name} value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} />
          <button type="submit" className={styles.toolBtn} style={{ width: "auto", whiteSpace: "nowrap" }}>
            Save as prefab
          </button>
        </form>
        <RailHint>Saves this object and everything under it as a reusable group you can place again.</RailHint>
      </RailGroup>
    );
  }
  const instanceId = link.instance;
  const rootName = sidecar.meshes.find((m) => m.id === instanceId)?.name ?? prefab.name;
  const overrides = overrideCount(sidecar, instanceId);
  const copies = prefabInstances(sidecar, prefab.id).length;
  return (
    <RailGroup label="Prefab">
      <RailHint>
        {instanceId === entry.id ? "A copy of " : `Part of ${rootName}, a copy of `}
        <strong>{prefab.name}</strong> ({copies} {copies === 1 ? "copy" : "copies"}).{" "}
        {overrides === 0 ? "Matches the prefab." : `${overrides} ${overrides === 1 ? "change" : "changes"} from the prefab.`}
      </RailHint>
      <div className={styles.toolGroup}>
        <button
          type="button"
          className={styles.toolBtn}
          disabled={overrides === 0}
          onClick={() => onChange(applyToPrefab(sidecar, instanceId))}
          title="Make this copy the prefab, and update every other copy (their own changes stay)"
        >
          Apply to all copies
        </button>
        <button type="button" className={styles.toolBtn} disabled={overrides === 0} onClick={() => onChange(revertToPrefab(sidecar, instanceId))}>
          Revert changes
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => onChange(unlinkPrefab(sidecar, instanceId))} title="Keep the objects, stop following the prefab">
          Unlink
        </button>
      </div>
    </RailGroup>
  );
}

/** Every prefab on the cart, with Place (a new copy at the origin) and Delete. */
export function PrefabLibrary({
  sidecar,
  onChange,
  onPlaced,
}: {
  sidecar: MeshSidecar;
  onChange: (next: MeshSidecar) => void;
  onPlaced: (rootId: string) => void;
}) {
  const prefabs = sidecar.prefabs ?? [];
  return (
    <RailGroup label={`Prefabs · ${prefabs.length}`}>
      {prefabs.length === 0 ? (
        <RailHint>Select an object and choose Save as prefab to reuse it.</RailHint>
      ) : (
        <>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {prefabs.map((prefab) => (
            <div key={prefab.id} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={prefab.name}>
                <span aria-hidden style={{ color: "#7db8fc" }}>◆ </span>
                {prefab.name}
              </span>
              <button
                type="button"
                className={styles.toolBtn}
                style={{ width: "auto" }}
                aria-label={`Place ${prefab.name}`}
                onClick={() => {
                  const placed = placePrefab(sidecar, prefab.id);
                  onChange(placed.sidecar);
                  onPlaced(placed.rootId);
                }}
              >
                Place
              </button>
              <input
                type="number"
                min={0}
                max={32}
                aria-label={`Copies of ${prefab.name} code can spawn`}
                title="Copies code can spawn at run time (cartbox.spawn)"
                value={prefab.pool ?? 8}
                onChange={(event) => onChange(setPrefabPool(sidecar, prefab.id, Number(event.target.value)))}
                style={{ ...inputStyle, width: 48 }}
              />
              <button
                type="button"
                aria-label={`Delete prefab ${prefab.name}`}
                title="Delete the prefab (its copies stay as plain objects)"
                onClick={() => onChange(deletePrefab(sidecar, prefab.id))}
                style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <RailHint>
          The number is how many copies code can spawn while the game runs: cartbox.spawn(&quot;{prefabs[0]!.name}&quot;, x, y, z).
        </RailHint>
        </>
      )}
    </RailGroup>
  );
}

const BODY_LABELS: Record<PhysicsBodyKind, string> = {
  static: "Static — never moves (floors, walls)",
  dynamic: "Dynamic — falls and bounces",
  kinematic: "Kinematic — moved by code, pushes others",
  character: "Character — walks with cartbox.move",
};
const SHAPE_LABELS: Record<PhysicsShapeKind, string> = {
  box: "Box",
  sphere: "Sphere",
  capsule: "Capsule",
  mesh: "Mesh triangles (static only)",
};

/** The selected object's physics body (none, or body type + collider + material). */
/** A skinned mesh's skeleton and clips, with a preview player (the preview canvas shows the clip). */
export function AnimationPanel({
  mesh,
  name,
  playing,
  onPlay,
  ragdoll = false,
  onRagdoll,
  onEdit,
  sources,
  loadSource,
}: {
  mesh: MeshAsset;
  name: string;
  playing: number | null;
  onPlay: (clip: number | null) => void;
  /** Whether the preview shows the skeleton dropped as a ragdoll (H9). */
  ragdoll?: boolean;
  onRagdoll?: (on: boolean) => void;
  /** Edit the clips (EP17): the mesh with its clips changed. */
  onEdit?: (mesh: MeshAsset) => void;
  /** Other objects whose clips can be copied onto this one (EP17b), decoded on demand. */
  sources?: readonly { readonly id: string; readonly name: string }[];
  loadSource?: (id: string) => MeshAsset | null;
}) {
  const clips = mesh.clips ?? [];
  return (
    <RailGroup label="Animation">
      <div style={{ fontSize: 12 }}>
        Skeleton · {mesh.skin?.joints.length ?? 0} joints · {clips.length} clip{clips.length === 1 ? "" : "s"}
      </div>
      <div style={{ display: "grid", gap: 4, marginTop: 6 }} aria-label="Animation clips">
        {clips.map((clip, i) => (
          <button
            key={`${clip.name}-${i}`}
            type="button"
            className={styles.toolBtn}
            aria-pressed={playing === i}
            onClick={() => onPlay(playing === i ? null : i)}
          >
            {playing === i ? "■" : "▶"} {clip.name} <span style={{ opacity: 0.7 }}>{clip.duration.toFixed(2)}s</span>
          </button>
        ))}
      </div>
      {onEdit && clips.length > 0 && <ClipEditor mesh={mesh} clip={playing ?? 0} onEdit={onEdit} />}
      {onEdit && loadSource && sources && sources.length > 0 && <RetargetPicker mesh={mesh} sources={sources} loadSource={loadSource} onEdit={onEdit} />}
      {onRagdoll && (
        <button type="button" className={styles.toolBtn} style={{ marginTop: 6 }} aria-pressed={ragdoll} onClick={() => onRagdoll(!ragdoll)}>
          {ragdoll ? "↑ Stand up" : "↓ Drop as ragdoll"}
        </button>
      )}
      <details style={{ marginTop: 6, fontSize: 12 }}>
        <summary>Joints (for cartbox.ik / lookat / joint / ragdoll)</summary>
        <div style={{ opacity: 0.8, marginTop: 4, lineHeight: 1.5, wordBreak: "break-word" }}>
          {(mesh.skin?.joints ?? []).map((j) => j.name).join(" · ")}
        </div>
      </details>
      <RailHint>
        {clips.length > 0
          ? `In the game it plays “${clips[0]!.name}” on a loop by itself. In code: cartbox.play(${JSON.stringify(name)}, ${JSON.stringify(clips[clips.length > 1 ? 1 : 0]!.name)}) switches clip with a short crossfade.`
          : "No clips came with this model; import a glTF with animations to play them."}{" "}
        {`When it dies: cartbox.ragdoll(${JSON.stringify(name)}, ix, iy, iz) makes it go limp and tumble, shoved by (ix, iy, iz); cartbox.unragdoll(${JSON.stringify(name)}) stands it back up. The body is simulated on each player's machine, so it never affects online play.`}
      </RailHint>
    </RailGroup>
  );
}

/**
 * Copying another object's clips onto this skeleton (EP17b): joints matched by
 * name, motion carried relative to each skeleton's rest pose, the root's
 * travel scaled by their heights. Reports how many came across.
 */
function RetargetPicker({
  mesh,
  sources,
  loadSource,
  onEdit,
}: {
  mesh: MeshAsset;
  sources: readonly { id: string; name: string }[];
  loadSource: (id: string) => MeshAsset | null;
  onEdit: (mesh: MeshAsset) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <div style={{ marginTop: 6, fontSize: 12, display: "grid", gap: 4 }}>
      <select
        aria-label="Copy clips from"
        value=""
        onChange={(e) => {
          const src = e.target.value ? loadSource(e.target.value) : null;
          if (!src?.skin || !(src.clips ?? []).length || !mesh.skin) {
            setNote(e.target.value ? "That object has no skeleton with clips." : null);
            return;
          }
          let next = mesh;
          let copied = 0;
          for (const clip of src.clips ?? []) {
            const made = retargetClip(clip, src.skin, mesh.skin);
            if (!made) continue;
            next = addMeshClip(next, made);
            copied += 1;
          }
          setNote(copied > 0 ? `Copied ${copied} clip${copied === 1 ? "" : "s"} (joints matched by name).` : "No joints share a name with this skeleton.");
          if (copied > 0) onEdit(next);
        }}
        style={{ fontSize: 12 }}
      >
        <option value="">Copy clips from another object…</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {note && <span style={{ opacity: 0.8 }}>{note}</span>}
    </div>
  );
}

/**
 * Editing a clip (EP17): the playing clip (or the first) — rename it, trim a
 * span of it into a new clip, change its speed, make a reversed copy,
 * duplicate or delete it.
 */
function ClipEditor({ mesh, clip: index, onEdit }: { mesh: MeshAsset; clip: number; onEdit: (mesh: MeshAsset) => void }) {
  const clip = mesh.clips?.[index];
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(clip?.duration ?? 1);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    setFrom(0);
    setTo(clip?.duration ?? 1);
    setSpeed(1);
  }, [clip]);
  if (!clip) return null;
  const num = (label: string, value: number, set: (v: number) => void, step = 0.05) => (
    <input type="number" aria-label={label} step={step} value={Math.round(value * 1000) / 1000} onChange={(e) => Number.isFinite(Number(e.target.value)) && set(Number(e.target.value))} style={{ width: 58, fontSize: 12 }} />
  );
  return (
    <details style={{ marginTop: 6, fontSize: 12 }}>
      <summary>Edit “{clip.name}”</summary>
      <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Name
          <input aria-label="Clip name" defaultValue={clip.name} key={clip.name} onBlur={(e) => onEdit(renameMeshClip(mesh, index, e.target.value))} style={{ flex: 1, minWidth: 0 }} />
        </label>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          From {num("Trim from", from, setFrom)} to {num("Trim to", to, setTo)} s
          <button type="button" className={styles.toolBtn} onClick={() => onEdit(addMeshClip(mesh, trimClip(clip, from, to, `${clip.name} cut`)))}>
            Trim into a new clip
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          Speed ×{num("Clip speed", speed, setSpeed, 0.1)}
          <button type="button" className={styles.toolBtn} disabled={speed === 1} onClick={() => onEdit(setMeshClip(mesh, index, retimeClip(clip, speed)))}>
            Apply speed
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className={styles.toolBtn} onClick={() => onEdit(addMeshClip(mesh, reverseClip(clip, `${clip.name} reversed`)))}>
            Reversed copy
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => onEdit(addMeshClip(mesh, { ...clip, name: `${clip.name} copy` }))}>
            Duplicate
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => onEdit(setMeshClip(mesh, index, null))}>
            Delete
          </button>
        </div>
      </div>
    </details>
  );
}

const JOINT_LABELS: Record<JointKind, string> = {
  hinge: "Hinge — turns about one axis",
  ball: "Ball — swivels freely",
  fixed: "Weld — stays put until broken",
  spring: "Spring — pulled toward the point",
  rope: "Rope — kept within reach",
};

/** What a joint on `entry` ties it to: its nearest ancestor with a body, or the world. */
function jointTarget(sidecar: MeshSidecar, entry: MeshSidecarEntry): string {
  const byId = new Map(sidecar.meshes.map((m) => [m.id, m]));
  const seen = new Set<string>();
  for (let p = entry.parent ? byId.get(entry.parent) : undefined; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
    seen.add(p.id);
    if (p.physics) return `“${p.name}”`;
  }
  return "the world";
}

/** A dynamic body's joint: kind, attach point and the settings for its kind. */
function JointEditor({
  sidecar,
  entry,
  joint,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  joint: JointSpec | null;
  onChange: (joint: JointSpec | null) => void;
}) {
  const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center", fontSize: 12 };
  const patch = (next: Partial<JointSpec>) => joint && onChange({ ...joint, ...next });
  const field = (label: string, value: number | undefined, placeholder: string, apply: (v: number | undefined) => void, step = 0.1) => (
    <label style={row}>
      {label}
      <input
        type="number"
        step={step}
        aria-label={`Joint ${label.toLowerCase()}`}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(event) => apply(event.target.value === "" ? undefined : Number(event.target.value))}
        style={inputStyle}
      />
    </label>
  );
  const name = JSON.stringify(entry.name);
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
      <select
        aria-label="Joint"
        value={joint?.kind ?? ""}
        onChange={(event) =>
          onChange(event.target.value ? { kind: event.target.value as JointKind, anchor: joint?.anchor ?? [0, 0, 0] } : null)
        }
        style={inputStyle}
      >
        <option value="">No joint</option>
        {JOINT_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {JOINT_LABELS[kind]}
          </option>
        ))}
      </select>
      {joint && (
        <>
          <div style={{ fontSize: 12 }}>Tied to {jointTarget(sidecar, entry)}</div>
          <label style={row}>
            {joint.kind === "spring" || joint.kind === "rope" ? "Tied at" : "Pivot"}
            <span style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
              {(["x", "y", "z"] as const).map((axis, i) => (
                <input
                  key={axis}
                  type="number"
                  step={0.1}
                  aria-label={`Joint point ${axis}`}
                  value={joint.anchor[i]}
                  onChange={(event) => {
                    const anchor = [...joint.anchor] as [number, number, number];
                    anchor[i] = Number(event.target.value) || 0;
                    patch({ anchor });
                  }}
                  style={inputStyle}
                />
              ))}
            </span>
          </label>
          {joint.kind === "hinge" && (
            <>
              <label style={row}>
                Axis
                <select aria-label="Hinge axis" value={joint.axis ?? "y"} onChange={(event) => patch({ axis: event.target.value as JointAxis })} style={inputStyle}>
                  <option value="x">Its X axis</option>
                  <option value="y">Its Y axis (a door)</option>
                  <option value="z">Its Z axis</option>
                </select>
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  aria-label="Hinge limits"
                  checked={Boolean(joint.limits)}
                  onChange={(event) => {
                    if (event.target.checked) patch({ limits: [-90, 90] });
                    else {
                      const { limits: _drop, ...rest } = joint;
                      onChange(rest);
                    }
                  }}
                />
                Limit how far it turns
              </label>
              {joint.limits && (
                <>
                  {field("Min °", joint.limits[0], "-90", (v) => patch({ limits: [v ?? 0, joint.limits![1]] }), 5)}
                  {field("Max °", joint.limits[1], "90", (v) => patch({ limits: [joint.limits![0], v ?? 0] }), 5)}
                </>
              )}
            </>
          )}
          {(joint.kind === "spring" || joint.kind === "rope") &&
            field("Length", joint.length, "as placed", (v) => {
              const { length: _drop, ...rest } = joint;
              onChange(v === undefined ? rest : { ...rest, length: v });
            })}
          {joint.kind === "spring" && (
            <>
              {field("Stiffness", joint.stiffness, String(DEFAULT_SPRING_STIFFNESS), (v) => patch({ stiffness: v ?? DEFAULT_SPRING_STIFFNESS }), 5)}
              {field("Spring damping", joint.damping, String(DEFAULT_SPRING_DAMPING), (v) => patch({ damping: v ?? DEFAULT_SPRING_DAMPING }))}
            </>
          )}
          <RailHint>
            {joint.kind === "spring" || joint.kind === "rope"
              ? "The point is in the object's own coordinates; its centre hangs from it. "
              : "The pivot is in the object's own coordinates (0,0,0 = its centre). "}
            {joint.kind === "hinge" ? `In code: cartbox.motor(${name}, speed) turns it; ` : "In code: "}
            {`cartbox.unjoin(${name}) breaks it. Parent the object to another body to tie it to that instead.`}
          </RailHint>
        </>
      )}
    </div>
  );
}

/**
 * Scene-wide physics settings, shown once any object (or prefab node) has a body:
 * for now, deterministic physics for replays and shared online simulations.
 */
export function PhysicsWorldPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const hasBodies =
    sidecar.meshes.some((m) => m.physics) || (sidecar.prefabs ?? []).some((p) => p.nodes.some((n) => n.physics));
  if (!hasBodies && !sidecar.physicsWorld) return null;
  const deterministic = sidecar.physicsWorld?.deterministic === true;
  return (
    <RailGroup label="Physics world">
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <input
          type="checkbox"
          aria-label="Deterministic physics"
          checked={deterministic}
          onChange={(event) => onChange(setMeshPhysicsWorld(sidecar, event.target.checked ? { deterministic: true } : null))}
        />
        Deterministic — the same result in every browser
      </label>
      <RailHint>
        {deterministic
          ? "Same scene + same inputs = the same simulation everywhere, for replays and for online games that each simulate shared objects. A little slower. cartbox.physicshash() lets players compare states."
          : "Turn on for replays or online games where every player simulates the same objects."}
      </RailHint>
    </RailGroup>
  );
}

/**
 * Level of detail (EP9b): generate lighter versions of the object's model,
 * swapped in by camera distance in the game and the scene view, or clear them.
 */
export function LodPanel({
  sidecar,
  entry,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  onChange: (next: MeshSidecar) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const summary = lodSummary(entry);
  const copies = sidecar.meshes.filter((m) => m.mesh === entry.mesh).length;
  const generate = () => {
    const { sidecar: next, made } = generateEntryLods(sidecar, entry.id);
    if (made) onChange(next);
    setNote(made ? null : "This model is already as light as it gets — no level would save enough to matter.");
  };
  return (
    <RailGroup label="Level of detail">
      {summary && !summary.stale ? (
        <RailHint>
          {summary.triangles.map((t, i) => (
            <span key={i} style={{ display: "block" }}>
              {i === 0 ? "Full" : `LOD ${i}`}: {t.toLocaleString()} triangles{i === 0 ? "" : ` from ${summary.distances[i - 1]!.toFixed(1)} m`}
            </span>
          ))}
        </RailHint>
      ) : summary?.stale ? (
        <RailHint>The model changed since its LODs were made, so they're skipped. Generate them again.</RailHint>
      ) : (
        <RailHint>Lighter versions of the model, drawn when it's far from the camera.</RailHint>
      )}
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolBtn} onClick={generate} title={copies > 1 ? `Also gives the other ${copies - 1} copies of this model the same levels` : undefined}>
          {summary ? "Regenerate LODs" : "Generate LODs"}
        </button>
        {summary && (
          <button type="button" className={styles.toolBtn} onClick={() => onChange(clearEntryLods(sidecar, entry.id))}>
            Clear
          </button>
        )}
      </div>
      {note && <RailHint>{note}</RailHint>}
    </RailGroup>
  );
}

export function PhysicsPanel({
  sidecar,
  entry,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  onChange: (next: MeshSidecar) => void;
}) {
  const spec = entry.physics ?? null;
  const set = (patch: Partial<PhysicsSpec> | null) =>
    onChange(setMeshPhysics(sidecar, entry.id, patch === null ? null : { ...(spec ?? DEFAULT_PHYSICS_SPEC), ...patch }));
  const number = (label: string, key: "mass" | "friction" | "bounce" | "gravity" | "damping", step: number, min: number, max: number, fallback?: number) => (
    <label style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center", fontSize: 12 }}>
      {label}
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        aria-label={`Physics ${key}`}
        value={spec?.[key] ?? fallback ?? (key === "gravity" ? 1 : key === "damping" ? 0 : DEFAULT_PHYSICS_SPEC[key])}
        onChange={(event) => set({ [key]: Number(event.target.value) } as Partial<PhysicsSpec>)}
        style={inputStyle}
      />
    </label>
  );
  return (
    <RailGroup label="Physics">
      <select
        aria-label="Physics body"
        value={spec?.body ?? ""}
        onChange={(event) => set(event.target.value ? { body: event.target.value as PhysicsBodyKind } : null)}
        style={inputStyle}
      >
        <option value="">None</option>
        {PHYSICS_BODY_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {BODY_LABELS[kind]}
          </option>
        ))}
      </select>
      {spec && (
        <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
          {spec.body !== "character" && (
            <select aria-label="Physics shape" value={spec.shape} onChange={(event) => set({ shape: event.target.value as PhysicsShapeKind })} style={inputStyle}>
              {PHYSICS_SHAPE_KINDS.filter((s) => s !== "mesh" || spec.body === "static").map((shape) => (
                <option key={shape} value={shape}>
                  {SHAPE_LABELS[shape]}
                </option>
              ))}
            </select>
          )}
          {spec.body !== "character" && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input
                type="checkbox"
                aria-label="Trigger zone"
                checked={spec.trigger === true}
                onChange={(event) => set({ trigger: event.target.checked })}
              />
              Trigger zone — detects what enters, blocks nothing
            </label>
          )}
          {spec.body === "dynamic" && number("Mass kg", "mass", 0.1, 0.01, 10000)}
          {spec.body === "dynamic" && number("Gravity ×", "gravity", 0.1, -10, 10)}
          {spec.body === "dynamic" && number("Damping", "damping", 0.1, 0, 10)}
          {!spec.trigger && number("Friction", "friction", 0.1, 0, 2)}
          {!spec.trigger && number("Bounce", "bounce", 0.05, 0, 1)}
          {spec.body === "dynamic" && (
            <JointEditor
              sidecar={sidecar}
              entry={entry}
              joint={spec.joint ?? null}
              onChange={(joint) => {
                // Replace the spec outright: merging (as set does) can't remove the joint.
                const { joint: _drop, ...rest } = spec;
                onChange(setMeshPhysics(sidecar, entry.id, joint ? { ...rest, joint } : rest));
              }}
            />
          )}
        </div>
      )}
      <RailHint>
        {spec
          ? spec.trigger
            ? `In code: cartbox.entered(${JSON.stringify(entry.name)}), cartbox.exited(…), cartbox.inside(…).`
            : spec.body === "character"
            ? `An upright capsule fitted to the mesh. In code: cartbox.move(${JSON.stringify(entry.name)}, dx, dy, dz).`
            : `The collider is fitted to the mesh. In code: cartbox.body(${JSON.stringify(entry.name)}).`
          : "Give the object a body to have it collide, fall or be pushed when the cart runs."}
      </RailHint>
    </RailGroup>
  );
}

/** A shield state previewed on the selected object (H11): a hit's flare, the recharge shimmer, Active Camo. */
export interface ShieldPreview {
  readonly flare: number;
  readonly shimmer: number;
  readonly camo: number;
}

export const NO_SHIELD: ShieldPreview = { flare: 0, shimmer: 0, camo: 0 };

/**
 * Shield effects (HALO2_STYLE_ROADMAP.md H11): preview cartbox.shield on the
 * selected object — the same surface effect the game draws, over its PBR
 * materials. Nothing here is saved; the cart sets shields as it plays.
 */
export function ShieldPanel({ name, shield, onChange }: { name: string; shield: ShieldPreview; onChange: (shield: ShieldPreview) => void }) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <RailGroup label="Shield effects" collapsible>
      <RangeControl nested label="Flare (a hit)" min={0} max={1} step={0.05} value={shield.flare} display={pct(shield.flare)} ariaLabel="Shield flare" onChange={(flare) => onChange({ ...shield, flare })} />
      <RangeControl nested label="Shimmer (recharging)" min={0} max={1} step={0.05} value={shield.shimmer} display={pct(shield.shimmer)} ariaLabel="Shield shimmer" onChange={(shimmer) => onChange({ ...shield, shimmer })} />
      <RangeControl nested label="Active Camo" min={0} max={1} step={0.05} value={shield.camo} display={pct(shield.camo)} ariaLabel="Active Camo" onChange={(camo) => onChange({ ...shield, camo })} />
      <RailHint>
        Preview only. In code: cartbox.shield(&quot;{name}&quot;, flare, shimmer, camo) — it stands until changed, covers everything under the object, and
        shows on PBR materials.
      </RailHint>
    </RailGroup>
  );
}
