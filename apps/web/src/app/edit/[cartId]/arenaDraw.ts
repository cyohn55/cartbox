/**
 * Drawing a map's markup over the scene view (ENGINE_PARITY_ROADMAP.md
 * EP22–EP23), the way Unreal draws its actors' sprites and its Show menu's
 * views: a coloured icon for every spawn, pad, hill, destination, ball and
 * teleporter end, a dashed arc from each teleporter to its exit, the death
 * plane's outline, the colliders, steps and ground in wireframe (Collision),
 * and the bots' walkable floors as points (Navigation).
 *
 * Icons are drawn over the scene (not hidden by it), as editor sprites are,
 * so markup inside a structure stays findable.
 */

import type { ArenaActor, ArenaMap, ArenaPoint } from "@cartbox/editor";

import { actorBox, flightBoxes, iconPoint, type ArenaShowFlags } from "@/lib/arenaOverlay";
import type { Vec3 } from "@/lib/viewportCamera";

type Projector = (p: Vec3) => [number, number] | null;

const SELECTED = "#ffd84a";
const TEAM: Record<string, string> = { blue: "#5a9bff", red: "#ff6a5a" };
const COLOURS: Record<string, string> = {
  spawn: "#e8ecf8",
  pad: "#4fe3ff",
  hill: "#ffc94a",
  ball: "#ffffff",
  dest: "#62e08a",
  power: "#ffb347",
  tpfrom: "#c08bff",
  tpto: "#c08bff",
  solid: "#ff9a3c",
  flight: "#ff9a3c",
  death: "#ff4a6a",
};

/** A box's twelve edges, projected and stroked. */
function strokeBox(context: CanvasRenderingContext2D, project: Projector, min: Vec3, max: Vec3): void {
  const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const edges: [number, number][] = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, b] of edges) {
    const pa = project(c(a));
    const pb = project(c(b));
    if (!pa || !pb) continue;
    context.moveTo(pa[0], pa[1]);
    context.lineTo(pb[0], pb[1]);
  }
}

/** A flat ring on the ground, `r` metres round `centre`. */
function strokeRing(context: CanvasRenderingContext2D, project: Projector, centre: ArenaPoint, r: number): void {
  let pen = false;
  for (let k = 0; k <= 32; k += 1) {
    const a = (k / 32) * Math.PI * 2;
    const p = project([centre[0] + Math.cos(a) * r, centre[1] + 0.02, centre[2] + Math.sin(a) * r]);
    if (!p) {
      pen = false;
      continue;
    }
    if (pen) context.lineTo(p[0], p[1]);
    else context.moveTo(p[0], p[1]);
    pen = true;
  }
}

export interface ArenaDrawInput {
  readonly map: ArenaMap;
  readonly actors: readonly ArenaActor[];
  readonly flags: ArenaShowFlags;
  readonly selected: ReadonlySet<string>;
  readonly project: Projector;
  /** Canvas pixels per CSS pixel (lines and icons keep their size on screen). */
  readonly pixel: number;
  /** The ground's wireframe (Collision) and the navmesh's floors (Navigation), precomputed. */
  readonly groundSegments: readonly (readonly [Vec3, Vec3])[];
  readonly navPoints: readonly Vec3[];
  /** Label the actors (names beside their icons). */
  readonly labels: boolean;
}

