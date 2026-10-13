"use client";

/**
 * The level editor (EDITOR_PRO_ROADMAP.md P7): a scene's arena map, authored
 * where it stands. Pick what to place — a spawn, a weapon pad, a hill, the
 * ball, a teleporter, a kill volume, a bot destination, a collider — and
 * click the scene; click a marker to select it, and click again to move it.
 * Colliders fit round selected objects, the ground comes from a terrain, the
 * map is checked as it changes, and it plays in the arena cart with bots.
 * See arenaMarkup.ts in @cartbox/editor and arenaEdit.ts.
 */

import { useMemo, useState } from "react";

import { ARENA_WEAPONS, MARKUP_LABELS, emptyArenaMap, removeMarkup, resizeMarkup, setPower, type ArenaMap, type ArenaWeapon, type MarkupKind, type MarkupRef } from "@cartbox/editor";

import { arenaIssues, collidersFromObjects, groundFromSidecarTerrain, setSidecarArena, sidecarArena } from "@/lib/arenaEdit";
import { type MeshSidecar } from "@/lib/meshSidecar";
import { basePath } from "@/lib/staticSite";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl } from "./railControls";

const KINDS: readonly MarkupKind[] = ["spawn", "pad", "hill", "ball", "teleporter", "kill", "destination", "collider"];

/** What the panel shares with the viewport: what a click places (or moves), and which marker is selected. */
export interface ArenaEditState {
  readonly placing: MarkupKind | null;
  readonly selected: MarkupRef | null;
  readonly showColliders: boolean;
}

export const INITIAL_ARENA_EDIT: ArenaEditState = { placing: null, selected: null, showColliders: false };

