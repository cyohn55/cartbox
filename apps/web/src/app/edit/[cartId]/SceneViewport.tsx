"use client";

/**
 * The 3D scene viewport (ENGINE_PARITY_ROADMAP.md EP1): every placed mesh drawn
 * together, with the scene's authored lighting, by the same renderer the game
 * uses — WebGPU, then WebGL2, then the software rasteriser — so what the
 * viewport shows is what the cart will show. It fills its panel and resizes
 * with it.
 *
 * The camera is a free one (see viewportCamera.ts): orbit around a pivot, pan,
 * dolly, and fly with the right mouse button held and WASD/QE, the way Unity's
 * Scene view and Unreal's viewport move. F frames the selection, Home frames
 * the whole scene, and there are top, front and side orthographic views. A
 * ground grid sits behind the geometry.
 *
 * Click an instance to select it; with a transform tool, drag to move, rotate
 * or scale it. Selection and transforms flow through the same sidecar the rest
 * of the Mesh tab edits, so the numeric transform controls stay in lockstep.
 * Picking is a world-space ray test against each instance's AABB (see
 * scenePick), needing no read-back or ID pass.
 *
 * The GPU renderers hand back their newest finished frame, a frame or two
 * behind the newest request, so a change is drawn for a few frames in a row
 * until the picture has caught up; with nothing changing, nothing is drawn.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildSceneShadow,
  composeModelMatrix,
  multiplyMat4,
  parentIndices,
  projectionMatrix,
  readTerrain,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  terrainHeight,
  terrainMesh,
  viewMatrix,
  worldAabb,
  worldMatrices,
  type DecodedTexture,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
  type Terrain,
} from "@cartbox/editor";
import { MODELS, createSceneRenderer, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { readMeshEntry, setMeshTransform, type MeshSidecar } from "@/lib/meshSidecar";
import { decodeMeshTextures } from "@/lib/meshImport";
import { type Vec3 } from "@/lib/scenePick";
import {
  GIZMO_PIXELS,
  axisTip,
  dragMove,
  dragRotate,
  dragScale,
  gizmoFrame,
  hitHandle,
  localPositionFor,
  planeSquare,
  ringPoints,
  rotatedTransform,
  type Axis,
  type GizmoFrame,
  type GizmoSpace,
  type Handle,
  type Ray,
  type SnapSteps,
  type Transform,
} from "@/lib/gizmo";
import { dropDistance, raycastMeshes } from "@/lib/meshRaycast";
import {
  VIEWPORT_FOV,
  cameraAxes,
  cameraLookingAt,
  cameraMatrices,
  cameraPivot,
  clipPlanes,
  dolly,
  fly,
  frame,
  gridLines,
  look,
  orbit,
  pan,
  setView,
  unitsPerPixel,
  viewportRay,
  type ViewKind,
  type ViewportCamera,
} from "@/lib/viewportCamera";
import styles from "./editor.module.css";
import { SegmentedControl } from "./railControls";

const ORBIT_SPEED = 0.008; // radians per pixel
const LOOK_SPEED = 0.005;
const DRAG_THRESHOLD = 3; // px before a press counts as a drag rather than a click
const SHADOW_SIZE = 1024;
/** Cells per side the viewport draws a terrain at, at most. */
const TERRAIN_PREVIEW_CELLS = 96;
/** The most pixels a frame has: a GPU renderer draws the panel at full size up to this… */
const MAX_PIXELS_GPU = 1920 * 1080;
/** …and the software rasteriser, on the CPU, at most this many. */
const MAX_PIXELS_SOFTWARE = 640 * 400;
const BACKGROUND = "#0e101a";

/** A terrain built for the viewport: its data, coarse geometry and decoded textures. */
interface PreviewTerrain {
  readonly terrain: Terrain;
  readonly mesh: MeshAsset;
  readonly textures: (DecodedTexture | null)[];
}

type Mode = "orbit" | "move" | "rotate" | "scale";

const MOVE_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const ROTATE_STEPS = [5, 15, 30, 45, 90];
const SCALE_STEPS = [0.05, 0.1, 0.25, 0.5, 1];

/** A camera as a timeline keys it: world eye, look-at target, vertical FOV in degrees. */
export interface ViewpointKey {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly fov: number;
}

interface SceneViewportProps {
  sidecar: MeshSidecar;
  onSidecarChange: (sidecar: MeshSidecar) => void;
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
  /** Preview a timeline: look through this camera instead of the free one… */
  previewCamera?: ViewpointKey | null;
  /** …and place these objects (entry id → transform relative to its parent). */
  previewLocals?: ReadonlyMap<string, Mat4> | null;
  /** Told the free camera's viewpoint whenever it settles (to key it into a timeline). */
  onView?: (view: ViewpointKey) => void;
}

/** A decoded mesh + its base-colour textures, rebuilt only when the geometry set changes. */
interface Decoded {
  readonly id: string;
  readonly mesh: MeshAsset;
  readonly textures: (DecodedTexture | null)[];
}

/** A render instance tagged with its sidecar id, for selection + gizmo overlay. */
type SceneInstance = MeshSceneInstance & { readonly id: string };

/** What the viewport last drew, for its readout. */
interface FrameStats {
  readonly backend: string;
  readonly ms: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly width: number;
  readonly height: number;
}

