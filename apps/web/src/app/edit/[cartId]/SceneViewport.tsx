"use client";

/**
 * The 3D scene viewport (Phase 6 — 3D authoring UX): every placed mesh drawn
 * together through one camera with the scene's authored lighting, so a creator
 * composes a whole scene instead of previewing meshes one at a time. Click an
 * instance to select it; drag to move / rotate / scale the selection, or orbit
 * the camera. Selection and transforms flow through the same sidecar the rest of
 * the Mesh tab edits, so the numeric transform controls stay in lockstep.
 *
 * CPU-rendered by the shared software rasteriser (`renderMeshScene`), the same
 * one the runtime uses, so what the viewport shows is what the cart will show.
 * Picking is a world-space ray test against each instance's AABB (see scenePick),
 * needing no depth read-back or off-screen ID pass.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildSceneShadow,
  composeModelMatrix,
  multiplyMat4,
  projectionMatrix,
  renderMeshScene,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  viewMatrix,
  worldAabb,
  type DecodedTexture,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";

import { readMeshEntry, setMeshTransform, type MeshSidecar } from "@/lib/meshSidecar";
import { decodeMeshTextures } from "@/lib/meshImport";
import { cameraBasis, cameraRay, pickBoxes, type Vec3 } from "@/lib/scenePick";
import styles from "./editor.module.css";
import { SegmentedControl } from "./railControls";

const VIEWPORT = 512;
const FOV = (50 * Math.PI) / 180;
const ORBIT_SPEED = 0.01;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;
const DRAG_THRESHOLD = 3; // px before a press counts as a drag rather than a click
const SHADOW_SIZE = 1024;

type Mode = "orbit" | "move" | "rotate" | "scale";

interface SceneViewportProps {
  sidecar: MeshSidecar;
  onSidecarChange: (sidecar: MeshSidecar) => void;
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
}

/** A decoded mesh + its base-colour textures, rebuilt only when the geometry set changes. */
interface Decoded {
  readonly id: string;
  readonly mesh: MeshAsset;
  readonly textures: (DecodedTexture | null)[];
}

/** A render instance tagged with its sidecar id, for selection + gizmo overlay. */
type SceneInstance = MeshSceneInstance & { readonly id: string };

/** Project a world point to canvas pixels, or null when behind the camera. */
function project(viewProj: Mat4, p: Vec3): [number, number] | null {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const cw = viewProj[3]! * x + viewProj[7]! * y + viewProj[11]! * z + viewProj[15]!;
  if (cw <= 1e-6) return null;
  const cx = viewProj[0]! * x + viewProj[4]! * y + viewProj[8]! * z + viewProj[12]!;
  const cy = viewProj[1]! * x + viewProj[5]! * y + viewProj[9]! * z + viewProj[13]!;
  return [(cx / cw * 0.5 + 0.5) * VIEWPORT, (1 - (cy / cw * 0.5 + 0.5)) * VIEWPORT];
}