export function ArenaPanel({
  sidecar,
  onChange,
  edit,
  onEdit,
  selectedIds,
  cartId,
}: {
  sidecar: MeshSidecar;
  onChange: (next: MeshSidecar) => void;
  edit: ArenaEditState;
  onEdit: (next: ArenaEditState) => void;
  selectedIds: readonly string[];
  cartId?: string;
}) {
  const map = useMemo(() => sidecarArena(sidecar), [sidecar]);
  const [reach, setReach] = useState<{ map: ArenaMap; issues: ReturnType<typeof arenaIssues> } | null>(null);
  const [step, setStep] = useState(1);
  const issues = useMemo(() => (map ? arenaIssues(map) : []), [map]);
  const set = (next: ArenaMap | null) => onChange(setSidecarArena(sidecar, next));

  if (!map) {
    return (
      <RailGroup label="Arena (level editor)" advanced>
        <button type="button" className={styles.toolBtn} onClick={() => set(emptyArenaMap(cartId ?? "arena", "My arena"))}>
          <span className={styles.toolGlyph} aria-hidden>
            ⌖
          </span>
          Make this scene an arena map
        </button>
        <RailHint>Mark up spawns, weapon pads, hills, teleporters, kill volumes and bot routes on this scene, and play it in the arena with bots.</RailHint>
      </RailGroup>
    );
  }

  const sel = edit.selected;
  const terrains = (sidecar.terrains ?? []) as readonly { id?: string; name?: string }[];
  const reachIssues = reach && reach.map === map ? reach.issues.filter((i) => i.kind === "unreachable") : null;
  const counts: Record<MarkupKind, number> = {
    spawn: map.spawns.length,
    pad: map.markers.length,
    hill: map.hills.length,
    ball: 1,
    teleporter: map.teleporters?.length ?? 0,
    exit: map.teleporters?.length ?? 0,
    kill: map.kills?.length ?? 0,
    destination: map.destinations.length,
    collider: map.solids.length,
  };

  return (
    <RailGroup label="Arena (level editor)" advanced defaultOpen>
      <input
        type="text"
        value={map.name}
        aria-label="Arena name"
        onChange={(e) => set({ ...map, name: e.target.value.slice(0, 64) })}
        style={{ width: "100%", padding: "4px 6px", borderRadius: 6, marginBottom: 6 }}
      />
      <div style={{ fontSize: 11, opacity: 0.7 }}>Click the scene to place:</div>
      <div className={styles.toolGroup} style={{ marginTop: 4, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={styles.toolBtn}
            aria-pressed={edit.placing === k && !edit.selected}
            onClick={() => onEdit({ ...edit, placing: edit.placing === k && !edit.selected ? null : k, selected: null })}
            title={`Place a ${MARKUP_LABELS[k].toLowerCase()} where you click (${counts[k]} now)`}
          >
            {MARKUP_LABELS[k]} {k === "ball" ? "" : `(${counts[k]})`}
          </button>
        ))}
      </div>

      {sel && (
        <SelectedMarkup
          map={map}
          refd={sel}
          onMap={set}
          onDone={() => onEdit({ ...edit, selected: null, placing: null })}
          onMove={(kind) => onEdit({ ...edit, selected: { kind, index: sel.index }, placing: kind })}
          moving={edit.placing !== null}
        />
      )}

      <RangeControl label="Death height" nested min={-100} max={20} step={0.5} value={map.deathY} ariaLabel="Death plane height" display={`${map.deathY.toFixed(1)} m`} onChange={(deathY) => set({ ...map, deathY })} />

      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>Collision</div>
      <div className={styles.toolGroup} style={{ marginTop: 4, flexWrap: "wrap" }}>
        <button
          type="button"
          className={styles.toolBtn}
          disabled={selectedIds.length === 0}
          title="Fit a collider box round each selected object: players stand on it, shots hit it and bots walk over it"
          onClick={() => set({ ...map, solids: [...map.solids, ...collidersFromObjects(sidecar, selectedIds)] })}
        >
          Colliders from selection
        </button>
        <button type="button" className={styles.toolBtn} aria-pressed={edit.showColliders} onClick={() => onEdit({ ...edit, showColliders: !edit.showColliders })}>
          {edit.showColliders ? "Hide colliders" : "Show colliders"}
        </button>
        {map.solids.length > 0 && (
          <button type="button" className={styles.toolBtn} onClick={() => window.confirm(`Remove all ${map.solids.length} colliders?`) && set({ ...map, solids: [] })}>
            Clear colliders
          </button>
        )}
      </div>
      {terrains.length > 0 && (
        <>
          <RangeControl label="Ground detail" nested min={0.5} max={4} step={0.5} value={step} ariaLabel="Ground sample spacing" display={`${step} m`} onChange={setStep} />
          <select
            aria-label="Ground from terrain"
            value=""
            onChange={(e) => {
              const ground = groundFromSidecarTerrain(sidecar, e.target.value, step);
              if (ground) set({ ...map, ground });
            }}
            style={{ width: "100%" }}
          >
            <option value="">{map.ground ? `Ground: ${map.ground.n}² samples — retake from…` : "Walkable ground from terrain…"}</option>
            {terrains.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name ?? t.id}
              </option>
            ))}
          </select>
        </>
      )}
      {map.flights.length > 0 && <RailHint>{map.flights.length} flights of steps (drawn as ramps, collided as steps) come with this map.</RailHint>}

      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>Check</div>
      {issues.length === 0 && !reachIssues ? (
        <RailHint>No problems found yet.</RailHint>
      ) : (
        <ul style={{ margin: "4px 0", paddingLeft: 16, fontSize: 12 }}>
          {[...issues, ...(reachIssues ?? [])].slice(0, 12).map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
          {issues.length + (reachIssues?.length ?? 0) > 12 && <li>…and {issues.length + (reachIssues?.length ?? 0) - 12} more</li>}
        </ul>
      )}
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolBtn} onClick={() => setReach({ map, issues: arenaIssues(map, true) })} title="Bake the bots' navmesh and check every place can be reached from spawn 1">
          Check routes
        </button>
        {reachIssues && <span style={{ fontSize: 12, alignSelf: "center" }}>{reachIssues.length === 0 ? "every place reachable" : `${reachIssues.length} unreachable`}</span>}
      </div>

      {cartId && (
        <RailHint>
          <a href={`${basePath}/lockout?map=cart:${encodeURIComponent(cartId)}`} target="_blank" rel="noreferrer">
            Play this arena with bots
          </a>{" "}
          (save first: it plays the copy saved in this browser).
        </RailHint>
      )}
      <button type="button" className={styles.toolBtn} onClick={() => window.confirm("Remove this scene's arena markup and collision?") && set(null)}>
        Remove arena map
      </button>
    </RailGroup>
  );
}

const WEAPON_SET = ARENA_WEAPONS as readonly ArenaWeapon[];

