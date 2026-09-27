"use client";

/**
 * Levels in the Mesh tab (ENGINE_ROADMAP.md, Phase 4 — streaming): name the
 * scene's levels and pick which one a cart starts in, and put each object in a
 * level (or leave it always loaded). See levels.ts in @cartbox/editor.
 */

import { useState } from "react";

import { MAX_LEVELS } from "@cartbox/editor";

import { addLevel, removeLevel, renameLevel, setMeshLevel, setStartLevel, type MeshSidecar, type MeshSidecarEntry } from "@/lib/meshSidecar";
import { RailGroup, RailHint } from "./railControls";

const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 };

/** The scene's levels: add, rename, remove, and choose the start level. */
export function LevelsPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const levels = sidecar.levels ?? [];
  const [draft, setDraft] = useState("");
  const count = (id: string) => sidecar.meshes.filter((m) => m.level === id).length;
  return (
    <RailGroup label={`Levels · ${levels.length}`}>
      {levels.map((level, i) => (
        <div key={level.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 4, alignItems: "center" }}>
          <input
            aria-label={`Level ${i + 1} name`}
            defaultValue={level.name}
            onBlur={(event) => onChange(renameLevel(sidecar, level.id, event.target.value))}
            style={inputStyle}
          />
          {i === 0 ? (
            <span style={{ fontSize: 11, opacity: 0.7 }} title="The cart starts in this level">
              start · {count(level.id)}
            </span>
          ) : (
            <button type="button" className="cbx-btn" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => onChange(setStartLevel(sidecar, level.id))}>
              Start here
            </button>
          )}
          <button
            type="button"
            className="cbx-btn"
            aria-label={`Remove level ${level.name}`}
            style={{ fontSize: 11, padding: "2px 6px" }}
            onClick={() => onChange(removeLevel(sidecar, level.id))}
          >
            ✕
          </button>
        </div>
      ))}
      {levels.length < MAX_LEVELS && (
        <div style={{ display: "flex", gap: 4 }}>
          <input aria-label="New level name" placeholder={`Level ${levels.length + 1}`} value={draft} onChange={(e) => setDraft(e.target.value)} style={inputStyle} />
          <button
            type="button"
            className="cbx-btn"
            onClick={() => {
              onChange(addLevel(sidecar, draft).sidecar);
              setDraft("");
            }}
          >
            Add level
          </button>
        </div>
      )}
      <RailHint>
        {levels.length === 0
          ? "Split a big game into levels: only the current level's objects are loaded, and a published cart fetches the next level's textures when code calls cartbox.level(\"name\")."
          : "Objects in no level are always loaded (player, HUD). In code: cartbox.level(\"name\") switches; cartbox.level() returns the current level, the one loading and its progress."}
      </RailHint>
    </RailGroup>
  );
}

/** Which level the selected object belongs to (shown once the scene has levels). */
export function LevelPicker({ sidecar, entry, onChange }: { sidecar: MeshSidecar; entry: MeshSidecarEntry; onChange: (next: MeshSidecar) => void }) {
  const levels = sidecar.levels ?? [];
  if (levels.length === 0) return null;
  return (
    <RailGroup label="Level">
      <select
        aria-label="Object level"
        value={entry.level ?? ""}
        onChange={(event) => onChange(setMeshLevel(sidecar, entry.id, event.target.value || null))}
        style={inputStyle}
      >
        <option value="">Always loaded</option>
        {levels.map((level) => (
          <option key={level.id} value={level.id}>
            {level.name}
          </option>
        ))}
      </select>
      <RailHint>{entry.level ? "Loaded only while this level is current (children come with it)." : "Present in every level."}</RailHint>
    </RailGroup>
  );
}
