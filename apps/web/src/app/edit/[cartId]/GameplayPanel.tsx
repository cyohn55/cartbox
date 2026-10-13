"use client";

/**
 * A map's gameplay in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP22–EP25,
 * BEAVER_CREEK_ROADMAP.md B4) — Unreal's Place Actors panel, its Outliner's
 * gameplay actors, Map Check and Build, for an arena map:
 *
 * - **Place:** a spawn (either team or any), a weapon pad, a hill, a bot
 *   destination, a teleporter or a collider, set down on the floor where the
 *   scene view is looking.
 * - **Outliner:** every actor by kind; a click selects it in the scene view,
 *   where it is dragged with the move gizmo (and boxes sized with scale).
 * - **Map Check:** what would spoil a match on the map, each problem a link
 *   that shows it in the view.
 * - **Navigation:** the bots' navmesh rebuilt from the collision, and a note
 *   when the collision has changed since.
 * - **Ground:** the walkable ground sampled from a terrain sculpted here.
 * - **Build:** the cart's map lines rewritten and its Pickups laid out for
 *   the edited markup, so Play (here and in the demo) plays it.
 *
 * And {@link ArenaActorInspector}, the Details panel for a selected actor.
 */

import { useMemo, useRef, useState } from "react";

import {
  ARENA_ACTOR_LABELS,
  ARENA_MAPS,
  ARENA_WEAPONS,
  addArenaActor,
  arenaActor,
  arenaActors,
  arenaGround,
  isArenaCode,
  readTerrain,
  sameArenaCollision,
  setArenaGround,
  setDestinationPower,
  setPadWeapons,
  setSpawnTeam,
  setTeleporterYaw,
  moveArenaActor,
  resizeArenaActor,
  terrainHeight,
  type ArenaActor,
  type ArenaActorKind,
  type ArenaIssue,
  type ArenaMap,
  type ArenaPoint,
  type ArenaTeam,
  type ArenaWeapon,
  type PlaceableArenaKind,
} from "@cartbox/editor";

import { buildArenaToGame, checkArenaMap, rebuildArenaNavigation } from "@/lib/arenaBuild";
import { arenaFloorBelow } from "@/lib/arenaOverlay";
import { setMeshArena, type MeshSidecar } from "@/lib/meshSidecar";
import { basePath } from "@/lib/staticSite";
import type { Vec3 } from "@/lib/viewportCamera";
import { clickSelection } from "@/lib/sceneSelection";
import type { CodeAccess } from "./ContentBrowser";
import styles from "./editor.module.css";
import { RailGroup, RailHint } from "./railControls";

/** A blank map: nothing placed yet, the ball at the origin, a death plane well below. */
function blankMap(): ArenaMap {
  return { id: "custom", name: "Custom map", solids: [], flights: [], spawns: [], destinations: [], power: [], hills: [], ball: [0, 0, 0], deathY: -10, markers: [] };
}

const PLACE: { kind: PlaceableArenaKind; label: string; team?: ArenaTeam; hint: string }[] = [
  { kind: "spawn", label: "Spawn", hint: "A spawn any team (and Free for All) uses" },
  { kind: "spawn", label: "Blue spawn", team: "blue", hint: "A spawn for the blue team" },
  { kind: "spawn", label: "Red spawn", team: "red", hint: "A spawn for the red team" },
  { kind: "pad", label: "Weapon pad", hint: "A pad that holds a weapon (set what it turns through in Details)" },
  { kind: "hill", label: "Hill", hint: "A King of the Hill hill (they rotate in order)" },
  { kind: "dest", label: "Destination", hint: "A place bots go (make it a power position in Details)" },
  { kind: "tpfrom", label: "Teleporter", hint: "A one-way teleporter and its exit (drag the exit where it should send you)" },
  { kind: "solid", label: "Collider", hint: "A box players, shots and bots collide with (shown with Show → Collision)" },
];

const KIND_ORDER: ArenaActorKind[] = ["spawn", "pad", "hill", "ball", "dest", "tpfrom", "solid", "flight", "death"];