/** The selected marker's own settings: a spawn's team, a pad's weapons, a box's size, a destination's power, a teleporter's facing. */
function SelectedMarkup({ map, refd, onMap, onDone, onMove, moving }: { map: ArenaMap; refd: MarkupRef; onMap: (m: ArenaMap) => void; onDone: () => void; onMove: (kind: MarkupKind) => void; moving: boolean }) {
  const { kind, index } = refd;
  const boxOf = kind === "pad" ? map.markers[index]?.box : kind === "kill" ? map.kills?.[index] : kind === "collider" ? map.solids[index] : undefined;
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: 6, margin: "6px 0" }}>
      <div style={{ fontSize: 12, marginBottom: 4 }}>
        {MARKUP_LABELS[kind]} {kind === "ball" ? "" : index + 1} {moving ? "— click where it goes" : ""}
      </div>
      {kind === "spawn" && map.spawns[index] && (
        <select
          aria-label="Spawn team"
          value={map.spawns[index]!.team ?? ""}
          onChange={(e) => {
            const team = e.target.value === "blue" || e.target.value === "red" ? e.target.value : undefined;
            onMap({ ...map, spawns: map.spawns.map((s, i) => (i === index ? { at: s.at, ...(team ? { team } : {}) } : s)) });
          }}
          style={{ width: "100%" }}
        >
          <option value="">Any team</option>
          <option value="blue">Blue</option>
          <option value="red">Red</option>
        </select>
      )}
      {kind === "pad" && map.markers[index] && (
        <>
          <select
            aria-label="Pad weapon"
            value={map.markers[index]!.weapon}
            onChange={(e) => {
              const weapon = e.target.value as ArenaWeapon;
              onMap({ ...map, markers: map.markers.map((m, i) => (i === index ? { ...m, weapon, ...(m.rotation ? { rotation: [weapon, ...m.rotation.slice(1)] } : {}) } : m)) });
            }}
            style={{ width: "100%" }}
          >
            {WEAPON_SET.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Pad rotation"
            placeholder="Then turns through… (e.g. sniper, rocket)"
            defaultValue={(map.markers[index]!.rotation ?? []).slice(1).join(", ")}
            onBlur={(e) => {
              const rest = e.target.value
                .split(/[\s,]+/)
                .filter((w): w is ArenaWeapon => WEAPON_SET.includes(w as ArenaWeapon))
                .slice(0, 5);
              onMap({
                ...map,
                markers: map.markers.map((m, i) => {
                  if (i !== index) return m;
                  const { rotation: _r, ...plain } = m;
                  void _r;
                  return rest.length > 0 ? { ...plain, rotation: [m.weapon, ...rest] } : plain;
                }),
              });
            }}
            style={{ width: "100%", marginTop: 4 }}
          />
        </>
      )}
      {kind === "destination" && (
        <label style={{ display: "flex", gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={map.power.includes(index)} onChange={(e) => onMap(setPower(map, index, e.target.checked))} />
          A power position (bots fight to hold it)
        </label>
      )}
      {(kind === "teleporter" || kind === "exit") && map.teleporters?.[index] && (
        <RangeControl
          label="Facing on arrival"
          nested
          min={0}
          max={360}
          step={15}
          value={Math.round(((map.teleporters[index]!.yaw * 180) / Math.PI + 360) % 360)}
          ariaLabel="Teleporter arrival facing"
          display={`${Math.round(((map.teleporters[index]!.yaw * 180) / Math.PI + 360) % 360)}°`}
          onChange={(deg) => onMap({ ...map, teleporters: map.teleporters!.map((t, i) => (i === index ? { ...t, yaw: (deg * Math.PI) / 180 } : t)) })}
        />
      )}
      {boxOf &&
        (["width", "height", "depth"] as const).map((label, axis) => (
          <RangeControl
            key={label}
            label={label[0]!.toUpperCase() + label.slice(1)}
            nested
            min={0.1}
            max={kind === "pad" ? 4 : 60}
            step={0.1}
            value={boxOf[3 + axis]! * 2}
            ariaLabel={`${MARKUP_LABELS[kind]} ${label}`}
            display={`${(boxOf[3 + axis]! * 2).toFixed(1)} m`}
            onChange={(size) => {
              const half: [number, number, number] = [boxOf[3]!, boxOf[4]!, boxOf[5]!];
              half[axis] = size / 2;
              onMap(resizeMarkup(map, refd, half));
            }}
          />
        ))}
      <div className={styles.toolGroup} style={{ marginTop: 4 }}>
        <button type="button" className={styles.toolBtn} onClick={() => onMove(kind)}>
          Move
        </button>
        {kind === "teleporter" && (
          <button type="button" className={styles.toolBtn} onClick={() => onMove("exit")}>
            Move exit
          </button>
        )}
        {kind !== "ball" && (
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => {
              onMap(removeMarkup(map, refd));
              onDone();
            }}
          >
            Remove
          </button>
        )}
        <button type="button" className={styles.toolBtn} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