export function drawArena(context: CanvasRenderingContext2D, input: ArenaDrawInput): void {
  const { map, actors, flags, selected, project, pixel } = input;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  if (flags.navigation && input.navPoints.length > 0) {
    context.fillStyle = "rgba(98, 224, 138, 0.55)";
    const s = 2 * pixel;
    for (const p of input.navPoints) {
      const q = project([p[0], p[1] + 0.03, p[2]]);
      if (q) context.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
    }
  }

  if (flags.collision) {
    if (input.groundSegments.length > 0) {
      context.strokeStyle = "rgba(255, 154, 60, 0.28)";
      context.lineWidth = pixel;
      context.beginPath();
      for (const [a, b] of input.groundSegments) {
        const pa = project(a);
        const pb = project(b);
        if (!pa || !pb) continue;
        context.moveTo(pa[0], pa[1]);
        context.lineTo(pb[0], pb[1]);
      }
      context.stroke();
    }
    for (const a of actors) {
      if (a.kind !== "solid" && a.kind !== "flight") continue;
      const on = selected.has(a.id);
      context.strokeStyle = on ? SELECTED : "rgba(255, 154, 60, 0.75)";
      context.lineWidth = (on ? 2 : 1.2) * pixel;
      context.beginPath();
      if (a.kind === "solid") {
        const box = actorBox(a);
        if (box) strokeBox(context, project, box.min, box.max);
      } else {
        for (const box of flightBoxes(map, a.index)) strokeBox(context, project, box.min, box.max);
      }
      context.stroke();
      if (a.kind === "flight") drawIcon(context, project, a, COLOURS.flight!, on, pixel, "▤", input.labels);
    }
  }

  if (flags.gameplay) {
    // The teleporters' arcs first, under their ends' icons.
    for (const [i, t] of (map.teleporters ?? []).entries()) {
      const on = selected.has(`arena:tpfrom:${i}`) || selected.has(`arena:tpto:${i}`);
      context.strokeStyle = on ? SELECTED : "rgba(192, 139, 255, 0.8)";
      context.lineWidth = 1.5 * pixel;
      context.setLineDash([6 * pixel, 5 * pixel]);
      context.beginPath();
      let pen = false;
      const lift = Math.max(2, Math.hypot(t.to[0] - t.from[0], t.to[2] - t.from[2]) * 0.25);
      for (let k = 0; k <= 24; k += 1) {
        const u = k / 24;
        const p = project([t.from[0] + (t.to[0] - t.from[0]) * u, t.from[1] + (t.to[1] - t.from[1]) * u + Math.sin(u * Math.PI) * lift, t.from[2] + (t.to[2] - t.from[2]) * u]);
        if (!p) {
          pen = false;
          continue;
        }
        if (pen) context.lineTo(p[0], p[1]);
        else context.moveTo(p[0], p[1]);
        pen = true;
      }
      context.stroke();
      context.setLineDash([]);
    }
    const power = new Set(map.power);
    for (const a of actors) {
      const on = selected.has(a.id);
      switch (a.kind) {
        case "spawn": {
          const team = map.spawns[a.index]?.team;
          const colour = team ? TEAM[team]! : COLOURS.spawn!;
          // A standing figure: feet ring, body line, head.
          context.strokeStyle = on ? SELECTED : colour;
          context.lineWidth = (on ? 2.5 : 1.8) * pixel;
          context.beginPath();
          strokeRing(context, project, a.at, 0.4);
          const feet = project(a.at);
          const head = project([a.at[0], a.at[1] + 1.8, a.at[2]]);
          if (feet && head) {
            context.moveTo(feet[0], feet[1]);
            context.lineTo(head[0], head[1]);
          }
          context.stroke();
          drawIcon(context, project, a, colour, on, pixel, "◆", input.labels);
          break;
        }
        case "pad": {
          const box = actorBox(a);
          context.strokeStyle = on ? SELECTED : COLOURS.pad!;
          context.lineWidth = (on ? 2.2 : 1.5) * pixel;
          context.beginPath();
          if (box) strokeBox(context, project, box.min, box.max);
          context.stroke();
          drawIcon(context, project, a, COLOURS.pad!, on, pixel, "✦", input.labels);
          break;
        }
        case "hill": {
          context.strokeStyle = on ? SELECTED : COLOURS.hill!;
          context.lineWidth = (on ? 2.5 : 1.6) * pixel;
          context.beginPath();
          strokeRing(context, project, a.at, 2);
          context.stroke();
          drawIcon(context, project, a, COLOURS.hill!, on, pixel, "▲", input.labels);
          break;
        }
        case "tpfrom":
        case "tpto": {
          context.strokeStyle = on ? SELECTED : COLOURS.tpfrom!;
          context.lineWidth = (on ? 2.5 : 1.6) * pixel;
          context.beginPath();
          strokeRing(context, project, a.at, 0.8);
          context.stroke();
          drawIcon(context, project, a, COLOURS.tpfrom!, on, pixel, a.kind === "tpfrom" ? "⊙" : "◎", input.labels);
          break;
        }
        case "dest":
          drawIcon(context, project, a, power.has(a.index) ? COLOURS.power! : COLOURS.dest!, on, pixel, power.has(a.index) ? "★" : "•", input.labels && (on || power.has(a.index)));
          break;
        case "ball":
          drawIcon(context, project, a, COLOURS.ball!, on, pixel, "●", input.labels);
          break;
        case "death": {
          // The plane's outline under the map's footprint.
          const half = deathHalf(map);
          const [cx, y, cz] = a.at;
          const corners: Vec3[] = [[cx - half[0], y, cz - half[1]], [cx + half[0], y, cz - half[1]], [cx + half[0], y, cz + half[1]], [cx - half[0], y, cz + half[1]]];
          const pts = corners.map(project);
          if (pts.every((p) => p)) {
            context.strokeStyle = on ? SELECTED : "rgba(255, 74, 106, 0.7)";
            context.fillStyle = "rgba(255, 74, 106, 0.06)";
            context.lineWidth = (on ? 2 : 1.2) * pixel;
            context.setLineDash([8 * pixel, 6 * pixel]);
            context.beginPath();
            pts.forEach((p, i) => (i === 0 ? context.moveTo(p![0], p![1]) : context.lineTo(p![0], p![1])));
            context.closePath();
            context.fill();
            context.stroke();
            context.setLineDash([]);
          }
          drawIcon(context, project, a, COLOURS.death!, on, pixel, "☠", input.labels);
          break;
        }
        default:
          break;
      }
    }
  }
  context.restore();
}

