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
  LOCAL_SHADOW_BIAS,
  LOCAL_SHADOW_SLOPE_BIAS,
  assignLocalShadowTiles,
  renderLocalShadow,
  composeModelMatrix,
  multiplyMat4,
  parentIndices,
  projectionMatrix,
  readTerrain,
  readFoliage,
  foliageBlocks,
  deserializeMeshAsset,
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
  type LodChain,
  decodeLods,
  type Terrain,
} from "@cartbox/editor";
import { MODELS, createSceneRenderer, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { readMeshEntry, setMeshTransform, type MeshSidecar } from "@/lib/meshSidecar";
import { brushRing, terrainRayHit } from "@/lib/terrainEdit";
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
  rotateAbout,
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
import { boxSelect, clickSelection, selectionRoots, withSubtrees } from "@/lib/sceneSelection";
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
import { ASSET_DRAG_TYPE } from "./ContentBrowser";
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
  /** The selection, the last one the primary (its gizmo moves them all). */
  selectedIds: readonly string[];
  onSelectIds: (ids: string[]) => void;
  /** Objects not drawn or picked here, and objects that can't be picked or moved here. */
  hidden?: ReadonlySet<string>;
  locked?: ReadonlySet<string>;
  /** The scene shortcuts (duplicate, delete, hide…): true when it handled the key. */
  onKey?: (event: React.KeyboardEvent) => boolean;
  /** Preview a timeline: look through this camera instead of the free one… */
  previewCamera?: ViewpointKey | null;
  /** …and place these objects (entry id → transform relative to its parent). */
  previewLocals?: ReadonlyMap<string, Mat4> | null;
  /** Told the free camera's viewpoint whenever it settles (to key it into a timeline). */
  onView?: (view: ViewpointKey) => void;
  /** An asset dragged in from the content browser, and where it landed in the world. */
  onDropAsset?: (data: string, at: Vec3) => void;
  /**
   * A terrain tool is up (EP10): the left button brushes terrain `id` instead
   * of selecting, with the brush's rim drawn on the ground under the cursor.
   */
  terrainBrush?: { readonly id: string; readonly radius: number } | null;
  /** Each point a brush stroke passes over, in the terrain's own space; `start` on the stroke's first. */
  onTerrainStroke?: (id: string, x: number, z: number, start: boolean) => void;
}