/** A sphere around a set of instances' world boxes, or null when there are none. */
function sphereAround(list: readonly MeshSceneInstance[]): { center: Vec3; radius: number } | null {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const inst of list) {
    const box = worldAabb(inst.mesh, inst.model);
    if (!box) continue;
    min = [Math.min(min[0], box.min[0]), Math.min(min[1], box.min[1]), Math.min(min[2], box.min[2])];
    max = [Math.max(max[0], box.max[0]), Math.max(max[1], box.max[1]), Math.max(max[2], box.max[2])];
  }
  if (!Number.isFinite(min[0])) return null;
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    radius: Math.max(1e-3, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])),
  };
}

/** Project a world point to canvas pixels, or null when behind the camera. */
function project(viewProj: Mat4, p: Vec3, width: number, height: number): [number, number] | null {
  const cw = viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
  if (cw <= 1e-6) return null;
  const cx = viewProj[0]! * p[0] + viewProj[4]! * p[1] + viewProj[8]! * p[2] + viewProj[12]!;
  const cy = viewProj[1]! * p[0] + viewProj[5]! * p[1] + viewProj[9]! * p[2] + viewProj[13]!;
  return [((cx / cw) * 0.5 + 0.5) * width, (1 - ((cy / cw) * 0.5 + 0.5)) * height];
}

/** The frame size for a panel of `cssW × cssH` CSS pixels, within a pixel budget. */
function frameSize(cssW: number, cssH: number, dpr: number, budget: number): { width: number; height: number } {
  let width = Math.max(16, Math.round(cssW * dpr));
  let height = Math.max(16, Math.round(cssH * dpr));
  const scale = Math.min(1, Math.sqrt(budget / (width * height)));
  width = Math.max(16, Math.floor(width * scale));
  height = Math.max(16, Math.floor(height * scale));
  return { width, height };
}