export function SceneViewport({ sidecar, onSidecarChange, selectedId, onSelectId }: SceneViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.4);
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<Mode>("orbit");
  const [decoded, setDecoded] = useState<Decoded[]>([]);

  const buffers = useMemo(
    () => ({ out: new Uint8ClampedArray(VIEWPORT * VIEWPORT * 4), depth: new Float32Array(VIEWPORT * VIEWPORT) }),
    [],
  );
  const shadowDepth = useRef<Float32Array | null>(null);

  // Decode geometry + base-colour textures only when the *set* of meshes changes
  // (id + payload), never on a transform edit — so dragging never re-decodes.
  const geometrySignature = sidecar.meshes.map((m) => `${m.id}:${m.mesh.length}`).join("|");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Decoded[] = [];
      for (const entry of sidecar.meshes) {
        let mesh: MeshAsset;
        try {
          mesh = readMeshEntry(entry);
        } catch {
          continue;
        }
        const textures = await decodeMeshTextures(mesh);
        next.push({ id: entry.id, mesh, textures });
      }
      if (!cancelled) setDecoded(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometrySignature]);

  // Build render instances from the decoded geometry + current transforms. Cheap,
  // so it runs every render — a transform edit is reflected without re-decoding.
  const instances = useMemo<SceneInstance[]>(() => {
    const out: SceneInstance[] = [];
    for (const d of decoded) {
      const entry = sidecar.meshes.find((m) => m.id === d.id);
      if (!entry) continue;
      const t = entry.transform;
      out.push({ id: d.id, mesh: d.mesh, textures: d.textures, model: composeModelMatrix(t.position, t.rotation, t.scale) });
    }
    return out;
  }, [decoded, sidecar.meshes]);

  // Scene bounds (centre + radius) from the union of every instance's world AABB.
  const bounds = useMemo(() => {
    let min: Vec3 = [Infinity, Infinity, Infinity];
    let max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const inst of instances) {
      const box = worldAabb(inst.mesh, inst.model);
      if (!box) continue;
      min = [Math.min(min[0], box.min[0]), Math.min(min[1], box.min[1]), Math.min(min[2], box.min[2])];
      max = [Math.max(max[0], box.max[0]), Math.max(max[1], box.max[1]), Math.max(max[2], box.max[2])];
    }
    if (!Number.isFinite(min[0])) return { center: [0, 0, 0] as Vec3, radius: 1 };
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(1e-3, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    return { center, radius };
  }, [instances]);

  // The orbit camera, computed directly (not via buildOrbitCamera) so the eye and
  // target are on hand for ray picking and the screen-space gizmo.
  const camera = useMemo(() => {
    const { center, radius } = bounds;
    const distance = (radius / Math.sin(FOV / 2) + radius) * zoom;
    const cosPitch = Math.cos(pitch);
    const eye: Vec3 = [
      center[0] + distance * cosPitch * Math.sin(yaw),
      center[1] + distance * Math.sin(pitch),
      center[2] + distance * cosPitch * Math.cos(yaw),
    ];
    const view = viewMatrix(eye, center);
    const projection = projectionMatrix(FOV, 1, Math.max(0.01, radius * 0.05), distance + radius * 4);
    return { eye, target: center, view, projection, viewProj: multiplyMat4(projection, view), distance };
  }, [bounds, yaw, pitch, zoom]);

  // Render the scene, then overlay the selection box + gizmo axes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = VIEWPORT;
    canvas.height = VIEWPORT;
    const context = canvas.getContext("2d");
    if (!context) return;

    const lighting = sidecar.lighting;
    let shadow = null;
    if (lighting?.shadows) {
      if (!shadowDepth.current) shadowDepth.current = new Float32Array(SHADOW_SIZE * SHADOW_SIZE);
      shadow = buildSceneShadow(instances, lighting, bounds.center, bounds.radius, { size: SHADOW_SIZE, depth: shadowDepth.current });
    }

    renderMeshScene(instances, {
      width: VIEWPORT,
      height: VIEWPORT,
      out: buffers.out,
      depth: buffers.depth,
      view: camera.view,
      projection: camera.projection,
      background: [14, 16, 26, 255],
      ...(lighting
        ? {
            ambient: lighting.ambient,
            lightDirection: sceneLightingKeyDirection(lighting),
            environment: sceneLightingEnvironment(lighting),
            tonemap: sceneLightingTonemap(lighting),
            lights: lighting.lights,
            shadow,
          }
        : {}),
    });
    const image = context.createImageData(VIEWPORT, VIEWPORT);
    image.data.set(buffers.out);
    context.putImageData(image, 0, 0);

    // Overlay: selection AABB + a translate gizmo at the selected instance origin.
    const selected = instances.find((i) => i.id === selectedId);
    if (selected) drawSelection(context, camera.viewProj, selected, bounds.radius);
  }, [instances, camera, buffers, sidecar.lighting, selectedId, bounds]);

  // --- Pointer interaction: orbit / pick / transform -------------------------
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    state.moved = true;
    state.x = event.clientX;
    state.y = event.clientY;

    const entry = selectedId ? sidecar.meshes.find((m) => m.id === selectedId) : null;
    if (mode === "orbit" || !entry) {
      setYaw((v) => v - dx * ORBIT_SPEED);
      setPitch((v) => Math.max(-1.5, Math.min(1.5, v + dy * ORBIT_SPEED)));
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (mode === "move") {
      // Map the pixel delta to world space along the camera's right/up axes at the
      // scene depth, so the selection tracks the cursor.
      const { right, up } = cameraBasis(camera.eye, camera.target);
      const factor = (camera.distance * Math.tan(FOV / 2) * 2) / rect.height;
      const ndx = dx * factor;
      const ndy = -dy * factor;
      const pos = entry.transform.position;
      onSidecarChange(
        setMeshTransform(sidecar, entry.id, {
          ...entry.transform,
          position: [pos[0] + right[0] * ndx + up[0] * ndy, pos[1] + right[1] * ndx + up[1] * ndy, pos[2] + right[2] * ndx + up[2] * ndy],
        }),
      );
    } else if (mode === "rotate") {
      const r = entry.transform.rotation;
      onSidecarChange(
        setMeshTransform(sidecar, entry.id, { ...entry.transform, rotation: [r[0] + dy * 0.5, r[1] + dx * 0.5, r[2]] }),
      );
    } else if (mode === "scale") {
      const f = Math.exp(-dy * 0.01);
      const s = entry.transform.scale;
      const clamp = (n: number) => Math.max(0.01, Math.min(1000, n * f));
      onSidecarChange(setMeshTransform(sidecar, entry.id, { ...entry.transform, scale: [clamp(s[0]), clamp(s[1]), clamp(s[2])] }));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.moved) return; // a drag, not a click — nothing to select
    // A click: pick the instance under the cursor via a world-space ray.
    const rect = event.currentTarget.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const ray = cameraRay(camera.eye, camera.target, FOV, 1, ndcX, ndcY);
    const boxes = instances
      .map((inst) => {
        const box = worldAabb(inst.mesh, inst.model);
        return box ? { key: inst.id, min: box.min as Vec3, max: box.max as Vec3 } : null;
      })
      .filter((b): b is { key: string; min: Vec3; max: Vec3 } => b !== null);
    onSelectId(pickBoxes(boxes, ray));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((v) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v * (event.deltaY < 0 ? 0.9 : 1.1))));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <section className={styles.mapStage}>
      <div style={{ alignSelf: "center", marginBottom: 8 }}>
        <SegmentedControl
          ariaLabel="Scene tool"
          selected={mode}
          onSelect={setMode}
          options={[
            { id: "orbit", label: "Orbit", hint: "Rotate the camera" },
            { id: "move", label: "Move", hint: "Drag the selected mesh" },
            { id: "rotate", label: "Rotate", hint: "Spin the selected mesh" },
            { id: "scale", label: "Scale", hint: "Resize the selected mesh" },
          ]}
        />
      </div>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          alignSelf: "center",
          maxWidth: "min(512px, 100%)",
          width: "100%",
          height: "auto",
          touchAction: "none",
          cursor: mode === "orbit" ? "grab" : "crosshair",
          background: "#0e101a",
          borderRadius: 8,
        }}
        role="img"
        aria-label="3D scene — click to select, drag to orbit or transform"
      />
      <div className={styles.hud}>
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Instances</span>
          <span className={`${styles.hudValue} data`}>{instances.length}</span>
        </span>
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Selected</span>
          <span className={`${styles.hudValue} data`}>
            {selectedId ? (sidecar.meshes.find((m) => m.id === selectedId)?.name ?? "—") : "none"}
          </span>
        </span>
      </div>
    </section>
  );
}