/** Half the death plane's drawn size: the map's colliders' and ground's footprint, at least 10 m. */
function deathHalf(map: ArenaMap): [number, number] {
  let hx = 10;
  let hz = 10;
  const [cx, , cz] = deathCentre(map);
  for (const [x, , z, sx, , sz] of map.solids) {
    hx = Math.max(hx, Math.abs(x - cx) + sx);
    hz = Math.max(hz, Math.abs(z - cz) + sz);
  }
  if (map.ground) {
    const span = map.ground.step * (map.ground.n - 1);
    hx = Math.max(hx, Math.abs(map.ground.x0 - cx), Math.abs(map.ground.x0 + span - cx));
    hz = Math.max(hz, Math.abs(map.ground.z0 - cz), Math.abs(map.ground.z0 + span - cz));
  }
  return [hx, hz];
}

function deathCentre(map: ArenaMap): ArenaPoint {
  const xs = map.solids.flatMap(([x, , , hx]) => [x - hx, x + hx]);
  const zs = map.solids.flatMap(([, , z, , , hz]) => [z - hz, z + hz]);
  if (map.ground) {
    const span = map.ground.step * (map.ground.n - 1);
    xs.push(map.ground.x0, map.ground.x0 + span);
    zs.push(map.ground.z0, map.ground.z0 + span);
  }
  const mid = (v: number[]) => (v.length > 0 ? (Math.min(...v) + Math.max(...v)) / 2 : 0);
  return [mid(xs), map.deathY, mid(zs)];
}

/** An actor's icon: a filled disc with its glyph, a dark rim, and (optionally) its name. */
function drawIcon(context: CanvasRenderingContext2D, project: Projector, actor: ArenaActor, colour: string, on: boolean, pixel: number, glyph: string, label: boolean): void {
  const p = project(iconPoint(actor));
  if (!p) return;
  const r = (on ? 9 : 7.5) * pixel;
  context.beginPath();
  context.arc(p[0], p[1], r, 0, Math.PI * 2);
  context.fillStyle = "rgba(10, 14, 26, 0.78)";
  context.fill();
  context.lineWidth = (on ? 2.5 : 1.5) * pixel;
  context.strokeStyle = on ? SELECTED : colour;
  context.stroke();
  context.fillStyle = on ? SELECTED : colour;
  context.font = `${Math.round(10 * pixel)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, p[0], p[1] + 0.5 * pixel);
  if (label) {
    context.font = `${Math.round(11 * pixel)}px system-ui, sans-serif`;
    context.textAlign = "left";
    context.lineWidth = 3 * pixel;
    context.strokeStyle = "rgba(10, 14, 26, 0.85)";
    context.strokeText(actor.name, p[0] + r + 3 * pixel, p[1]);
    context.fillStyle = on ? SELECTED : "rgba(232, 236, 248, 0.92)";
    context.fillText(actor.name, p[0] + r + 3 * pixel, p[1]);
  }
}