export function SceneViewport({ sidecar, onSidecarChange, selectedId, onSelectId, previewCamera, previewLocals, onView }: SceneViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("orbit");
  const [viewKind, setViewKind] = useState<ViewKind>("perspective");
  const [decoded, setDecoded] = useState<Decoded[]>([]);
  const [cssSize, setCssSize] = useState<{ w: number; h: number } | null>(null);
  /** The renderer, and the frame size it was built for (a GPU renderer draws only at that size). */
  const [built, setBuilt] = useState<{ renderer: SceneRenderer; width: number; height: number } | null>(null);
  const renderer = built?.renderer ?? null;
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [flySpeed, setFlySpeed] = useState(1);
  /** Gizmo settings: world or local axes, snapping on or off (Ctrl flips it for a drag), and the steps. */
  const [space, setSpace] = useState<GizmoSpace>("world");
  const [snapOn, setSnapOn] = useState(false);
  const [steps, setSteps] = useState<SnapSteps>({ move: 0.5, rotate: 15, scale: 0.1 });
  /** The handle under the cursor (highlighted), and the one being dragged. */
  const hover = useRef<Handle | null>(null);
  const active = useRef<Handle | null>(null);

  // --- Geometry ---------------------------------------------------------------

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

  // Terrains: landscape to compose against, never picked or framed on.
  const [showTerrain, setShowTerrain] = useState(true);
  /** Fog is drawn as the game draws it, but seen from far out it can hide the scene: it can be turned off here. */
  const [showFog, setShowFog] = useState(true);
  const [terrains, setTerrains] = useState<PreviewTerrain[]>([]);
  const terrainSignature = (sidecar.terrains ?? []).map((t) => `${t.id}:${t.samples}:${t.heights.length}:${t.parent ?? ""}`).join("|");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: PreviewTerrain[] = [];
      for (const stored of sidecar.terrains ?? []) {
        const terrain = readTerrain(stored);
        if (!terrain) continue;
        const mesh = terrainMesh(terrain, Math.max(1, Math.ceil((terrain.samples - 1) / TERRAIN_PREVIEW_CELLS)));
        if (mesh.primitives.length === 0) continue;
        next.push({ terrain, mesh, textures: await decodeMeshTextures(mesh) });
      }
      if (!cancelled) setTerrains(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrainSignature]);

  // Every entry's world matrix (a child sits relative to its parent) and its
  // parent's, for placing instances and for turning a drag into a local move.
  const placement = useMemo(() => {
    const parents = parentIndices(sidecar.meshes);
    const world = worldMatrices(
      sidecar.meshes.map(({ id, transform: t }) => previewLocals?.get(id) ?? composeModelMatrix(t.position, t.rotation, t.scale)),
      parents,
    );
    return new Map(sidecar.meshes.map((m, i) => [m.id, { world: world[i]!, parentWorld: parents[i]! >= 0 ? world[parents[i]!]! : null }]));
  }, [sidecar.meshes, previewLocals]);

  const instances = useMemo<SceneInstance[]>(() => {
    const out: SceneInstance[] = [];
    for (const d of decoded) {
      const placed = placement.get(d.id);
      if (placed) out.push({ id: d.id, mesh: d.mesh, textures: d.textures, model: placed.world });
    }
    return out;
  }, [decoded, placement]);

  const terrainInstances = useMemo<MeshSceneInstance[]>(() => {
    if (!showTerrain) return [];
    const identity = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    return terrains.map(({ terrain, mesh, textures }) => ({
      mesh,
      textures,
      model: (terrain.parent ? placement.get(terrain.parent)?.world : undefined) ?? identity,
    }));
  }, [terrains, placement, showTerrain]);

  /** The objects' bounding sphere (framing, shadows) and the whole scene's with terrain (clip planes). */
  const bounds = useMemo(() => sphereAround(instances) ?? { center: [0, 0, 0] as Vec3, radius: 1 }, [instances]);
  const reach = useMemo(() => {
    const all = sphereAround([...instances, ...terrainInstances]);
    return all ?? bounds;
  }, [instances, terrainInstances, bounds]);

  const shadowDepth = useRef<Float32Array | null>(null);
  const shadow = useMemo(() => {
    const lighting = sidecar.lighting;
    if (!lighting?.shadows) return null;
    shadowDepth.current ??= new Float32Array(SHADOW_SIZE * SHADOW_SIZE);
    return buildSceneShadow(instances, lighting, bounds.center, bounds.radius, { size: SHADOW_SIZE, depth: shadowDepth.current });
  }, [instances, sidecar.lighting, bounds]);

  // --- Size and renderer ------------------------------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.width > 0 && box.height > 0) setCssSize({ w: box.width, h: box.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const gpuSize = useMemo(() => (cssSize ? frameSize(cssSize.w, cssSize.h, dpr, MAX_PIXELS_GPU) : null), [cssSize, dpr]);

  // A renderer for the frame size (a GPU one is sized when it's made); rebuilt,
  // after the panel settles, when the size changes.
  // The old renderer keeps drawing until its replacement is ready.
  const rendererRef = useRef<SceneRenderer | null>(null);
  useEffect(() => {
    if (!gpuSize) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void createSceneRenderer(gpuSize.width, gpuSize.height, MODELS.xbox360.renderCaps).then((r) => {
        if (cancelled) return r.dispose();
        const old = rendererRef.current;
        rendererRef.current = r;
        setBuilt({ renderer: r, width: gpuSize.width, height: gpuSize.height });
        old?.dispose();
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [gpuSize]);
  useEffect(
    () => () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    },
    [],
  );

  /**
   * The size frames are drawn at: a GPU renderer's own (the panel's when it was
   * built; until a resize's replacement is ready the canvas just stretches), or a
   * smaller one on the CPU, which can draw at any size.
   */
  const size = useMemo(() => {
    if (!cssSize || !built) return null;
    return built.renderer.backend === "software" ? frameSize(cssSize.w, cssSize.h, dpr, MAX_PIXELS_SOFTWARE) : { width: built.width, height: built.height };
  }, [cssSize, dpr, built]);
  const aspect = size ? size.width / size.height : 1;

  // --- Camera -------------------------------------------------------------------

  const cameraRef = useRef<ViewportCamera | null>(null);
  /** A change waiting to be drawn; and, after drawing, a GPU frame still on its way back. */
  const needsRender = useRef(true);
  const settling = useRef(false);
  const markDirty = useCallback(() => {
    needsRender.current = true;
  }, []);
  /** Told of every camera change: redraws, and tells the parent once the camera settles. */
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setCamera = useCallback(
    (next: ViewportCamera) => {
      cameraRef.current = next;
      markDirty();
      setViewKind(next.view);
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewTimer.current = setTimeout(() => {
        const cam = cameraRef.current;
        if (cam && cam.view === "perspective") onView?.({ eye: cam.position, target: cameraPivot(cam), fov: (VIEWPORT_FOV * 180) / Math.PI });
      }, 150);
    },
    [markDirty, onView],
  );

  // The first time there's something to look at, frame it from above and to one
  // side — tilted up, if need be, until the eye clears any terrain.
  useEffect(() => {
    if (cameraRef.current || decoded.length === 0) return;
    let pitch = 0.4;
    const at = (p: number) => frame(cameraLookingAt(bounds.center, 0.6, p, 1), bounds.center, bounds.radius, aspect);
    const buried = (cam: ViewportCamera) =>
      terrainInstances.some((inst, k) => {
        const t = terrains[k]?.terrain;
        const ground = t ? terrainHeight(t, cam.position[0] - inst.model[12]!, cam.position[2] - inst.model[14]!) : null;
        return ground !== null && ground + inst.model[13]! + 2 > cam.position[1];
      });
    while (pitch < 1.4 && buried(at(pitch))) pitch += 0.05;
    setCamera(at(pitch));
  }, [decoded, bounds, aspect, terrainInstances, terrains, setCamera]);

  const frameSelection = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const selected = instances.find((i) => i.id === selectedId);
    const sphere = (selected && sphereAround([selected])) ?? bounds;
    setCamera(frame(cam, sphere.center, sphere.radius, aspect));
  }, [instances, selectedId, bounds, aspect, setCamera]);
  const frameAll = useCallback(() => {
    const cam = cameraRef.current;
    if (cam) setCamera(frame(cam, bounds.center, bounds.radius, aspect));
  }, [bounds, aspect, setCamera]);
  const chooseView = useCallback(
    (view: ViewKind) => {
      const cam = cameraRef.current;
      if (!cam) return;
      const selected = sphereAround(instances.filter((i) => i.id === selectedId));
      setCamera(setView(cam, view, selected ? selected.center : cameraPivot(cam)));
    },
    [instances, selectedId, setCamera],
  );

  // Anything drawn changing redraws.
  useEffect(markDirty, [markDirty, instances, terrainInstances, shadow, sidecar.lighting, showFog, selectedId, previewCamera, size, renderer, mode, space]);

  // --- Drawing ------------------------------------------------------------------

  const buffers = useMemo(() => (size ? { out: new Uint8ClampedArray(size.width * size.height * 4), depth: new Float32Array(size.width * size.height) } : null), [size]);
  const sceneCanvas = useMemo(() => (typeof document === "undefined" ? null : document.createElement("canvas")), []);

  // Everything the frame loop reads, refreshed every render.
  const live = useRef({ instances, terrainInstances, shadow, lighting: sidecar.lighting, showFog, selectedId, previewCamera, reach, renderer, size, buffers, mode, space, cssSize });
  live.current = { instances, terrainInstances, shadow, lighting: sidecar.lighting, showFog, selectedId, previewCamera, reach, renderer, size, buffers, mode, space, cssSize };

  const keys = useRef(new Set<string>());
  const flying = useRef(false);
  const flyState = useRef({ speed: flySpeed, radius: bounds.radius });
  flyState.current = { speed: flySpeed, radius: bounds.radius };

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let smoothedMs = 0;
    let lastStats = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // Fly: WASD along the view, Q/E down and up, Shift faster.
      const cam0 = cameraRef.current;
      if (flying.current && cam0 && keys.current.size > 0) {
        const k = keys.current;
        const speed = Math.max(0.5, flyState.current.radius) * flyState.current.speed * (k.has("shift") ? 3 : 1) * dt;
        const forward = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
        const right = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
        const up = (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0);
        if (forward || right || up) setCamera(fly(cam0, { forward: forward * speed, right: right * speed, up: up * speed }));
      }
      if (!needsRender.current && !settling.current) return;
      const { instances: objects, terrainInstances: land, shadow: shadowMap, lighting, showFog: fogOn, selectedId: sel, previewCamera: preview, reach: sphere, renderer: r, size: s, buffers: b, mode: tool, space: axesSpace, cssSize: css } = live.current;
      const canvas = canvasRef.current;
      const cam = cameraRef.current;
      if (!canvas || !cam || !r || !s || !b || !sceneCanvas) return;

      const aspectNow = s.width / s.height;
      let view: Mat4;
      let projection: Mat4;
      let viewProj: Mat4;
      if (preview) {
        // Looking through a timeline's camera.
        const d = Math.hypot(preview.eye[0] - sphere.center[0], preview.eye[1] - sphere.center[1], preview.eye[2] - sphere.center[2]);
        view = viewMatrix(preview.eye, preview.target);
        projection = projectionMatrix((preview.fov * Math.PI) / 180, aspectNow, 0.05, Math.max(10, d + sphere.radius * 2));
        viewProj = multiplyMat4(projection, view);
      } else {
        const planes = clipPlanes(cam, sphere.center, sphere.radius);
        ({ view, projection, viewProj } = cameraMatrices(cam, aspectNow, planes.near, planes.far));
      }

      const draw: SceneDraw = {
        width: s.width,
        height: s.height,
        out: b.out,
        depth: b.depth,
        view,
        projection,
        background: [0, 0, 0, 0],
        cull: true,
        ...(lighting
          ? {
              ambient: lighting.ambient,
              lightDirection: sceneLightingKeyDirection(lighting),
              environment: sceneLightingEnvironment(lighting),
              tonemap: sceneLightingTonemap(lighting),
              lights: lighting.lights,
              shadow: shadowMap,
              fog: fogOn ? (lighting.fog ?? null) : null,
            }
          : {}),
      };
      // A change renders once. After that a GPU renderer is only asked to show
      // its newest finished frame, until the one for this picture has landed
      // (rendering again only if that frame never got a readback).
      const fresh = needsRender.current;
      needsRender.current = false;
      const state = !fresh && r.settle ? r.settle(draw) : null;
      if (fresh || state === "stale") {
        const started = performance.now();
        r.render(land.length > 0 ? [...objects, ...land] : objects, draw);
        const ms = performance.now() - started;
        smoothedMs = smoothedMs === 0 ? ms : smoothedMs * 0.8 + ms * 0.2;
      }
      settling.current = !!r.settle && state !== "current";

      // Composite: the background, the grid, then the scene over both (where
      // nothing was drawn the frame is transparent, so geometry hides the grid).
      if (canvas.width !== s.width || canvas.height !== s.height) {
        canvas.width = s.width;
        canvas.height = s.height;
      }
      if (sceneCanvas.width !== s.width || sceneCanvas.height !== s.height) {
        sceneCanvas.width = s.width;
        sceneCanvas.height = s.height;
      }
      const sceneContext = sceneCanvas.getContext("2d");
      const context = canvas.getContext("2d");
      if (!sceneContext || !context) return;
      sceneContext.putImageData(new ImageData(b.out, s.width, s.height), 0, 0);
      context.fillStyle = BACKGROUND;
      context.fillRect(0, 0, s.width, s.height);
      if (!preview) drawGrid(context, cam, viewProj, s.width, s.height);
      context.drawImage(sceneCanvas, 0, 0);
      const selected = objects.find((i) => i.id === sel);
      if (selected) {
        drawSelection(context, viewProj, selected, s.width, s.height);
        if (!preview && tool !== "orbit" && css) {
          const frameNow = gizmoAt(cam, selected.model, tool, axesSpace, css.h);
          drawGizmo(context, tool, frameNow, (p) => project(viewProj, p, s.width, s.height), hover.current, active.current, s.width / css.w);
        }
      }

      if (now - lastStats > 400) {
        lastStats = now;
        const st = r.lastFrameStats;
        setStats({ backend: r.backend, ms: smoothedMs, drawCalls: st?.drawCalls ?? 0, triangles: st?.triangles ?? 0, width: s.width, height: s.height });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sceneCanvas, setCamera]);

  // --- Pointer and keys ---------------------------------------------------------

  type DragKind = "tool" | "orbit" | "pan" | "look" | "gizmo";
  interface GizmoDrag {
    readonly handle: Handle;
    readonly frame: GizmoFrame;
    readonly ray0: Ray;
    readonly cursor0: readonly [number, number];
    readonly origin: readonly [number, number];
    readonly start: Transform;
    readonly startWorld: Vec3;
    readonly parentWorld: Mat4 | null;
  }
  const drag = useRef<{ kind: DragKind; x: number; y: number; moved: boolean; gizmo?: GizmoDrag } | null>(null);

  /** A pointer event's place: in canvas pixels, and as normalised device coordinates. */
  const pointerAt = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    const cx = ((event.clientX - rect.left) / rect.width) * el.width;
    const cy = ((event.clientY - rect.top) / rect.height) * el.height;
    const ndc: [number, number] = [((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)];
    return { canvas: [cx, cy] as [number, number], ndc, rect };
  };

  /** The selected entry, its world matrix and its parent's. */
  const selection = () => {
    const entry = selectedId ? sidecar.meshes.find((m) => m.id === selectedId) : null;
    const placed = entry ? placement.get(entry.id) : undefined;
    return entry && placed ? { entry, world: placed.world, parentWorld: placed.parentWorld } : null;
  };

  /** The gizmo handle under a pointer, or null (no gizmo: the view tool, a timeline camera, nothing selected). */
  const handleUnder = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement): { handle: Handle; frame: GizmoFrame; origin: [number, number] } | null => {
    const cam = cameraRef.current;
    const sel = selection();
    if (!cam || !sel || mode === "orbit" || previewCamera || !size) return null;
    const { canvas, rect } = pointerAt(event, el);
    const frameNow = gizmoAt(cam, sel.world, mode, space, rect.height);
    const planes = clipPlanes(cam, reach.center, reach.radius);
    const { viewProj } = cameraMatrices(cam, size.width / size.height, planes.near, planes.far);
    const projector = (p: Vec3) => project(viewProj, p, el.width, el.height);
    const handle = hitHandle(mode, frameNow, projector, canvas, 8 * (el.width / rect.width));
    const origin = projector(frameNow.origin);
    return handle && origin ? { handle, frame: frameNow, origin } : null;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const cam = cameraRef.current;
    if (event.button === 0 && !event.altKey && !event.shiftKey && cam) {
      const grabbed = handleUnder(event, event.currentTarget);
      const sel = selection();
      if (grabbed && sel) {
        const { canvas, ndc } = pointerAt(event, event.currentTarget);
        const t = sel.entry.transform;
        active.current = grabbed.handle;
        markDirty();
        drag.current = {
          kind: "gizmo",
          x: event.clientX,
          y: event.clientY,
          moved: false,
          gizmo: {
            handle: grabbed.handle,
            frame: grabbed.frame,
            ray0: viewportRay(cam, aspect, ndc[0], ndc[1]),
            cursor0: canvas,
            origin: grabbed.origin,
            start: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] },
            startWorld: [sel.world[12]!, sel.world[13]!, sel.world[14]!],
            parentWorld: sel.parentWorld,
          },
        };
        return;
      }
    }
    const kind: DragKind = event.button === 2 ? "look" : event.button === 1 || (event.button === 0 && event.shiftKey) ? "pan" : event.button === 0 && event.altKey ? "orbit" : "tool";
    if (kind === "look") flying.current = true;
    drag.current = { kind, x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    const cam = cameraRef.current;
    if (!state) {
      // Hovering: light up the handle under the cursor.
      const under = handleUnder(event, event.currentTarget)?.handle ?? null;
      if (JSON.stringify(under) !== JSON.stringify(hover.current)) {
        hover.current = under;
        markDirty();
      }
      return;
    }
    if (!cam) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    state.moved = true;
    const rect = event.currentTarget.getBoundingClientRect();

    if (state.kind === "gizmo" && state.gizmo) {
      // Measured from where the drag started, so snapping is exact and nothing drifts.
      const g = state.gizmo;
      const sel = selection();
      if (!sel) return;
      const { canvas, ndc } = pointerAt(event, event.currentTarget);
      const ray = viewportRay(cam, aspect, ndc[0], ndc[1]);
      const snap = snapOn !== (event.ctrlKey || event.metaKey) ? steps : null;
      let next: Transform = g.start;
      if (mode === "move") {
        const world = dragMove(g.handle, g.frame, g.startWorld, g.ray0, ray, cameraAxes(cam).forward, snap, space);
        next = { ...g.start, position: localPositionFor(world, g.parentWorld) };
      } else if (mode === "rotate" && g.handle.kind === "ring") {
        const angle = dragRotate(g.handle, g.frame, g.ray0, ray, snap, canvas[0] - g.cursor0[0]);
        next = rotatedTransform(g.start, g.parentWorld, g.frame.axes[g.handle.axis], angle);
      } else if (mode === "scale") {
        next = { ...g.start, scale: dragScale(g.handle, g.frame, g.start.scale, g.ray0, ray, { origin: g.origin, cursor0: g.cursor0, cursor: canvas }, snap) };
      }
      onSidecarChange(setMeshTransform(sidecar, sel.entry.id, { position: [...next.position], rotation: [...next.rotation], scale: [...next.scale] }));
      return;
    }
    state.x = event.clientX;
    state.y = event.clientY;
    if (state.kind === "look") return setCamera(look(cam, -dx * LOOK_SPEED, dy * LOOK_SPEED));
    if (state.kind === "pan") {
      const k = unitsPerPixel(cam, cam.distance, rect.height);
      return setCamera(pan(cam, -dx * k, dy * k));
    }
    // Dragging off the gizmo (or with the view tool) orbits.
    setCamera(orbit(cam, -dx * ORBIT_SPEED, dy * ORBIT_SPEED));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (active.current) {
      active.current = null;
      markDirty();
    }
    if (state?.kind === "look") {
      flying.current = false;
      keys.current.clear();
    }
    const cam = cameraRef.current;
    if (!state || state.moved || state.kind !== "tool" || !cam) return;
    // A click: pick the mesh whose triangles are under the cursor.
    const { ndc } = pointerAt(event, event.currentTarget);
    const ray = viewportRay(cam, aspect, ndc[0], ndc[1]);
    onSelectId(raycastMeshes(ray, instances.map((i) => ({ key: i.id, mesh: i.mesh, model: i.model })))?.key ?? null);
  };

  /** Drop the selection onto whatever is beneath it (other meshes, the terrain, or the ground). */
  const dropToSurface = useCallback(() => {
    const entry = selectedId ? sidecar.meshes.find((m) => m.id === selectedId) : null;
    const target = instances.find((i) => i.id === selectedId);
    const box = target ? worldAabb(target.mesh, target.model) : null;
    if (!entry || !box) return;
    // Everything placed under the selection moves with it, so none of it is a surface to land on.
    const parents = parentIndices(sidecar.meshes);
    const index = sidecar.meshes.findIndex((m) => m.id === entry.id);
    const ignore = new Set(sidecar.meshes.filter((_, i) => { for (let k = i; k >= 0; k = parents[k]!) if (k === index) return true; return false; }).map((m) => m.id));
    const ground = terrains.length > 0 && showTerrain
      ? (x: number, z: number) => {
          let best: number | null = null;
          terrainInstances.forEach((inst, k) => {
            const t = terrains[k]?.terrain;
            const h = t ? terrainHeight(t, x - inst.model[12]!, z - inst.model[14]!) : null;
            if (h !== null && (best === null || h + inst.model[13]! > best)) best = h + inst.model[13]!;
          });
          return best;
        }
      : undefined;
    const dy = dropDistance({ min: box.min as Vec3, max: box.max as Vec3 }, [...instances.map((i) => ({ key: i.id, mesh: i.mesh, model: i.model })), ...terrainInstances.map((t, k) => ({ key: `terrain:${k}`, mesh: t.mesh, model: t.model }))], ignore, ground);
    if (dy === null || Math.abs(dy) < 1e-6) return;
    const world: Vec3 = [target!.model[12]!, target!.model[13]! + dy, target!.model[14]!];
    onSidecarChange(setMeshTransform(sidecar, entry.id, { ...entry.transform, position: localPositionFor(world, placement.get(entry.id)?.parentWorld ?? null) }));
  }, [selectedId, sidecar, instances, terrains, terrainInstances, showTerrain, placement, onSidecarChange]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const key = event.key.toLowerCase();
    if (flying.current && ["w", "a", "s", "d", "q", "e", "shift"].includes(key)) {
      keys.current.add(key);
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tools: Record<string, Mode> = { q: "orbit", w: "move", e: "rotate", r: "scale" };
    if (tools[key]) setMode(tools[key]!);
    else if (key === "x") setSpace((v) => (v === "world" ? "local" : "world"));
    else if (key === "f") frameSelection();
    else if (key === "home") frameAll();
    else if (key === "end") dropToSurface();
    else return;
    event.preventDefault();
  };
  const onKeyUp = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    keys.current.delete(event.key.toLowerCase());
  };

  // The wheel dollies (zooms an orthographic view); with the right button held
  // it sets how fast flying goes, as in Unity.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (flying.current) {
        setFlySpeed((v) => Math.max(0.05, Math.min(20, v * (event.deltaY < 0 ? 1.25 : 0.8))));
        return;
      }
      const cam = cameraRef.current;
      if (cam) setCamera(dolly(cam, event.deltaY < 0 ? 0.88 : 1 / 0.88));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [setCamera]);

  return (
    <section className={styles.mapStage}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "center" }}>
        <SegmentedControl
          ariaLabel="Scene tool"
          selected={mode}
          onSelect={setMode}
          options={[
            { id: "orbit", label: "View", hint: "Drag to orbit the camera (Q)" },
            { id: "move", label: "Move", hint: "Move gizmo (W)" },
            { id: "rotate", label: "Rotate", hint: "Rotate gizmo (E)" },
            { id: "scale", label: "Scale", hint: "Scale gizmo (R)" },
          ]}
        />
        <button
          type="button"
          className={styles.toolBtn}
          aria-pressed={space === "local"}
          onClick={() => setSpace((v) => (v === "world" ? "local" : "world"))}
          title="Gizmo axes: the world's or the object's own (X). Scaling is always along the object's own."
        >
          {space === "world" ? "World" : "Local"}
        </button>
        <button type="button" className={styles.toolBtn} aria-pressed={snapOn} onClick={() => setSnapOn((v) => !v)} title="Snap while dragging (hold Ctrl to flip it for one drag)">
          Snap
        </button>
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }} title="Move snap step">
          <select aria-label="Move snap step" value={steps.move} onChange={(e) => setSteps({ ...steps, move: Number(e.target.value) })}>
            {MOVE_STEPS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select aria-label="Rotate snap step" value={steps.rotate} onChange={(e) => setSteps({ ...steps, rotate: Number(e.target.value) })}>
            {ROTATE_STEPS.map((v) => (
              <option key={v} value={v}>
                {v}°
              </option>
            ))}
          </select>
          <select aria-label="Scale snap step" value={steps.scale} onChange={(e) => setSteps({ ...steps, scale: Number(e.target.value) })}>
            {SCALE_STEPS.map((v) => (
              <option key={v} value={v}>
                ×{v}
              </option>
            ))}
          </select>
        </label>
        <SegmentedControl
          ariaLabel="Scene view"
          selected={viewKind}
          onSelect={chooseView}
          options={[
            { id: "perspective", label: "Persp", hint: "Perspective camera" },
            { id: "top", label: "Top", hint: "Orthographic, looking down" },
            { id: "front", label: "Front", hint: "Orthographic, looking along −Z" },
            { id: "side", label: "Side", hint: "Orthographic, looking along −X" },
          ]}
        />
        <button type="button" className={styles.toolBtn} onClick={frameSelection} title="Frame the selection (F)">
          Frame
        </button>
        <button type="button" className={styles.toolBtn} onClick={frameAll} title="Frame the whole scene (Home)">
          All
        </button>
        <button type="button" className={styles.toolBtn} onClick={dropToSurface} disabled={!selectedId} title="Drop the selection onto the surface beneath it (End)">
          Drop
        </button>
      </div>
      <div ref={containerRef} style={{ position: "relative", flex: "1 1 auto", minHeight: 420, borderRadius: 8, overflow: "hidden", background: BACKGROUND }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => keys.current.clear()}
          onContextMenu={(event) => event.preventDefault()}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: mode === "orbit" ? "grab" : "crosshair", outline: "none" }}
          role="img"
          aria-label="3D scene — click to select; drag to orbit or transform; right-drag with WASD to fly; middle- or Shift-drag to pan; wheel to dolly; F frames the selection"
        />
      </div>
      <div className={styles.hud}>
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Instances</span>
          <span className={`${styles.hudValue} data`}>{instances.length}</span>
        </span>
        {terrains.length > 0 && (
          <label className={styles.hudItem} style={{ cursor: "pointer" }}>
            <input type="checkbox" aria-label="Show terrain" checked={showTerrain} onChange={(event) => setShowTerrain(event.target.checked)} />
            <span className={styles.hudLabel}>Terrain</span>
          </label>
        )}
        {sidecar.lighting?.fog && (
          <label className={styles.hudItem} style={{ cursor: "pointer" }}>
            <input type="checkbox" aria-label="Show fog" checked={showFog} onChange={(event) => setShowFog(event.target.checked)} />
            <span className={styles.hudLabel}>Fog</span>
          </label>
        )}
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Selected</span>
          <span className={`${styles.hudValue} data`}>{selectedId ? (sidecar.meshes.find((m) => m.id === selectedId)?.name ?? "—") : "none"}</span>
        </span>
        {stats && (
          <span className={styles.hudItem} aria-label="Viewport stats">
            <span className={styles.hudLabel}>{stats.backend === "webgpu" ? "WebGPU" : stats.backend === "webgl2" ? "WebGL2" : "Software"}</span>
            <span className={`${styles.hudValue} data`}>
              {stats.width}×{stats.height} · {stats.ms.toFixed(1)} ms · {stats.drawCalls} draws · {Math.round(stats.triangles).toLocaleString()} tris
            </span>
          </span>
        )}
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Fly speed</span>
          <span className={`${styles.hudValue} data`}>×{flySpeed.toFixed(2)}</span>
        </span>
      </div>
    </section>
  );
}