/** The outliner's group headings. */
const GROUP_LABELS: Readonly<Record<ArenaActorKind, string>> = {
  spawn: "Spawns",
  pad: "Weapon pads",
  hill: "Hills",
  ball: "Ball",
  dest: "Bot destinations",
  tpfrom: "Teleporters",
  tpto: "Teleporters",
  solid: "Colliders",
  flight: "Steps",
  death: "Death plane",
};

interface GameplayPanelProps {
  sidecar: MeshSidecar;
  onSidecarChange: (sidecar: MeshSidecar) => void;
  selectedIds: readonly string[];
  onSelectIds: (ids: string[]) => void;
  /** Where the scene view is looking: new actors are set down on the floor there. */
  viewTarget: Vec3 | null;
  /** Show a point in the scene view (and turn the view to Scene). */
  onFocus: (at: Vec3) => void;
  code?: CodeAccess;
  cartId?: string;
}

export function GameplayPanel({ sidecar, onSidecarChange, selectedIds, onSelectIds, viewTarget, onFocus, code, cartId }: GameplayPanelProps) {
  const map = sidecar.arena ?? null;
  const [issues, setIssues] = useState<readonly ArenaIssue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The collision the navmesh was last built from (here, or as the cart opened). */
  const navFor = useRef<ArenaMap | null>(map);
  const navStale = map && navFor.current ? !sameArenaCollision(map, navFor.current) : false;
  const actors = useMemo(() => (map ? arenaActors(map) : []), [map]);
  const selected = new Set(selectedIds);
  const setMap = (next: ArenaMap) => onSidecarChange(setMeshArena(sidecar, next));
  /** Run something slow after the panel has said it's busy. */
  const later = (label: string, work: () => void) => {
    setBusy(label);
    setTimeout(() => {
      try {
        work();
      } finally {
        setBusy(null);
      }
    }, 30);
  };

  if (!map) {
    return (
      <RailGroup label="Gameplay" collapsible defaultOpen={false}>
        <RailHint>
          This scene has no arena markup. Start one to place spawns, weapon pads, hills, bot destinations, teleporters and colliders in the scene view, as an
          arena map&apos;s are (Lockout&apos;s and Beaver Creek&apos;s open with theirs).
        </RailHint>
        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolBtn} onClick={() => setMap(blankMap())}>
            Start map markup
          </button>
        </div>
      </RailGroup>
    );
  }

  const place = (kind: PlaceableArenaKind, team?: ArenaTeam) => {
    const at = viewTarget ?? [0, 0, 0];
    const floor = arenaFloorBelow(map, at[0], at[1] + 2, at[2], 0) ?? at[1];
    const added = addArenaActor(map, kind, [round(at[0]), round(floor), round(at[2])], team ? { team } : {});
    setMap(added.map);
    onSelectIds([added.id]);
  };

  const check = () =>
    later("Checking…", () => {
      setIssues(checkArenaMap(sidecar));
    });

  const rebuild = () =>
    later("Building navigation…", () => {
      onSidecarChange(rebuildArenaNavigation(sidecar));
      navFor.current = map;
      setIssues(null);
    });

  const build = () =>
    later("Building…", () => {
      if (!code) return setNote("This cart's code can't be reached from here.");
      const built = buildArenaToGame(code.getText(), sidecar);
      if (!built) return;
      if (built.missing.length > 0) {
        setNote(`The code isn't an arena cart's (or its map lines were edited away): it has no ${built.missing.slice(0, 3).map((k) => `"${k}"`).join(", ")} line. The scene's Pickups were still laid out.`);
      } else {
        if (built.changed > 0) code.setText(built.code);
        setNote(`${built.changed === 0 ? "The code already plays this markup." : `Rewrote ${built.changed} map line${built.changed === 1 ? "" : "s"} in the code.`}${built.warning ? ` ${built.warning}` : ""}`);
      }
      onSidecarChange(built.sidecar);
      setIssues(checkArenaMap(built.sidecar));
    });

  const groundFrom = (terrainId: string) => {
    const stored = sidecar.terrains?.find((t) => (t as { id?: string }).id === terrainId);
    const terrain = stored ? readTerrain(stored) : null;
    if (!terrain) return;
    // The ground's own grid when it has one, else the terrain's extent at about a metre a sample.
    const g = map.ground;
    const n = g ? g.n : Math.min(257, Math.max(2, Math.round(Math.max(...terrain.size)) + 1));
    const step = g ? g.step : Math.max(...terrain.size) / (n - 1);
    const ground = arenaGround(g ? g.x0 : terrain.origin[0], g ? g.z0 : terrain.origin[2], step, n, (x, z) => terrainHeight(terrain, x, z) ?? NaN);
    setMap(setArenaGround(map, ground));
    setNote(`Ground sampled from "${terrain.name}": ${n}×${n} heights ${step.toFixed(2)} m apart. Rebuild navigation so bots walk it.`);
  };

  const terrains = (sidecar.terrains ?? []).map((t) => readTerrain(t)).filter((t): t is NonNullable<typeof t> => t !== null);
  const known = ARENA_MAPS.some((m) => m.id === map.id);
  const codeOk = code ? isArenaCode(code.getText()) : false;

  return (
    <RailGroup label="Gameplay" collapsible defaultOpen>
      <RailHint>
        {map.name}: {map.spawns.length} spawns, {map.markers.length} pads, {map.hills.length} hills, {map.destinations.length} destinations, {(map.teleporters ?? []).length} teleporters,{" "}
        {map.solids.length} colliders{map.ground ? ", ground" : ""}.
      </RailHint>

      <div className={styles.toolGroup} role="group" aria-label="Place actors">
        {PLACE.map((p) => (
          <button key={p.label} type="button" className={styles.toolBtn} title={`${p.hint}, on the floor where the view is looking`} onClick={() => place(p.kind, p.team)}>
            + {p.label}
          </button>
        ))}
      </div>

      <div style={{ maxHeight: 260, overflowY: "auto", display: "grid", gap: 2, fontSize: 12 }} role="tree" aria-label="Gameplay actors">
        {KIND_ORDER.map((kind) => {
          const list = actors.filter((a) => a.kind === kind || (kind === "tpfrom" && a.kind === "tpto"));
          if (list.length === 0) return null;
          return (
            <details key={kind} open={list.length <= 8 || list.some((a) => selected.has(a.id))}>
              <summary style={{ cursor: "pointer", color: "var(--muted)" }}>
                {GROUP_LABELS[kind]} ({list.length})
              </summary>
              {list.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="treeitem"
                  aria-selected={selected.has(a.id)}
                  onClick={(event) => onSelectIds(clickSelection([...selectedIds], a.id, { toggle: event.ctrlKey || event.metaKey, add: event.shiftKey }))}
                  onDoubleClick={() => onFocus(a.at as Vec3)}
                  title="Click to select (Shift adds, Ctrl toggles); double-click to show it in the view"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "2px 8px",
                    border: 0,
                    borderRadius: 4,
                    background: selected.has(a.id) ? "rgba(125, 184, 252, 0.22)" : "transparent",
                    color: "inherit",
                    font: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {a.name}
                </button>
              ))}
            </details>
          );
        })}
      </div>

      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolBtn} disabled={busy !== null} onClick={check} title="Unreal's Map Check: spawns with no floor or in a wall, places bots can't reach, anything near the death plane or beyond the net state, a sidecar over budget">
          Map Check
        </button>
        <button type="button" className={styles.toolBtn} disabled={busy !== null} onClick={rebuild} title="Bake the bots' navmesh from the colliders, steps and ground">
          Rebuild navigation
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          disabled={busy !== null}
          onClick={build}
          title="Write the markup into the cart: its map lines in the code, and the Pickups over the pads"
          style={{ fontWeight: 600 }}
        >
          Build
        </button>
      </div>
      {busy && <RailHint>{busy}</RailHint>}
      {navStale && <RailHint>The collision has changed since the navigation was built: rebuild it so bots walk the new layout.</RailHint>}
      {issues && (
        <div role="list" aria-label="Map Check" style={{ display: "grid", gap: 4, fontSize: 12 }}>
          {issues.length === 0 ? (
            <span role="listitem" style={{ color: "#7dff9a" }}>
              Map Check: no problems.
            </span>
          ) : (
            issues.map((issue, i) => (
              <button
                key={i}
                type="button"
                role="listitem"
                disabled={!issue.at}
                onClick={() => {
                  if (!issue.at) return;
                  const near = actors.find((a) => a.at.every((v, k) => Math.abs(v - issue.at![k]!) < 1e-6) || (a.kind === "pad" && Math.abs(a.at[0] - issue.at![0]) < 1e-6 && Math.abs(a.at[2] - issue.at![2]) < 1e-6));
                  if (near) onSelectIds([near.id]);
                  onFocus(issue.at as Vec3);
                }}
                style={{ textAlign: "left", border: 0, background: "rgba(255, 106, 90, 0.12)", color: "#ffb4a8", borderRadius: 4, padding: "3px 6px", font: "inherit", cursor: issue.at ? "pointer" : "default" }}
              >
                ⚠ {issue.message}
              </button>
            ))
          )}
        </div>
      )}
      {note && <RailHint>{note}</RailHint>}

      {terrains.length > 0 && (
        <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
          Ground from terrain
          <select aria-label="Ground from terrain" value="" onChange={(event) => event.target.value && groundFrom(event.target.value)}>
            <option value="">Sample a terrain into walkable ground…</option>
            {terrains.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <RailHint>
        Select an actor in the scene view or above, and drag it with the move gizmo (W); colliders and pads also size with scale (R). End drops the selection to
        the floor, Delete removes it, Ctrl+D duplicates it. Build writes it into the game{code && !codeOk ? " (this cart's code isn't an arena cart's, so only the Pickups follow)" : ""}.
      </RailHint>
      {cartId && known && (
        <RailHint>
          <a href={`${basePath}/lockout?map=${encodeURIComponent(map.id)}&assets=${encodeURIComponent(cartId)}`} target="_blank" rel="noreferrer">
            Play this {ARENA_MAPS.find((m) => m.id === map.id)!.name} markup in the Lockout demo
          </a>{" "}
          (save first; it reads the copy saved in this browser).
        </RailHint>
      )}
    </RailGroup>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

/** A number field that commits on change (blank or not a number: ignored). */
function NumberField({ label, value, step = 0.1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "grid", gap: 2, fontSize: 11, color: "var(--muted)" }}>
      {label}
      <input
        type="number"
        aria-label={label}
        step={step}
        value={Number(value.toFixed(3))}
        onChange={(event) => {
          const v = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(v)) onChange(v);
        }}
        style={{ width: "100%", padding: "4px 6px", borderRadius: 6 }}
      />
    </label>
  );
}