/** Draw the selected instance's world-AABB wireframe + RGB translate-gizmo axes. */
function drawSelection(
  context: CanvasRenderingContext2D,
  viewProj: Mat4,
  instance: SceneInstance,
  radius: number,
): void {
  const box = worldAabb(instance.mesh, instance.model);
  if (!box) return;

  // AABB edges.
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
  }
  const edges: [number, number][] = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  context.lineWidth = 1.5;
  context.strokeStyle = "#7db8fc";
  context.beginPath();
  for (const [a, b] of edges) {
    const pa = project(viewProj, corners[a]!);
    const pb = project(viewProj, corners[b]!);
    if (!pa || !pb) continue;
    context.moveTo(pa[0], pa[1]);
    context.lineTo(pb[0], pb[1]);
  }
  context.stroke();

  // Translate gizmo: three axis lines from the instance origin.
  const origin: Vec3 = [instance.model[12]!, instance.model[13]!, instance.model[14]!];
  const len = radius * 0.4;
  const axes: [Vec3, string][] = [
    [[origin[0] + len, origin[1], origin[2]], "#ff5a5a"],
    [[origin[0], origin[1] + len, origin[2]], "#5aff7a"],
    [[origin[0], origin[1], origin[2] + len], "#5a9bff"],
  ];
  const po = project(viewProj, origin);
  if (po) {
    context.lineWidth = 2.5;
    for (const [tip, color] of axes) {
      const pt = project(viewProj, tip);
      if (!pt) continue;
      context.strokeStyle = color;
      context.beginPath();
      context.moveTo(po[0], po[1]);
      context.lineTo(pt[0], pt[1]);
      context.stroke();
    }
  }
}