/** The gizmo for a selected object's world matrix, sized to stay the same on screen in a viewport `cssHeight` CSS pixels tall. */
function gizmoAt(camera: ViewportCamera, world: Mat4, tool: Exclude<Mode, "orbit">, space: GizmoSpace, cssHeight: number): GizmoFrame {
  const { forward } = cameraAxes(camera);
  const depth = (world[12]! - camera.position[0]) * forward[0] + (world[13]! - camera.position[1]) * forward[1] + (world[14]! - camera.position[2]) * forward[2];
  return gizmoFrame(world, tool, space, unitsPerPixel(camera, depth, cssHeight) * GIZMO_PIXELS);
}

const AXIS_COLOURS = ["#ff5a5a", "#5aff7a", "#5a9bff"];
const HOVER_COLOUR = "#ffd84a";

/** Draw the gizmo: arrows, plane squares and a centre dot (move), rings (rotate), or box-tipped arms and a centre box (scale). */
function drawGizmo(
  context: CanvasRenderingContext2D,
  tool: Exclude<Mode, "orbit">,
  frame: GizmoFrame,
  projector: (p: Vec3) => [number, number] | null,
  hover: Handle | null,
  active: Handle | null,
  pixel: number,
): void {
  const o = projector(frame.origin);
  if (!o) return;
  (globalThis as unknown as { gizmoDebug?: unknown[] }).gizmoDebug = [tool, frame.size, o, planeSquare(frame, 2).map(projector), projector(axisTip(frame, 0)), pixel];
  const same = (a: Handle | null, b: Handle) => !!a && a.kind === b.kind && (a.kind === "center" || (a as { axis: Axis }).axis === (b as { axis: Axis }).axis);
  const colourOf = (h: Handle, axis: number) => (same(active, h) || (!active && same(hover, h)) ? HOVER_COLOUR : AXIS_COLOURS[axis]!);
  context.save();
  context.lineCap = "round";
  if (tool === "rotate") {
    for (const axis of [0, 1, 2] as Axis[]) {
      const h: Handle = { kind: "ring", axis };
      context.strokeStyle = colourOf(h, axis);
      context.lineWidth = (same(active, h) || same(hover, h) ? 3.5 : 2.2) * pixel;
      context.beginPath();
      let pen = false;
      for (const p of ringPoints(frame, axis)) {
        const q = projector(p);
        if (!q) {
          pen = false;
          continue;
        }
        if (pen) context.lineTo(q[0], q[1]);
        else context.moveTo(q[0], q[1]);
        pen = true;
      }
      context.stroke();
    }
    context.restore();
    return;
  }
  if (tool === "move") {
    for (const axis of [0, 1, 2] as Axis[]) {
      const h: Handle = { kind: "plane", axis };
      const quad = planeSquare(frame, axis).map(projector);
      if (!quad.every((q) => q)) continue;
      context.fillStyle = same(active, h) || (!active && same(hover, h)) ? "rgba(255, 216, 74, 0.55)" : `${AXIS_COLOURS[axis]}55`;
      context.beginPath();
      quad.forEach((q, i) => (i === 0 ? context.moveTo(q![0], q![1]) : context.lineTo(q![0], q![1])));
      context.closePath();
      context.fill();
    }
  }
  for (const axis of [0, 1, 2] as Axis[]) {
    const h: Handle = { kind: "axis", axis };
    const tip = projector(axisTip(frame, axis));
    if (!tip) continue;
    const colour = colourOf(h, axis);
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineWidth = (same(active, h) || same(hover, h) ? 3.5 : 2.5) * pixel;
    context.beginPath();
    context.moveTo(o[0], o[1]);
    context.lineTo(tip[0], tip[1]);
    context.stroke();
    const dx = tip[0] - o[0];
    const dy = tip[1] - o[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = 11 * pixel;
    if (tool === "move") {
      context.beginPath();
      context.moveTo(tip[0] + ux * head, tip[1] + uy * head);
      context.lineTo(tip[0] - uy * head * 0.45, tip[1] + ux * head * 0.45);
      context.lineTo(tip[0] + uy * head * 0.45, tip[1] - ux * head * 0.45);
      context.closePath();
      context.fill();
    } else {
      context.fillRect(tip[0] - head * 0.45, tip[1] - head * 0.45, head * 0.9, head * 0.9);
    }
  }
  const centre: Handle = { kind: "center" };
  context.fillStyle = same(active, centre) || (!active && same(hover, centre)) ? HOVER_COLOUR : "#e8ecf8";
  const r = 5.5 * pixel;
  // A dark edge keeps the light centre visible over bright surfaces.
  context.strokeStyle = "rgba(10, 14, 26, 0.75)";
  context.lineWidth = 1.5 * pixel;
  context.beginPath();
  if (tool === "scale") context.rect(o[0] - r, o[1] - r, r * 2, r * 2);
  else context.arc(o[0], o[1], r, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

/** The ground grid (behind the scene): minor lines faint, every tenth brighter, the world axes coloured. */
function drawGrid(context: CanvasRenderingContext2D, camera: ViewportCamera, viewProj: Mat4, width: number, height: number): void {
  const { lines } = gridLines(camera);
  context.lineWidth = 1;
  for (const pass of ["minor", "major"] as const) {
    context.strokeStyle = pass === "major" ? "rgba(150, 170, 220, 0.32)" : "rgba(150, 170, 220, 0.13)";
    context.beginPath();
    for (const line of lines) {
      if ((pass === "major") !== line.major) continue;
      const a = project(viewProj, line.a, width, height);
      const b = project(viewProj, line.b, width, height);
      if (!a || !b) continue;
      context.moveTo(a[0], a[1]);
      context.lineTo(b[0], b[1]);
    }
    context.stroke();
  }
  // The world axes through the origin: X red, Z blue (Y green in front and side views).
  const span = Math.max(camera.distance, camera.orthoSize) * 50;
  const axes: [Vec3, Vec3, string][] =
    camera.view === "front"
      ? [[[-span, 0, 0], [span, 0, 0], "rgba(255, 90, 90, 0.7)"], [[0, -span, 0], [0, span, 0], "rgba(90, 255, 122, 0.7)"]]
      : camera.view === "side"
        ? [[[0, 0, -span], [0, 0, span], "rgba(90, 155, 255, 0.7)"], [[0, -span, 0], [0, span, 0], "rgba(90, 255, 122, 0.7)"]]
        : [[[-span, 0, 0], [span, 0, 0], "rgba(255, 90, 90, 0.7)"], [[0, 0, -span], [0, 0, span], "rgba(90, 155, 255, 0.7)"]];
  for (const [from, to, colour] of axes) {
    const a = clipToFront(viewProj, from, to, width, height);
    if (!a) continue;
    context.strokeStyle = colour;
    context.beginPath();
    context.moveTo(a[0][0], a[0][1]);
    context.lineTo(a[1][0], a[1][1]);
    context.stroke();
  }
}

/** A world segment's projected ends, trimmed to the part in front of the camera (null if none is). */
function clipToFront(viewProj: Mat4, a: Vec3, b: Vec3, width: number, height: number): [[number, number], [number, number]] | null {
  const w = (p: Vec3) => viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
  const near = 1e-3;
  let p = a;
  let q = b;
  const wp = w(p);
  const wq = w(q);
  if (wp < near && wq < near) return null;
  const lerp = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  if (wp < near) p = lerp((near - wp) / (wq - wp));
  if (wq < near) q = lerp((near - wp) / (wq - wp));
  const pp = project(viewProj, p, width, height);
  const pq = project(viewProj, q, width, height);
  return pp && pq ? [pp, pq] : null;
}

/** Draw the selected instance's world-AABB wireframe. */
function drawSelection(context: CanvasRenderingContext2D, viewProj: Mat4, instance: SceneInstance, width: number, height: number): void {
  const box = worldAabb(instance.mesh, instance.model);
  if (!box) return;
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
  const edges: [number, number][] = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  context.lineWidth = 1.5;
  context.strokeStyle = "#7db8fc";
  context.beginPath();
  for (const [a, b] of edges) {
    const pa = project(viewProj, corners[a]!, width, height);
    const pb = project(viewProj, corners[b]!, width, height);
    if (!pa || !pb) continue;
    context.moveTo(pa[0], pa[1]);
    context.lineTo(pb[0], pb[1]);
  }
  context.stroke();
}
