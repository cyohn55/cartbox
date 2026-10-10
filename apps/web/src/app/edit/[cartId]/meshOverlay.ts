/**
 * Drawing over the Mesh tab's preview (LOCKOUT_MULTIPLAYER_ROADMAP.md L15):
 * the modelling wireframe, the selection, the box being dragged and the
 * move/rotate/scale gizmo, all projected with the preview's own camera so
 * they sit exactly on the software-rendered image beneath.
 */

import { primitiveTopology, projectPoint, selectionWelds, type MeshAsset, type MeshSelection } from "@cartbox/editor";

export type GizmoTool = "move" | "rotate" | "scale";
type Ndc = readonly [number, number];

const AXIS_COLORS = ["#ff5a5a", "#6bdc6b", "#5a8cff"] as const;
const SELECTED = "#ffb03a";

/** NDC (−1..1, y up) to canvas pixels. */
export const toPixels = (ndc: Ndc, size: number): [number, number] => [(ndc[0] + 1) * 0.5 * size, (1 - ndc[1]) * 0.5 * size];

/** The three handle tips of a gizmo at `pivot`, `length` world units along each axis, in NDC (null behind the eye). */
export function gizmoHandles(viewProj: ArrayLike<number>, pivot: readonly number[], length: number): ([number, number] | null)[] {
  return [0, 1, 2].map((axis) => {
    const tip = [pivot[0]!, pivot[1]!, pivot[2]!];
    tip[axis] = tip[axis]! + length;
    const s = projectPoint(viewProj, tip);
    return s ? [s[0], s[1]] : null;
  });
}

/** The gizmo axis whose handle is under a point (NDC), or null. */
export function gizmoHandleAt(viewProj: ArrayLike<number>, pivot: readonly number[], length: number, at: Ndc, reach = 0.06): 0 | 1 | 2 | null {
  const tips = gizmoHandles(viewProj, pivot, length);
  let best: { axis: 0 | 1 | 2; d: number } | null = null;
  tips.forEach((tip, axis) => {
    if (!tip) return;
    const d = Math.hypot(tip[0] - at[0], tip[1] - at[1]);
    if (d <= reach && (!best || d < best.d)) best = { axis: axis as 0 | 1 | 2, d };
  });
  return (best as { axis: 0 | 1 | 2 } | null)?.axis ?? null;
}

/**
 * The modelling overlay: every face's edges faintly, then the selection in
 * orange (welds as dots, edges as lines, faces filled), the box being
 * dragged, and the gizmo at the selection's centre.
 */
export function drawModelOverlay(
  ctx: CanvasRenderingContext2D,
  mesh: MeshAsset,
  selection: MeshSelection,
  viewProj: ArrayLike<number>,
  size: number,
  extra: { box?: { from: Ndc; to: Ndc } | null; gizmo?: { pivot: readonly number[]; length: number; tool: GizmoTool } | null },
): void {
  const px = (p: readonly number[]) => {
    const s = projectPoint(viewProj, p);
    return s ? toPixels([s[0], s[1]], size) : null;
  };
  const welds = selectionWelds(mesh, selection);
  ctx.save();
  mesh.primitives.forEach((p, i) => {
    const topo = primitiveTopology(p);
    const at = topo.weldVertices.map((_, w) => px([topo.weldPositions[w * 3]!, topo.weldPositions[w * 3 + 1]!, topo.weldPositions[w * 3 + 2]!]));
    // The wireframe: polygon edges, not the triangles' diagonals.
    ctx.strokeStyle = "rgba(200, 215, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const e of topo.edges) {
      const a = at[e.a], b = at[e.b];
      if (!a || !b) continue;
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    const ids = selection.parts[i] ?? [];
    if (selection.mode === "face") {
      ctx.fillStyle = "rgba(255, 176, 58, 0.28)";
      ctx.strokeStyle = SELECTED;
      ctx.lineWidth = 1.5;
      for (const f of ids) {
        const face = topo.faces[f];
        if (!face) continue;
        ctx.beginPath();
        for (const loop of face.loops) {
          loop.forEach((w, k) => {
            const q = at[w];
            if (!q) return;
            if (k === 0) ctx.moveTo(q[0], q[1]);
            else ctx.lineTo(q[0], q[1]);
          });
          ctx.closePath();
        }
        ctx.fill("evenodd");
        ctx.stroke();
      }
    } else if (selection.mode === "edge") {
      ctx.strokeStyle = SELECTED;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const id of ids) {
        const e = topo.edges[id];
        const a = e ? at[e.a] : null, b = e ? at[e.b] : null;
        if (!a || !b) continue;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    } else {
      // Every vertex as a small dot, the selected ones larger and orange.
      ctx.fillStyle = "rgba(200, 215, 255, 0.55)";
      for (const q of at) if (q) ctx.fillRect(q[0] - 1, q[1] - 1, 2, 2);
    }
    ctx.fillStyle = SELECTED;
    for (const w of welds[i] ?? []) {
      const q = at[w];
      if (q) ctx.fillRect(q[0] - 2.5, q[1] - 2.5, 5, 5);
    }
  });
  if (extra.box) {
    const [a, b] = [toPixels(extra.box.from, size), toPixels(extra.box.to, size)];
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.setLineDash([]);
  }
  if (extra.gizmo) drawGizmo(ctx, viewProj, size, extra.gizmo.pivot, extra.gizmo.length, extra.gizmo.tool);
  ctx.restore();
}

/** The gizmo: an axis line per direction with a handle at its tip — an arrow to move, a ring to rotate, a square to scale. */
export function drawGizmo(ctx: CanvasRenderingContext2D, viewProj: ArrayLike<number>, size: number, pivot: readonly number[], length: number, tool: GizmoTool): void {
  const c = projectPoint(viewProj, pivot);
  if (!c) return;
  const [cx, cy] = toPixels([c[0], c[1]], size);
  gizmoHandles(viewProj, pivot, length).forEach((tip, axis) => {
    if (!tip) return;
    const [x, y] = toPixels(tip, size);
    ctx.strokeStyle = AXIS_COLORS[axis]!;
    ctx.fillStyle = AXIS_COLORS[axis]!;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (tool === "move") {
      const angle = Math.atan2(y - cy, x - cx);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * 8, y + Math.sin(angle) * 8);
      ctx.lineTo(x + Math.cos(angle + 2.5) * 7, y + Math.sin(angle + 2.5) * 7);
      ctx.lineTo(x + Math.cos(angle - 2.5) * 7, y + Math.sin(angle - 2.5) * 7);
      ctx.closePath();
      ctx.fill();
    } else if (tool === "rotate") {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
    } else ctx.fillRect(x - 5, y - 5, 10, 10);
  });
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
}