/** Three number fields for a point. */
function PointFields({ label, at, onChange }: { label: string; at: ArenaPoint; onChange: (p: ArenaPoint) => void }) {
  return (
    <RailGroup label={label}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {(["X", "Y", "Z"] as const).map((axis, k) => (
          <NumberField key={axis} label={axis} value={at[k]!} onChange={(v) => onChange(at.map((c, j) => (j === k ? v : c)) as unknown as ArenaPoint)} />
        ))}
      </div>
    </RailGroup>
  );
}

/** Details for a selected gameplay actor (EP22): where it is, and what it is. */
export function ArenaActorInspector({ sidecar, onSidecarChange, id, onRemove, onDuplicate }: { sidecar: MeshSidecar; onSidecarChange: (s: MeshSidecar) => void; id: string; onRemove: () => void; onDuplicate: () => void }) {
  const map = sidecar.arena;
  const actor: ArenaActor | null = map ? arenaActor(map, id) : null;
  if (!map || !actor) return <RailHint>That actor is no longer in the map.</RailHint>;
  const setMap = (next: ArenaMap) => onSidecarChange(setMeshArena(sidecar, next));
  const i = actor.index;
  return (
    <>
      <RailGroup label={ARENA_ACTOR_LABELS[actor.kind]}>
        <RailHint>{actor.name}</RailHint>
      </RailGroup>
      {actor.kind === "death" ? (
        <RailGroup label="Height">
          <NumberField label="Fall below this and you die" value={map.deathY} onChange={(v) => setMap(moveArenaActor(map, id, [0, v, 0]))} />
        </RailGroup>
      ) : (
        <PointFields label={actor.half ? "Centre" : actor.kind === "flight" ? "Top of the first step" : "Feet"} at={actor.at} onChange={(p) => setMap(moveArenaActor(map, id, p))} />
      )}
      {actor.half && (
        <PointFields label="Half size" at={actor.half} onChange={(h) => setMap(resizeArenaActor(map, id, h))} />
      )}
      {actor.kind === "spawn" && (
        <RailGroup label="Team">
          <select
            aria-label="Spawn team"
            value={map.spawns[i]?.team ?? ""}
            onChange={(event) => setMap(setSpawnTeam(map, i, (event.target.value || null) as ArenaTeam | null))}
            style={{ width: "100%", padding: "6px 8px", borderRadius: 6 }}
          >
            <option value="">Any (Free for All, and either team)</option>
            <option value="blue">Blue</option>
            <option value="red">Red</option>
          </select>
        </RailGroup>
      )}
      {actor.kind === "pad" && <PadWeapons weapons={map.markers[i]!.rotation ?? [map.markers[i]!.weapon]} onChange={(w) => setMap(setPadWeapons(map, i, w))} />}
      {actor.kind === "dest" && (
        <RailGroup label="Power position">
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" aria-label="Power position" checked={map.power.includes(i)} onChange={(event) => setMap(setDestinationPower(map, i, event.target.checked))} />
            Bots like to hold it
          </label>
        </RailGroup>
      )}
      {(actor.kind === "tpfrom" || actor.kind === "tpto") && (
        <RailGroup label="Facing on arrival">
          <NumberField
            label="Degrees (0 along +Z, 90 along +X)"
            step={15}
            value={((map.teleporters?.[i]?.yaw ?? 0) * 180) / Math.PI}
            onChange={(deg) => setMap(setTeleporterYaw(map, i, (deg * Math.PI) / 180))}
          />
        </RailGroup>
      )}
      {actor.kind !== "ball" && actor.kind !== "death" && (
        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolBtn} onClick={onDuplicate} title="Duplicate (Ctrl+D)">
            Duplicate
          </button>
          <button type="button" className={styles.toolBtn} onClick={onRemove} title="Delete">
            Delete
          </button>
        </div>
      )}
    </>
  );
}

/** A pad's weapons, in the order it turns through them (the first is what it starts with). */
function PadWeapons({ weapons, onChange }: { weapons: readonly ArenaWeapon[]; onChange: (w: ArenaWeapon[]) => void }) {
  return (
    <RailGroup label="Weapons, in turn">
      <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 12 }}>
        {weapons.map((w, k) => (
          <li key={`${w}-${k}`}>
            <select aria-label={`Weapon ${k + 1}`} value={w} onChange={(event) => onChange(weapons.map((x, j) => (j === k ? (event.target.value as ArenaWeapon) : x)))}>
              {ARENA_WEAPONS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>{" "}
            {weapons.length > 1 && (
              <button type="button" className="cbx-btn" aria-label={`Remove weapon ${k + 1}`} onClick={() => onChange(weapons.filter((_, j) => j !== k))} style={{ padding: "0 6px" }}>
                ×
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolBtn} onClick={() => onChange([...weapons, "br"])}>
          + Weapon
        </button>
      </div>
      <RailHint>Each weapon taken turns the pad to the next. Build lays out a Pickup for each.</RailHint>
    </RailGroup>
  );
}