/** A decoded mesh + its base-colour textures, rebuilt only when the geometry set changes. */
interface Decoded {
  readonly id: string;
  readonly mesh: MeshAsset;
  readonly textures: (DecodedTexture | null)[];
  /** Its LOD chain (EP9b), base mesh first, or null. */
  readonly lod: LodChain | null;
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

const NO_IDS: ReadonlySet<string> = new Set();

export function SceneViewport({ sidecar, onSidecarChange, selectedIds, onSelectIds, hidden = NO_IDS, locked = NO_IDS, onKey, previewCamera, previewLocals, onView, onDropAsset, terrainBrush = null, onTerrainStroke }: SceneViewportProps) {
  const selectedId = selectedIds.at(-1) ?? null;
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
  const geometrySignature = sidecar.meshes.map((m) => `${m.id}:${m.mesh.length}:${m.lods?.levels.map((l) => l.length).join(".") ?? ""}`).join("|");
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
        const chain = entry.lods ? decodeLods(mesh, entry.lods) : null;
        next.push({ id: entry.id, mesh, textures, lod: chain ? { meshes: [mesh, ...chain.meshes], distances: chain.distances } : null });
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
  // Everything about the terrains (a brush stroke changes their heights, paint and holes).
  const terrainSignature = useMemo(() => JSON.stringify([sidecar.terrains ?? [], sidecar.foliage ?? []]), [sidecar.terrains, sidecar.foliage]);
  /** Foliage (EP11): each layer's merged blocks, drawn with the terrain they grow on. */
  const [foliage, setFoliage] = useState<{ readonly terrainId: string; readonly mesh: MeshAsset; readonly textures: (DecodedTexture | null)[] }[]>([]);
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
      const plants: { terrainId: string; mesh: MeshAsset; textures: (DecodedTexture | null)[] }[] = [];
      for (const stored of sidecar.foliage ?? []) {
        const terrain = next.find((p) => p.terrain.id === stored.terrain)?.terrain;
        const read = terrain ? readFoliage(stored, [terrain]) : null;
        if (!terrain || !read) continue;
        let mesh: MeshAsset;
        try {
          mesh = deserializeMeshAsset(read.mesh);
        } catch {
          continue;
        }
        const textures = await decodeMeshTextures(mesh);
        for (const block of foliageBlocks(terrain, read.layer, mesh)) plants.push({ terrainId: terrain.id, mesh: block.mesh, textures });
      }
      if (!cancelled) {
        setTerrains(next);
        setFoliage(plants);
      }
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
      if (placed && !hidden.has(d.id)) out.push({ id: d.id, mesh: d.mesh, textures: d.textures, model: placed.world, ...(d.lod ? { lod: d.lod } : {}) });
    }
    return out;
  }, [decoded, placement, hidden]);

  const terrainInstances = useMemo<MeshSceneInstance[]>(() => {
    if (!showTerrain) return [];
    const identity = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    const modelOf = (terrain: Terrain) => (terrain.parent ? placement.get(terrain.parent)?.world : undefined) ?? identity;
    // The terrains first (index k matches `terrains[k]`), then the foliage on them.
    return [
      ...terrains.map(({ terrain, mesh, textures }) => ({ mesh, textures, model: modelOf(terrain) })),
      ...foliage.flatMap(({ terrainId, mesh, textures }) => {
        const terrain = terrains.find((t) => t.terrain.id === terrainId)?.terrain;
        return terrain ? [{ mesh, textures, model: modelOf(terrain) }] : [];
      }),
    ];
  }, [terrains, foliage, placement, showTerrain]);

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
  // Spot and point lights that cast (EP8c): their tiles, and the lights with their tiles assigned.
  const local = useMemo(() => {
    const lighting = sidecar.lighting;
    if (!lighting?.shadows) return null;
    const { lights, tiles } = assignLocalShadowTiles(lighting.lights);
    if (tiles === 0) return null;
    const rendered = lights.flatMap((l) => (l.shadowTile !== undefined ? renderLocalShadow(l, instances) : []));
    return { lights, shadows: { tiles: rendered, bias: LOCAL_SHADOW_BIAS, slopeBias: LOCAL_SHADOW_SLOPE_BIAS } };
  }, [instances, sidecar.lighting]);

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
    if (cameraRef.current || (decoded.length === 0 && terrains.length === 0)) return;
    let pitch = 0.4;
    // No objects yet (a new terrain alone): frame the terrain.
    const sphere = decoded.length > 0 ? bounds : reach;
    const at = (p: number) => frame(cameraLookingAt(sphere.center, 0.6, p, 1), sphere.center, sphere.radius, aspect);
    const buried = (cam: ViewportCamera) =>
      terrainInstances.some((inst, k) => {
        const t = terrains[k]?.terrain;
        const ground = t ? terrainHeight(t, cam.position[0] - inst.model[12]!, cam.position[2] - inst.model[14]!) : null;
        return ground !== null && ground + inst.model[13]! + 2 > cam.position[1];
      });
    while (pitch < 1.4 && buried(at(pitch))) pitch += 0.05;
    setCamera(at(pitch));
  }, [decoded, bounds, reach, aspect, terrainInstances, terrains, setCamera]);

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
  useEffect(markDirty, [markDirty, instances, terrainInstances, shadow, sidecar.lighting, showFog, selectedIds, locked, previewCamera, size, renderer, mode, space, terrainBrush]);

  // --- Drawing ------------------------------------------------------------------

  const buffers = useMemo(() => (size ? { out: new Uint8ClampedArray(size.width * size.height * 4), depth: new Float32Array(size.width * size.height) } : null), [size]);
  const sceneCanvas = useMemo(() => (typeof document === "undefined" ? null : document.createElement("canvas")), []);

  // Everything the frame loop reads, refreshed every render.
  const live = useRef({ instances, terrainInstances, terrains, terrainBrush, shadow, local, lighting: sidecar.lighting, showFog, selectedId, selectedIds, locked, previewCamera, reach, renderer, size, buffers, mode, space, cssSize });
  live.current = { instances, terrainInstances, terrains, terrainBrush, shadow, local, lighting: sidecar.lighting, showFog, selectedId, selectedIds, locked, previewCamera, reach, renderer, size, buffers, mode, space, cssSize };
  /** The box select being dragged, in canvas pixels. */
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

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
      const { instances: objects, terrainInstances: land, shadow: shadowMap, local: localShadows, lighting, showFog: fogOn, selectedId: sel, selectedIds: sels, locked: lockedIds, previewCamera: preview, reach: sphere, renderer: r, size: s, buffers: b, mode: tool, space: axesSpace, cssSize: css } = live.current;
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
        // Show each object at the LOD its distance picks, as the game will.
        lod: true,
        ...(lighting
          ? {
              ambient: lighting.ambient,
              lightDirection: sceneLightingKeyDirection(lighting),
              environment: sceneLightingEnvironment(lighting),
              tonemap: sceneLightingTonemap(lighting),
              lights: localShadows?.lights ?? lighting.lights,
              localShadows: localShadows?.shadows ?? null,
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
      // A renderer just built (after a resize) has nothing to show yet: keep the
      // last picture up rather than blanking the view until its first frame lands.
      if (r.ready === false) return;

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
      for (const other of objects) if (other.id !== sel && sels.includes(other.id)) drawSelection(context, viewProj, other, s.width, s.height, false);
      const selected = objects.find((i) => i.id === sel);
      if (selected) {
        drawSelection(context, viewProj, selected, s.width, s.height, true);
        if (!preview && tool !== "orbit" && css && !lockedIds.has(selected.id)) {
          const frameNow = gizmoAt(cam, selected.model, tool, axesSpace, css.h);
          drawGizmo(context, tool, frameNow, (p) => project(viewProj, p, s.width, s.height), hover.current, active.current, s.width / css.w);
        }
      }

      // The terrain brush's rim, on the ground under the cursor.
      const under = brushHover.current;
      const brushNow = live.current.terrainBrush;
      if (brushNow && under && !preview) {
        const k = live.current.terrains.findIndex((t) => t.terrain.id === brushNow.id);
        const inst = live.current.terrainInstances[k];
        const t = live.current.terrains[k]?.terrain;
        if (inst && t) {
          const pts = brushRing(t, inst.model, under[0], under[1], brushNow.radius).map((p) => project(viewProj, p, s.width, s.height));
          context.save();
          context.strokeStyle = "#ffd36b";
          context.lineWidth = Math.max(1, s.width / (css?.w ?? s.width)) * 1.5;
          context.beginPath();
          let pen = false;
          for (const p of pts) {
            if (!p) {
              pen = false;
              continue;
            }
            if (pen) context.lineTo(p[0], p[1]);
            else context.moveTo(p[0], p[1]);
            pen = true;
          }
          context.stroke();
          context.restore();
        }
      }

      const box = marquee.current;
      if (box) {
        context.save();
        context.fillStyle = "rgba(125, 184, 252, 0.12)";
        context.strokeStyle = "#7db8fc";
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        const x = Math.min(box.x0, box.x1);
        const y = Math.min(box.y0, box.y1);
        context.fillRect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
        context.strokeRect(x + 0.5, y + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
        context.restore();
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

  type DragKind = "tool" | "orbit" | "pan" | "look" | "gizmo" | "box" | "brush";
  /** One selected object a gizmo drag moves: where it started, in its parent's space and the world's. */
  interface Moving {
    readonly id: string;
    readonly start: Transform;
    readonly startWorld: Vec3;
    readonly parentWorld: Mat4 | null;
  }
  interface GizmoDrag {
    readonly handle: Handle;
    readonly frame: GizmoFrame;
    readonly ray0: Ray;
    readonly cursor0: readonly [number, number];
    readonly origin: readonly [number, number];
    /** The primary (whose gizmo it is), and every selected root it moves along with it. */
    readonly primary: Moving;
    readonly group: readonly Moving[];
  }
  const drag = useRef<{ kind: DragKind; x: number; y: number; moved: boolean; gizmo?: GizmoDrag; additive?: { toggle: boolean; add: boolean } } | null>(null);

  /** A pointer event's place: in canvas pixels, and as normalised device coordinates. */
  const pointerAt = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    const cx = ((event.clientX - rect.left) / rect.width) * el.width;
    const cy = ((event.clientY - rect.top) / rect.height) * el.height;
    const ndc: [number, number] = [((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)];
    return { canvas: [cx, cy] as [number, number], ndc, rect };
  };

  /** A selected object as a gizmo drag sees it (null when it's gone or locked). */
  const moving = (id: string): Moving | null => {
    const entry = sidecar.meshes.find((m) => m.id === id);
    const placed = placement.get(id);
    if (!entry || !placed || locked.has(id)) return null;
    const t = entry.transform;
    return {
      id,
      start: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] },
      startWorld: [placed.world[12]!, placed.world[13]!, placed.world[14]!],
      parentWorld: placed.parentWorld,
    };
  };

  /** The gizmo handle under a pointer, or null (no gizmo: the view tool, a timeline camera, nothing selected, a locked primary). */
  const handleUnder = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement): { handle: Handle; frame: GizmoFrame; origin: [number, number] } | null => {
    const cam = cameraRef.current;
    const world = selectedId && !locked.has(selectedId) && !hidden.has(selectedId) ? placement.get(selectedId)?.world : undefined;
    if (!cam || !world || mode === "orbit" || previewCamera || !size) return null;
    const { canvas, rect } = pointerAt(event, el);
    const frameNow = gizmoAt(cam, world, mode, space, rect.height);
    const planes = clipPlanes(cam, reach.center, reach.radius);
    const { viewProj } = cameraMatrices(cam, size.width / size.height, planes.near, planes.far);
    const projector = (p: Vec3) => project(viewProj, p, el.width, el.height);
    const handle = hitHandle(mode, frameNow, projector, canvas, 8 * (el.width / rect.width));
    const origin = projector(frameNow.origin);
    return handle && origin ? { handle, frame: frameNow, origin } : null;
  };

  /** The terrain point under the cursor for the brush (terrain space x, z), or null. */
  const brushHover = useRef<readonly [number, number] | null>(null);
  const terrainUnder = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement): readonly [number, number] | null => {
    const cam = cameraRef.current;
    if (!terrainBrush || !cam) return null;
    const k = terrains.findIndex((t) => t.terrain.id === terrainBrush.id);
    const inst = terrainInstances[k];
    const t = terrains[k]?.terrain;
    if (!inst || !t) return null;
    const { ndc } = pointerAt(event, el);
    const hit = terrainRayHit(t, inst.model, viewportRay(cam, aspect, ndc[0], ndc[1]));
    return hit ? [hit.local[0], hit.local[2]] : null;
  };
  const brushAt = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement, start: boolean) => {
    const at = terrainUnder(event, el);
    brushHover.current = at;
    markDirty();
    if (at && terrainBrush) onTerrainStroke?.(terrainBrush.id, at[0], at[1], start);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const cam = cameraRef.current;
    const plainLeft = event.button === 0 && !event.altKey;
    if (plainLeft && terrainBrush) {
      // A terrain tool is up: the left button brushes the ground.
      drag.current = { kind: "brush", x: event.clientX, y: event.clientY, moved: false };
      brushAt(event, event.currentTarget, true);
      return;
    }
    if (plainLeft && cam) {
      const grabbed = handleUnder(event, event.currentTarget);
      const primary = selectedId ? moving(selectedId) : null;
      if (grabbed && primary) {
        const { canvas, ndc } = pointerAt(event, event.currentTarget);
        active.current = grabbed.handle;
        markDirty();
        const group = selectionRoots(sidecar, selectedIds)
          .map(moving)
          .filter((m): m is Moving => m !== null);
        drag.current = {
          kind: "gizmo",
          x: event.clientX,
          y: event.clientY,
          moved: false,
          gizmo: { handle: grabbed.handle, frame: grabbed.frame, ray0: viewportRay(cam, aspect, ndc[0], ndc[1]), cursor0: canvas, origin: grabbed.origin, primary, group },
        };
        return;
      }
    }
    // Left drag: orbits with the view tool, box-selects with a transform tool.
    // Alt+left orbits, Alt+Shift+left or the middle button pans, the right button looks and flies.
    const kind: DragKind =
      event.button === 2 ? "look" : event.button === 1 || (event.button === 0 && event.altKey && event.shiftKey) ? "pan" : event.button === 0 && event.altKey ? "orbit" : "tool";
    if (kind === "look") flying.current = true;
    drag.current = { kind, x: event.clientX, y: event.clientY, moved: false, additive: { toggle: event.ctrlKey || event.metaKey, add: event.shiftKey } };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    const cam = cameraRef.current;
    if (state?.kind === "brush") {
      brushAt(event, event.currentTarget, false);
      return;
    }
    if (!state && terrainBrush) {
      // Hovering with a terrain tool: the brush's rim follows the cursor.
      brushHover.current = terrainUnder(event, event.currentTarget);
      markDirty();
      return;
    }
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
    const firstMove = !state.moved;
    state.moved = true;
    const rect = event.currentTarget.getBoundingClientRect();

    if (state.kind === "gizmo" && state.gizmo) {
      // Measured from where the drag started, so snapping is exact and nothing drifts.
      const g = state.gizmo;
      const { canvas, ndc } = pointerAt(event, event.currentTarget);
      const ray = viewportRay(cam, aspect, ndc[0], ndc[1]);
      const snap = snapOn !== (event.ctrlKey || event.metaKey) ? steps : null;
      const placed = new Map<string, Transform>();
      if (mode === "move") {
        // The primary goes where the cursor takes it; the rest move by as much.
        const to = dragMove(g.handle, g.frame, g.primary.startWorld, g.ray0, ray, cameraAxes(cam).forward, snap, space);
        const d: Vec3 = [to[0] - g.primary.startWorld[0], to[1] - g.primary.startWorld[1], to[2] - g.primary.startWorld[2]];
        for (const m of g.group) placed.set(m.id, { ...m.start, position: localPositionFor([m.startWorld[0] + d[0], m.startWorld[1] + d[1], m.startWorld[2] + d[2]], m.parentWorld) });
      } else if (mode === "rotate" && g.handle.kind === "ring") {
        // Every object turns about the axis through the primary's origin.
        const axis = g.frame.axes[g.handle.axis];
        const angle = dragRotate(g.handle, g.frame, g.ray0, ray, snap, canvas[0] - g.cursor0[0]);
        for (const m of g.group) {
          const turned = rotatedTransform(m.start, m.parentWorld, axis, angle);
          placed.set(m.id, { ...turned, position: localPositionFor(rotateAbout(m.startWorld, g.primary.startWorld, axis, angle), m.parentWorld) });
        }
      } else if (mode === "scale") {
        // The primary's change in scale, per axis, applied to each object along its own axes.
        const next = dragScale(g.handle, g.frame, g.primary.start.scale, g.ray0, ray, { origin: g.origin, cursor0: g.cursor0, cursor: canvas }, snap);
        const f = next.map((v, k) => v / (g.primary.start.scale[k] || 1));
        for (const m of g.group) placed.set(m.id, { ...m.start, scale: m.id === g.primary.id ? next : [m.start.scale[0] * f[0]!, m.start.scale[1] * f[1]!, m.start.scale[2] * f[2]!] });
      }
      let next = sidecar;
      for (const [id, t] of placed) next = setMeshTransform(next, id, { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] });
      if (placed.size > 0) onSidecarChange(next);
      return;
    }
    if (state.kind === "tool" && mode !== "orbit") {
      // A box select, from where the drag started.
      const { canvas } = pointerAt(event, event.currentTarget);
      if (firstMove || !marquee.current) {
        const start = pointerAt({ clientX: state.x, clientY: state.y }, event.currentTarget).canvas;
        marquee.current = { x0: start[0], y0: start[1], x1: canvas[0], y1: canvas[1] };
      } else marquee.current = { ...marquee.current, x1: canvas[0], y1: canvas[1] };
      state.kind = "box";
      markDirty();
      return;
    }
    if (state.kind === "box" && marquee.current) {
      const { canvas } = pointerAt(event, event.currentTarget);
      marquee.current = { ...marquee.current, x1: canvas[0], y1: canvas[1] };
      markDirty();
      return;
    }
    state.x = event.clientX;
    state.y = event.clientY;
    if (state.kind === "look") return setCamera(look(cam, -dx * LOOK_SPEED, dy * LOOK_SPEED));
    if (state.kind === "pan") {
      const k = unitsPerPixel(cam, cam.distance, rect.height);
      return setCamera(pan(cam, -dx * k, dy * k));
    }
    // Dragging with the view tool (or Alt) orbits.
    setCamera(orbit(cam, -dx * ORBIT_SPEED, dy * ORBIT_SPEED));
  };

  /** The objects that can be picked here: drawn (not hidden) and not locked. */
  const pickable = () => instances.filter((i) => !locked.has(i.id));

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
    if (state?.kind === "box") {
      const box = marquee.current;
      marquee.current = null;
      markDirty();
      if (!box || !cam || !size) return;
      const planes = clipPlanes(cam, reach.center, reach.radius);
      const { viewProj } = cameraMatrices(cam, size.width / size.height, planes.near, planes.far);
      const el = event.currentTarget;
      const objects = pickable().flatMap((i) => {
        const b = worldAabb(i.mesh, i.model);
        return b ? [{ id: i.id, min: b.min as Vec3, max: b.max as Vec3 }] : [];
      });
      const inside = boxSelect(objects, box, (p) => project(viewProj, p, el.width, el.height));
      const mods = state.additive ?? { toggle: false, add: false };
      if (mods.toggle) onSelectIds([...selectedIds.filter((id) => !inside.includes(id)), ...inside.filter((id) => !selectedIds.includes(id))]);
      else if (mods.add) onSelectIds([...selectedIds.filter((id) => !inside.includes(id)), ...inside]);
      else onSelectIds(inside);
      return;
    }
    if (!state || state.moved || state.kind !== "tool" || !cam) return;
    // A click: pick the mesh whose triangles are under the cursor.
    const { ndc } = pointerAt(event, event.currentTarget);
    const ray = viewportRay(cam, aspect, ndc[0], ndc[1]);
    const hit = raycastMeshes(ray, pickable().map((i) => ({ key: i.id, mesh: i.mesh, model: i.model })))?.key ?? null;
    onSelectIds(clickSelection(selectedIds, hit, state.additive ?? {}));
  };

  /** Drop each selected object onto whatever is beneath it (other meshes, the terrain, or the ground). */
  const dropToSurface = useCallback(() => {
    const roots = selectionRoots(sidecar, selectedIds).filter((id) => !locked.has(id) && !hidden.has(id));
    if (roots.length === 0) return;
    const ground =
      terrains.length > 0 && showTerrain
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
    // The selection and everything under it move together, so none of it is a surface to land on.
    const ignore = new Set(withSubtrees(sidecar, roots));
    const surfaces = [...instances.map((i) => ({ key: i.id, mesh: i.mesh, model: i.model })), ...terrainInstances.map((t, k) => ({ key: `terrain:${k}`, mesh: t.mesh, model: t.model }))];
    let next = sidecar;
    for (const id of roots) {
      const entry = sidecar.meshes.find((m) => m.id === id);
      const target = instances.find((i) => i.id === id);
      const box = target ? worldAabb(target.mesh, target.model) : null;
      if (!entry || !target || !box) continue;
      const dy = dropDistance({ min: box.min as Vec3, max: box.max as Vec3 }, surfaces, ignore, ground);
      if (dy === null || Math.abs(dy) < 1e-6) continue;
      const world: Vec3 = [target.model[12]!, target.model[13]! + dy, target.model[14]!];
      next = setMeshTransform(next, id, { ...entry.transform, position: localPositionFor(world, placement.get(id)?.parentWorld ?? null) });
    }
    if (next !== sidecar) onSidecarChange(next);
  }, [selectedIds, sidecar, instances, locked, hidden, terrains, terrainInstances, showTerrain, placement, onSidecarChange]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const key = event.key.toLowerCase();
    if (flying.current && ["w", "a", "s", "d", "q", "e", "shift"].includes(key)) {
      keys.current.add(key);
      event.preventDefault();
      return;
    }
    if (onKey?.(event)) return;
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
  /**
   * Where a drop lands: on the first surface under the cursor (a mesh's
   * triangles), else on the ground (y = 0), else at the camera's pivot.
   */
  const dropPoint = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement): Vec3 | null => {
    const cam = cameraRef.current;
    if (!cam) return null;
    const { ndc } = pointerAt(event, el);
    const ray = viewportRay(cam, aspect, ndc[0], ndc[1]);
    const hit = raycastMeshes(ray, pickable().map((i) => ({ key: i.id, mesh: i.mesh, model: i.model })));
    if (hit) return hit.point;
    if (Math.abs(ray.dir[1]) > 1e-6) {
      const t = -ray.origin[1] / ray.dir[1];
      if (t > 0) return [ray.origin[0] + ray.dir[0] * t, 0, ray.origin[2] + ray.dir[2] * t];
    }
    return cameraPivot(cam);
  };
  const onDragOver = (event: React.DragEvent<HTMLCanvasElement>) => {
    if (onDropAsset && event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (event: React.DragEvent<HTMLCanvasElement>) => {
    const data = event.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (!data || !onDropAsset) return;
    event.preventDefault();
    const at = dropPoint(event, event.currentTarget);
    if (at) onDropAsset(data, at);
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
    <section className={styles.mapStage} style={{ flex: "1 1 auto" }}>
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
          onDragOver={onDragOver}
          onDrop={onDrop}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: terrainBrush ? "crosshair" : mode === "orbit" ? "grab" : "crosshair", outline: "none" }}
          role="img"
          aria-label="3D scene — click to select; drag to orbit or transform; right-drag with WASD to fly; middle- or Shift-drag to pan; wheel to dolly; F frames the selection"
        />
      </div>
      <div className={styles.hud} style={{ flexWrap: "nowrap", overflow: "hidden", whiteSpace: "nowrap" }}>
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
          <span className={`${styles.hudValue} data`} style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
            {selectedIds.length > 1 ? `${selectedIds.length} objects` : selectedId ? (sidecar.meshes.find((m) => m.id === selectedId)?.name ?? "—") : "none"}
          </span>
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
function drawSelection(context: CanvasRenderingContext2D, viewProj: Mat4, instance: SceneInstance, width: number, height: number, primary: boolean): void {
  const box = worldAabb(instance.mesh, instance.model);
  if (!box) return;
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
  const edges: [number, number][] = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  context.lineWidth = primary ? 1.5 : 1;
  context.strokeStyle = primary ? "#7db8fc" : "rgba(125, 184, 252, 0.6)";
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
