"use client";

/**
 * The Mesh tab: import real triangle meshes (OBJ / glTF-GLB), preview them
 * textured, place them with a transform, and export them again. Meshes are the
 * editor's polygon-geometry asset, distinct from the voxel sculptor — kept as
 * true meshes, never voxelised.
 *
 * The preview is CPU-rendered by the shared software rasteriser (the same one the
 * runtime will use), drawn into a canvas exactly as the voxel tab draws its
 * model — so there is no WebGPU dependency and the preview matches how the mesh
 * will look in a cart. The mesh list, transforms, and imports live in the cart's
 * mesh sidecar, handed up through {@link onSidecarChange} to persist with the cart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Ragdoll,
  composeModelMatrix,
  createLiveSkinnedMesh,
  isSkinned,
  ragdollRadii,
  restPose,
  sampleClip,
  skinMatrices,
  renderMesh,
  shieldEffect,
  encodeObj,
  encodeGlb,
  meshBounds,
  meshVertexCount,
  meshTriangleCount,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  terrainHeight,
  eraseFoliage,
  paintFoliage,
  type MeshAsset,
  type DecodedTexture,
  type FoliageLayer,
  type Terrain,
} from "@cartbox/editor";

import {
  addMesh,
  removeMesh,
  renameMesh,
  setMeshAsset,
  setMeshLighting,
  setMeshTransform,
  readMeshEntry,
  type MeshSidecar,
  type MeshTransform,
} from "@/lib/meshSidecar";
import { withAutoLods } from "@/lib/meshLods";
import { DAB_SPACING, applyTerrainTool, findTerrain, replaceTerrain, strokeDabs } from "@/lib/terrainEdit";
import { findFoliage, replaceFoliage } from "@/lib/foliageEdit";
import { INITIAL_TERRAIN_EDIT, TerrainPanel, type TerrainEditState } from "./TerrainPanel";
import { SoundsPanel } from "./SoundsPanel";
import { ComponentScriptsPanel, ComponentsInspector } from "./ComponentsPanel";
import { clickSelection, copyPayload, duplicateEntries, pasteEntries, removeEntries, withSubtrees } from "@/lib/sceneSelection";
import { placeAsset, type ContentAsset } from "@/lib/contentBrowser";
import { ContentBrowser, type CodeAccess } from "./ContentBrowser";
import { ScenePlayView, type PlaytestConfig } from "./ScenePlayView";
import { importMeshFile, decodeMeshTextures } from "@/lib/meshImport";
import { loadKtx2Decoder } from "@/lib/ktx2Decoder";
import { KTX2_TRANSCODER_TRANSFER_BYTES, encodePngInBrowser, hasKtx2, sceneHasKtx2, settleKtx2Textures } from "@/lib/ktx2Policy";
import { fetchLibraryMesh } from "@/lib/libraryClient";
import type { LibraryAsset } from "@/lib/libraryManifest";
import styles from "./editor.module.css";
import { RailGroup, RailHint, SegmentedControl } from "./railControls";
import { LibraryBrowser } from "./LibraryBrowser";
import { MaterialEditor } from "./MaterialEditor";
import { AnimatorPanel } from "./AnimatorPanel";
import { LightingEditor } from "./LightingEditor";
import { TimelinePanel, type TimelinePreview } from "./TimelinePanel";
import type { ViewpointKey } from "./SceneViewport";
import { SceneViewport } from "./SceneViewport";
import { LevelPicker, LevelsPanel } from "./LevelsPanel";
import { NavigationPanel } from "./NavigationPanel";
import { LightingBakePanel } from "./LightingBakePanel";
import { ParticleEffectsPanel } from "./ParticleEffectsPanel";
import { DecalsPanel } from "./DecalsPanel";
import { DebrisPanel } from "./DebrisPanel";
import { StreamingPanel, StreamingPicker } from "./StreamingPanel";
import { formatBytes } from "./assetUploads";
import {
  AnimationPanel,
  CodeHint,
  HierarchyPanel,
  NO_SHIELD,
  ParentPicker,
  type SceneCommand,
  LodPanel,
  PhysicsPanel,
  PhysicsWorldPanel,
  PrefabLibrary,
  PrefabPanel,
  PropertyEditor,
  ShieldPanel,
  TagEditor,
  type ShieldPreview,
} from "./SceneObjectPanels";

const VIEWPORT = 512; // preview canvas edge in device pixels
const ORBIT_SPEED = 0.01; // radians per pixel dragged
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;

interface MeshEditorProps {
  /** The cart's mesh sidecar (the list of imported meshes). */
  sidecar: MeshSidecar;
  /** Called with the next sidecar after any import, transform, rename, or delete. */
  onSidecarChange: (sidecar: MeshSidecar) => void;
  /** The cart's code, for the content browser to find (and on a rename, update) asset names in it. */
  code?: CodeAccess;
  /** Build a playtest to run inside the scene view (EP5), or null when the cart can't run. */
  onStartPlay?: () => Promise<PlaytestConfig | null>;
}

/** Trigger a browser download of raw bytes or text under `filename`. */
function download(filename: string, data: Uint8Array | string, mime: string): void {
  const part: BlobPart = typeof data === "string" ? data : (data.slice().buffer as ArrayBuffer);
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** The camera distance that frames a mesh's bounds at the default zoom. */
function fitDistance(mesh: MeshAsset): number {
  const bounds = meshBounds(mesh);
  if (!bounds) return 3;
  const radius =
    0.5 * Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const fov = (50 * Math.PI) / 180;
  return radius / Math.sin(fov / 2) + radius;
}

export function MeshEditor({ sidecar, onSidecarChange, code, onStartPlay }: MeshEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * The selection (EP3): any number of objects, the last one the primary that
   * the inspector and gizmo follow. Hiding and locking are the editor's own
   * (not saved with the cart): hidden objects aren't drawn or picked in the
   * scene view, locked ones can't be picked or moved there.
   */
  const [selection, setSelection] = useState<string[]>(sidecar.meshes[0] ? [sidecar.meshes[0].id] : []);
  const selectedId = selection.at(-1) ?? null;
  const setSelectedId = useCallback((id: string | null) => setSelection(id ? [id] : []), []);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  /** What was hidden before isolating the selection (isolating again puts it back). */
  const [isolatedFrom, setIsolatedFrom] = useState<ReadonlySet<string> | null>(null);
  const clipboard = useRef<string | null>(null);
  /**
   * Playing in the editor (EP5): the running playtest, the scene as it was when
   * Play was pressed (what Stop goes back to), and whether to keep the edits
   * made while it played instead.
   */
  const [playing, setPlaying] = useState<PlaytestConfig | null>(null);
  const [playStart, setPlayStart] = useState<MeshSidecar | null>(null);
  const [keepPlayEdits, setKeepPlayEdits] = useState(false);
  const startPlay = useCallback(async () => {
    if (!onStartPlay) return;
    const config = await onStartPlay();
    if (!config) return;
    setPlayStart(sidecar);
    setKeepPlayEdits(false);
    setView("scene");
    setPlaying(config);
  }, [onStartPlay, sidecar]);
  const stopPlay = useCallback(() => {
    if (playStart && !keepPlayEdits && playStart !== sidecar) onSidecarChange(playStart);
    setPlaying(null);
    setPlayStart(null);
  }, [playStart, keepPlayEdits, sidecar, onSidecarChange]);
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.4);
  const [zoom, setZoom] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [textures, setTextures] = useState<(DecodedTexture | null)[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** "solo" previews the selected mesh alone; "scene" composes every instance. */
  const [view, setView] = useState<"solo" | "scene">("solo");
  /** The Terrain panel's tool and brush (EP10); a tool up turns the scene view's left button into a brush. */
  const [terrainEdit, setTerrainEdit] = useState<TerrainEditState>(INITIAL_TERRAIN_EDIT);
  const onTerrainEdit = (next: TerrainEditState) => {
    setTerrainEdit(next);
    if (next.tool) setView("scene"); // brushing happens in the scene view
  };
  /** The stroke in progress: the terrain as it's been brushed so far, the last dab, and the level a flatten holds. */
  const strokeRef = useRef<{ terrain: Terrain; last: readonly [number, number] | null; level?: number } | null>(null);
  /** A foliage stroke in progress: the layer as painted so far, its mesh, the terrain it grows on, the last dab, and a seed per dab. */
  const foliageStrokeRef = useRef<{ layer: FoliageLayer; mesh: string; terrain: Terrain; last: readonly [number, number] | null; seed: number } | null>(null);
  const onTerrainStroke = (id: string, x: number, z: number, start: boolean) => {
    const { tool, radius, strength } = terrainEdit;
    if (!tool) return;
    if (tool.kind === "foliage") {
      if (start || !foliageStrokeRef.current || foliageStrokeRef.current.layer.id !== tool.layer) {
        const found = findFoliage(sidecar, tool.layer);
        const t = found ? findTerrain(sidecar, found.layer.terrain) : null;
        if (!found || !t) return;
        foliageStrokeRef.current = { layer: found.layer, mesh: found.mesh, terrain: t, last: null, seed: Math.floor(Math.random() * 2 ** 31) };
      }
      const f = foliageStrokeRef.current;
      const { dabs, last } = strokeDabs(f.last, [x, z], radius);
      if (dabs.length === 0) return;
      let layer = f.layer;
      for (const [dx, dz] of dabs) {
        const brush = { x: dx, z: dz, radius, strength: strength * 0.5 };
        f.seed += 1;
        layer = tool.erase ? eraseFoliage(layer, brush, f.seed) : paintFoliage(f.terrain, layer, brush, f.seed);
      }
      f.layer = layer;
      f.last = last;
      onSidecarChange(replaceFoliage(sidecar, layer, f.mesh));
      return;
    }
    if (start || !strokeRef.current || strokeRef.current.terrain.id !== id) {
      const t = findTerrain(sidecar, id);
      if (!t) return;
      const level = tool.kind === "sculpt" && tool.op === "flatten" ? (terrainHeight({ ...t, origin: [0, 0, 0], holes: undefined }, x, z) ?? 0) : undefined;
      strokeRef.current = { terrain: t, last: null, ...(level !== undefined ? { level } : {}) };
    }
    const stroke = strokeRef.current;
    const { dabs, last } = strokeDabs(stroke.last, [x, z], radius);
    if (dabs.length === 0) return;
    // Dabs overlap (a quarter of the brush apart), so each lays a share of the
    // strength: a pass with a sculpt brush at half strength lifts about a sixth of its radius.
    const share = tool.kind === "hole" ? 1 : tool.kind === "paint" ? DAB_SPACING : 0.5;
    let t = stroke.terrain;
    for (const [dx, dz] of dabs) t = applyTerrainTool(t, tool, { x: dx, z: dz, radius, strength: strength * share }, stroke.level);
    stroke.terrain = t;
    stroke.last = last;
    onSidecarChange(replaceTerrain(sidecar, t));
  };
  /** The skeletal clip the preview is playing (index), or null for the still mesh, and how far in. */
  const [previewClip, setPreviewClip] = useState<number | null>(null);
  const [clipTime, setClipTime] = useState(0);
  /** A ragdoll dropped in the preview (H9): the body, and a frame counter that re-renders as it falls. */
  const ragdollRef = useRef<Ragdoll | null>(null);
  const [ragdolling, setRagdolling] = useState(false);
  const [ragdollFrame, setRagdollFrame] = useState(0);
  /** A shield effect previewed on the selected object (H11), and the clock its shimmer and camo move by. */
  const [shield, setShield] = useState<ShieldPreview>(NO_SHIELD);
  const [shieldTime, setShieldTime] = useState(0);
  /** The Scene view's viewpoint (to key a timeline camera from), and a timeline moment previewed in it. */
  const [sceneView, setSceneView] = useState<ViewpointKey | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<TimelinePreview | null>(null);
  const onTimelinePreview = useCallback((preview: TimelinePreview | null) => {
    setTimelinePreview(preview);
    if (preview) setView("scene");
  }, []);

  // Keep the selection valid as the list changes: drop ids that are gone (an
  // emptied selection falls back to the first object, as before).
  useEffect(() => {
    const ids = new Set(sidecar.meshes.map((m) => m.id));
    const kept = selection.filter((id) => ids.has(id));
    if (kept.length === selection.length && (kept.length > 0 || sidecar.meshes.length === 0)) return;
    setSelection(kept.length > 0 ? kept : sidecar.meshes[0] ? [sidecar.meshes[0].id] : []);
  }, [sidecar, selection]);

  /** Place a mesh or prefab from the content browser at a world position, and select it in the scene view. */
  const placeAt = useCallback(
    (asset: Pick<ContentAsset, "kind" | "key" | "name">, at: readonly [number, number, number]) => {
      const placed = placeAsset(sidecar, asset, at);
      if (!placed.id) return;
      onSidecarChange(placed.sidecar);
      setSelection([placed.id]);
      setView("scene");
    },
    [sidecar, onSidecarChange],
  );

  /** Scene commands, from the keyboard (in the scene view or the hierarchy) or the hierarchy's buttons. */
  const sceneCommand = useCallback(
    async (command: SceneCommand) => {
      if (command === "selectAll") return setSelection(sidecar.meshes.filter((m) => !hidden.has(m.id) && !locked.has(m.id)).map((m) => m.id));
      if (command === "deselect") return setSelection([]);
      if (command === "unhideAll") {
        setHidden(new Set());
        setIsolatedFrom(null);
        return;
      }
      if (command === "isolate") {
        if (isolatedFrom) {
          setHidden(isolatedFrom);
          setIsolatedFrom(null);
          return;
        }
        if (selection.length === 0) return;
        const keep = new Set(withSubtrees(sidecar, selection));
        setIsolatedFrom(hidden);
        setHidden(new Set(sidecar.meshes.filter((m) => !keep.has(m.id)).map((m) => m.id)));
        return;
      }
      if (command === "paste") {
        let text = clipboard.current;
        try {
          text = (await navigator.clipboard?.readText?.()) || text;
        } catch {
          // No clipboard permission: fall back to what this tab copied.
        }
        if (!text) return;
        const pasted = pasteEntries(sidecar, text);
        if (pasted.ids.length === 0) return;
        onSidecarChange(pasted.sidecar);
        setSelection(pasted.ids);
        return;
      }
      if (selection.length === 0) return;
      if (command === "duplicate") {
        const copy = duplicateEntries(sidecar, selection);
        onSidecarChange(copy.sidecar);
        setSelection(copy.ids);
      } else if (command === "copy") {
        const text = copyPayload(sidecar, selection);
        if (!text) return;
        clipboard.current = text;
        try {
          await navigator.clipboard?.writeText?.(text);
        } catch {
          // Kept in this tab even without clipboard permission.
        }
      } else if (command === "delete") {
        onSidecarChange(removeEntries(sidecar, selection));
        setSelection([]);
      } else if (command === "hide") {
        const ids = withSubtrees(sidecar, selection);
        const allHidden = ids.every((id) => hidden.has(id));
        setHidden(new Set(allHidden ? [...hidden].filter((id) => !ids.includes(id)) : [...hidden, ...ids]));
      } else if (command === "lock") {
        const allLocked = selection.every((id) => locked.has(id));
        setLocked(new Set(allLocked ? [...locked].filter((id) => !selection.includes(id)) : [...locked, ...selection]));
      }
    },
    [sidecar, selection, hidden, locked, isolatedFrom, onSidecarChange],
  );
  /** The scene shortcuts (Unity's): Ctrl+D/C/V/A, Delete, H, Shift+H, Alt+H, Escape. True when the key was one. */
  const onSceneKey = useCallback(
    (event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }): boolean => {
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      const command: SceneCommand | null = mod
        ? ({ d: "duplicate", c: "copy", v: "paste", a: "selectAll" } as Record<string, SceneCommand>)[key] ?? null
        : key === "delete" || key === "backspace"
          ? "delete"
          : key === "escape"
            ? "deselect"
            : key === "h"
              ? event.altKey
                ? "unhideAll"
                : event.shiftKey
                  ? "isolate"
                  : "hide"
              : key === "l" && !event.altKey
                ? "lock"
                : null;
      if (!command) return false;
      event.preventDefault();
      void sceneCommand(command);
      return true;
    },
    [sceneCommand],
  );

  const selectedEntry = sidecar.meshes.find((entry) => entry.id === selectedId) ?? null;
  // Decode the selected mesh's geometry once per selection. A corrupt entry (it
  // was validated on the way in) simply shows nothing rather than throwing.
  const meshAsset = useMemo<MeshAsset | null>(() => {
    if (!selectedEntry) return null;
    try {
      return readMeshEntry(selectedEntry);
    } catch {
      return null;
    }
  }, [selectedEntry]);

  // A skinned mesh previews through a live copy the clip poses; stop previewing on selection change.
  const liveMesh = useMemo(() => (meshAsset && isSkinned(meshAsset) ? createLiveSkinnedMesh(meshAsset) : null), [meshAsset]);
  useEffect(() => setPreviewClip(null), [meshAsset]);
  // Playing a clip, or picking another mesh, stands a ragdoll back up.
  useEffect(() => {
    if (previewClip !== null) setRagdolling(false);
  }, [previewClip]);
  useEffect(() => setRagdolling(false), [meshAsset]);
  useEffect(() => setShield(NO_SHIELD), [meshAsset]);
  // The shimmer climbs and the camo crawls: run the preview's clock while either is on (~30 redraws a second).
  const shieldMoving = shield.shimmer > 0 || shield.camo > 0;
  useEffect(() => {
    if (!shieldMoving) return;
    const start = performance.now();
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 33) {
        last = now;
        setShieldTime((now - start) / 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shieldMoving]);
  useEffect(() => {
    if (!ragdolling) ragdollRef.current = null;
  }, [ragdolling]);
  // Drop the skeleton as a ragdoll onto a floor under its feet: the same
  // simulation killed soldiers use in the game, stepped at 60 a second.
  const dropRagdoll = useCallback(() => {
    const skin = meshAsset?.skin;
    const bounds = meshAsset ? meshBounds(meshAsset) : null;
    if (!meshAsset || !skin || !bounds) return;
    const h = Math.max(1e-3, bounds.max[1] - bounds.min[1]);
    const clip = previewClip !== null ? meshAsset.clips?.[previewClip] : undefined;
    const pose = clip ? sampleClip(skin, clip, clipTime) : restPose(skin);
    const identity = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    const doll = new Ragdoll(skin, pose, identity, {
      impulse: [0, h * 0.6, -h * 1.6],
      gravity: 9.81 * (h / 1.7),
      radii: ragdollRadii(meshAsset) ?? undefined,
    });
    const floor = [{ center: [0, bounds.min[1] - h * 0.5, 0] as const, half: [h * 30, h * 0.5, h * 30] as const }];
    ragdollRef.current = doll;
    setPreviewClip(null);
    setRagdolling(true);
    let last = performance.now();
    // Runs until the body sleeps, or is replaced or stood up (the ref moves on).
    const tick = (now: number) => {
      if (ragdollRef.current !== doll) return;
      // Catch up in whole 60 Hz steps; redraw at most ~30 times a second.
      let steps = Math.min(8, Math.floor((now - last) / (1000 / 60)));
      if (steps > 0) {
        last += steps * (1000 / 60);
        while (steps-- > 0) doll.step(1 / 60, floor);
        setRagdollFrame((f) => f + 1);
      }
      if (!doll.asleep) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [meshAsset, previewClip, clipTime]);
  useEffect(() => {
    if (previewClip === null) return;
    let raf = 0;
    let last = 0;
    const start = performance.now();
    const tick = (now: number) => {
      // ~30 fps is plenty for a software-rendered preview.
      if (now - last >= 33) {
        last = now;
        setClipTime((now - start) / 1000);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [previewClip]);

  // Decode this mesh's textures to RGBA for the rasteriser, cancelling if the
  // selection changes before decoding finishes.
  useEffect(() => {
    if (!meshAsset) {
      setTextures(null);
      return;
    }
    let cancelled = false;
    setTextures(null);
    void decodeMeshTextures(meshAsset).then((decoded) => {
      if (!cancelled) setTextures(decoded);
    });
    return () => {
      cancelled = true;
    };
  }, [meshAsset]);

  const buffers = useMemo(
    () => ({ out: new Uint8ClampedArray(VIEWPORT * VIEWPORT * 4), depth: new Float32Array(VIEWPORT * VIEWPORT) }),
    [],
  );

  // Render on any camera, mesh, or texture change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = VIEWPORT;
    canvas.height = VIEWPORT;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, VIEWPORT, VIEWPORT);
    if (!meshAsset) return;

    // Preview the authored lighting rig, if any. The single-mesh preview supports
    // the skybox environment, ambient, key-light direction, and tone mapping;
    // multi-light and shadows come with the scene viewport. Absent (no rig) the
    // preview renders exactly as before.
    const lighting = sidecar.lighting;
    const clip = previewClip !== null ? meshAsset.clips?.[previewClip] : undefined;
    let shown = meshAsset;
    const doll = ragdolling ? ragdollRef.current : null;
    if (liveMesh && meshAsset.skin && doll) {
      const pose = restPose(meshAsset.skin);
      doll.writePose(pose, composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]));
      liveMesh.update(skinMatrices(meshAsset.skin, pose));
      shown = liveMesh.mesh;
    } else if (liveMesh && meshAsset.skin && clip) {
      liveMesh.update(skinMatrices(meshAsset.skin, sampleClip(meshAsset.skin, clip, clipTime)));
      shown = liveMesh.mesh;
    }
    renderMesh(shown, {
      camera: { yaw, pitch, distance: fitDistance(meshAsset) * zoom },
      size: VIEWPORT,
      out: buffers.out,
      depth: buffers.depth,
      textures: textures ?? undefined,
      background: [14, 16, 26, 255],
      effect: shieldEffect(shield.flare, shield.shimmer, shield.camo),
      time: shieldTime,
      ...(lighting
        ? {
            ambient: lighting.ambient,
            lightDirection: sceneLightingKeyDirection(lighting),
            environment: sceneLightingEnvironment(lighting),
            tonemap: sceneLightingTonemap(lighting),
          }
        : {}),
    });
    const image = context.createImageData(VIEWPORT, VIEWPORT);
    image.data.set(buffers.out);
    context.putImageData(image, 0, 0);
  }, [meshAsset, textures, yaw, pitch, zoom, buffers, sidecar.lighting, liveMesh, previewClip, clipTime, ragdolling, ragdollFrame, shield, shieldTime]);

  // Orbit + zoom.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (!state) return;
    setYaw((value) => value - (event.clientX - state.x) * ORBIT_SPEED);
    setPitch((value) => Math.max(-1.5, Math.min(1.5, value + (event.clientY - state.y) * ORBIT_SPEED)));
    drag.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((value) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value * (event.deltaY < 0 ? 0.9 : 1.1))));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    const primary = all.find((file) => /\.(obj|glb|gltf)$/i.test(file.name)) ?? all[0]!;
    setNote("Importing…");
    try {
      const parsed = await importMeshFile(primary, all.filter((file) => file !== primary));
      // KTX2 textures stay compressed only when that saves more than the
      // transcoder players would then fetch; otherwise they become PNG.
      const settled = await settleKtx2Textures(parsed, {
        sceneHasKtx2: sceneHasKtx2([...sidecar.meshes.map((m) => m.mesh), ...(sidecar.prefabs ?? []).flatMap((p) => p.nodes.map((n) => n.mesh))]),
        decode: await (hasKtx2(parsed) ? loadKtx2Decoder() : Promise.resolve(() => null)),
        encodePng: encodePngInBrowser,
      });
      const asset = settled.mesh;
      const added = addMesh(sidecar, asset, asset.name);
      const id = added.id;
      // A heavy model gets its LODs on the way in.
      const next = withAutoLods(added.sidecar, id);
      onSidecarChange(next);
      setSelectedId(id);
      const textures =
        settled.outcome === "kept"
          ? ` KTX2 textures kept (${formatBytes(settled.ktx2Bytes)}, against ${formatBytes(settled.pngBytes)} as PNG).`
          : settled.outcome === "converted"
            ? ` KTX2 textures converted to PNG — too small to be worth the ${formatBytes(KTX2_TRANSCODER_TRANSFER_BYTES)} transcoder.`
            : "";
      setNote(
        `Imported “${asset.name}” — ${meshTriangleCount(asset).toLocaleString()} triangles, ${meshVertexCount(
          asset,
        ).toLocaleString()} vertices.${textures}${next !== added.sidecar ? " Lighter LODs made for distance." : ""}`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not import that file.");
    }
  };

  // Insert a mesh chosen from the asset library. Downloads the payload and runs
  // it through the same decode-and-add path as a file import, so a library mesh
  // and an uploaded one are indistinguishable once in the cart.
  const insertFromLibrary = async (asset: LibraryAsset) => {
    const mesh = await fetchLibraryMesh(asset.payloadUrl, asset.name);
    const added = addMesh(sidecar, mesh, asset.name);
    const id = added.id;
    const next = withAutoLods(added.sidecar, id);
    onSidecarChange(next);
    setSelectedId(id);
    setNote(
      `Inserted “${asset.name}” from the library — ${meshTriangleCount(mesh).toLocaleString()} triangles.`,
    );
    setLibraryOpen(false);
  };

  const updateTransform = (patch: Partial<MeshTransform>) => {
    if (!selectedEntry) return;
    onSidecarChange(setMeshTransform(sidecar, selectedEntry.id, { ...selectedEntry.transform, ...patch }));
  };

  // Persist an edited mesh (a material change) back into its sidecar entry; the
  // updated sidecar flows back down as props and re-derives the preview.
  const applyMeshEdit = (next: MeshAsset) => {
    if (!selectedEntry) return;
    onSidecarChange(setMeshAsset(sidecar, selectedEntry.id, next));
  };

  const exportObj = () => {
    if (!meshAsset || !selectedEntry) return;
    const safe = (selectedEntry.name || "mesh").replace(/[^a-z0-9_-]+/gi, "_");
    const { obj, mtl } = encodeObj(meshAsset, `${safe}.mtl`);
    download(`${safe}.obj`, obj, "text/plain");
    download(`${safe}.mtl`, mtl, "text/plain");
  };
  const exportGlb = () => {
    if (!meshAsset || !selectedEntry) return;
    const safe = (selectedEntry.name || "mesh").replace(/[^a-z0-9_-]+/gi, "_");
    download(`${safe}.glb`, encodeGlb(meshAsset), "model/gltf-binary");
  };

  return (
    <div className={styles.body}>
      {/* Left rail: import + mesh list */}
      <aside style={{ width: 240, padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <SegmentedControl
          label="View"
          ariaLabel="Preview mode"
          selected={view}
          onSelect={setView}
          options={[
            { id: "solo", label: "Solo mesh", hint: "Preview the selected mesh alone" },
            { id: "scene", label: "Scene", hint: "Compose every placed mesh together" },
          ]}
        />
        {onStartPlay && (
          <button
            type="button"
            className={styles.toolBtn}
            aria-pressed={playing !== null}
            onClick={() => (playing ? stopPlay() : void startPlay())}
            title={playing ? "Stop playing (edits made while playing are undone unless you keep them)" : "Play the cart here, inside the scene view, and keep editing while it runs"}
            style={{ justifyContent: "center", fontWeight: 600, color: playing ? "#ff8a8a" : "#7dff9a" }}
          >
            {playing ? "■ Stop" : "▶ Play in scene"}
          </button>
        )}
        <RailGroup label="Import">
          <div className={styles.toolGroup}>
            <button type="button" className={styles.toolBtn} onClick={() => fileRef.current?.click()}>
              <span className={styles.toolGlyph} aria-hidden>
                ⬆
              </span>
              Import 3D model
            </button>
            <button type="button" className={styles.toolBtn} onClick={() => setLibraryOpen(true)}>
              <span className={styles.toolGlyph} aria-hidden>
                ⧉
              </span>
              Browse library
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".obj,.glb,.gltf,.mtl"
            multiple
            hidden
            onChange={(event) => {
              void importFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <RailHint>OBJ, glTF, or GLB (meshopt- and Draco-compressed too). For OBJ, select its .mtl alongside to keep colours.</RailHint>
          {note && <RailHint>{note}</RailHint>}
        </RailGroup>

        <HierarchyPanel
          sidecar={sidecar}
          selectedIds={selection}
          onSelect={(id, mods) => setSelection((current) => clickSelection(current, id, mods))}
          hidden={hidden}
          locked={locked}
          onToggleHidden={(id) => setHidden((h) => { const ids = withSubtrees(sidecar, [id]); return new Set(h.has(id) ? [...h].filter((x) => !ids.includes(x)) : [...h, ...ids]); })}
          onToggleLocked={(id) => setLocked((l) => new Set(l.has(id) ? [...l].filter((x) => x !== id) : [...l, id]))}
          onCommand={(command) => void sceneCommand(command)}
          onKey={onSceneKey}
        />

        <PrefabLibrary sidecar={sidecar} onChange={onSidecarChange} onPlaced={setSelectedId} />

        <TerrainPanel sidecar={sidecar} onChange={onSidecarChange} edit={terrainEdit} onEdit={onTerrainEdit} />
      </aside>

      {/* Centre: preview — the selected mesh alone, or the whole composed scene — over the content browser */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      {playing ? (
        <ScenePlayView config={playing} sidecar={sidecar} keep={keepPlayEdits} onKeepChange={setKeepPlayEdits} onStop={stopPlay} />
      ) : view === "scene" ? (
        <SceneViewport
          sidecar={sidecar}
          onSidecarChange={onSidecarChange}
          selectedIds={selection}
          onSelectIds={setSelection}
          hidden={hidden}
          locked={locked}
          onKey={onSceneKey}
          previewCamera={timelinePreview?.camera ?? null}
          previewLocals={timelinePreview?.locals ?? null}
          onView={setSceneView}
          terrainBrush={terrainEdit.tool && terrainEdit.id ? { id: terrainEdit.id, radius: terrainEdit.radius } : null}
          onTerrainStroke={onTerrainStroke}
          onDropAsset={(data, at) => {
            try {
              const asset = JSON.parse(data) as { kind?: unknown; key?: unknown };
              if ((asset.kind === "mesh" || asset.kind === "prefab") && typeof asset.key === "string") placeAt({ kind: asset.kind, key: asset.key, name: "" }, at);
            } catch {
              // Not one of ours.
            }
          }}
        />
      ) : (
      <section className={styles.mapStage} style={{ flex: "1 1 auto" }}>
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
            cursor: meshAsset ? "grab" : "default",
            background: "#0e101a",
            borderRadius: 8,
          }}
          role="img"
          aria-label="3D mesh preview — drag to orbit, scroll to zoom"
        />
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Triangles</span>
            <span className={`${styles.hudValue} data`}>{meshAsset ? meshTriangleCount(meshAsset).toLocaleString() : "—"}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Vertices</span>
            <span className={`${styles.hudValue} data`}>{meshAsset ? meshVertexCount(meshAsset).toLocaleString() : "—"}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Textured</span>
            <span className={`${styles.hudValue} data`}>
              {meshAsset ? (meshAsset.primitives.some((p) => p.material.baseColorImage) ? "yes" : "no") : "—"}
            </span>
          </span>
        </div>
      </section>
      )}
        <ContentBrowser
          sidecar={sidecar}
          onSidecarChange={onSidecarChange}
          code={code}
          onSelectObjects={(ids) => setSelection(ids)}
          onPlace={(asset) => placeAt(asset, sceneView?.target ?? [0, 0, 0])}
        />
      </div>

      {/* Right: transform, rename, export */}
      <aside style={{ width: 260, padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        {selectedEntry ? (
          <>
            <RailGroup label="Name">
              <input
                type="text"
                value={selectedEntry.name}
                onChange={(event) => onSidecarChange(renameMesh(sidecar, selectedEntry.id, event.target.value))}
                aria-label="Mesh name"
                style={{ width: "100%", padding: "6px 8px", borderRadius: 6 }}
              />
            </RailGroup>

            <ParentPicker sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <LevelPicker sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <StreamingPicker sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <TransformControls transform={selectedEntry.transform} onChange={updateTransform} relative={Boolean(selectedEntry.parent)} />

            <TagEditor sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <PropertyEditor sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            {meshAsset && isSkinned(meshAsset) && (
              <AnimationPanel
                mesh={meshAsset}
                name={selectedEntry.name}
                playing={previewClip}
                onPlay={setPreviewClip}
                ragdoll={ragdolling}
                onRagdoll={(on) => (on ? dropRagdoll() : setRagdolling(false))}
                onEdit={applyMeshEdit}
                sources={sidecar.meshes.filter((m) => m.id !== selectedEntry.id && m.mesh !== selectedEntry.mesh).map((m) => ({ id: m.id, name: m.name }))}
                loadSource={(id) => {
                  const entry = sidecar.meshes.find((m) => m.id === id);
                  try {
                    return entry ? readMeshEntry(entry) : null;
                  } catch {
                    return null;
                  }
                }}
              />
            )}
            {meshAsset && isSkinned(meshAsset) && (
              <AnimatorPanel sidecar={sidecar} entry={selectedEntry} mesh={meshAsset} onChange={onSidecarChange} />
            )}
            {meshAsset && <ShieldPanel name={selectedEntry.name} shield={shield} onChange={setShield} />}

            <LodPanel sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <PhysicsPanel sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <ComponentsInspector sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <PrefabPanel sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

            <CodeHint entry={selectedEntry} />

            {meshAsset && <MaterialEditor mesh={meshAsset} onChange={applyMeshEdit} />}

            <RailGroup label="Export">
              <div className={styles.toolGroup}>
                <button type="button" className={styles.toolBtn} onClick={exportGlb} title="Download as glTF binary (keeps textures)">
                  <span className={styles.toolGlyph} aria-hidden>
                    ⬇
                  </span>
                  Export .glb
                </button>
                <button type="button" className={styles.toolBtn} onClick={exportObj} title="Download as OBJ + MTL (geometry + colour)">
                  <span className={styles.toolGlyph} aria-hidden>
                    ⬇
                  </span>
                  Export .obj
                </button>
              </div>
              <RailHint>GLB keeps the base-colour texture; OBJ keeps geometry and flat colour.</RailHint>
            </RailGroup>

            <RailGroup label="Remove">
              <div className={styles.toolGroup}>
                <button
                  type="button"
                  className={styles.toolBtn}
                  onClick={() => onSidecarChange(removeMesh(sidecar, selectedEntry.id))}
                  title="Remove this mesh from the cart"
                >
                  <span className={styles.toolGlyph} aria-hidden>
                    🗑
                  </span>
                  Delete mesh
                </button>
              </div>
            </RailGroup>
          </>
        ) : (
          <RailHint>Import a 3D model to preview and place it.</RailHint>
        )}

        {/* Scene-wide lighting: authored once for the whole 3D scene, so it lives
            outside the per-mesh selection. */}
        <LightingEditor lighting={sidecar.lighting} onChange={(lighting) => onSidecarChange(setMeshLighting(sidecar, lighting))} />
        <PhysicsWorldPanel sidecar={sidecar} onChange={onSidecarChange} />
        <LevelsPanel sidecar={sidecar} onChange={onSidecarChange} />
        <StreamingPanel sidecar={sidecar} onChange={onSidecarChange} />
        <NavigationPanel sidecar={sidecar} onChange={onSidecarChange} />
        <LightingBakePanel sidecar={sidecar} onChange={onSidecarChange} />
        <ParticleEffectsPanel sidecar={sidecar} onChange={onSidecarChange} />
        <DecalsPanel sidecar={sidecar} onChange={onSidecarChange} />
        <DebrisPanel sidecar={sidecar} onChange={onSidecarChange} />
        <SoundsPanel sidecar={sidecar} onChange={onSidecarChange} />
        <ComponentScriptsPanel sidecar={sidecar} onChange={onSidecarChange} />
        <TimelinePanel sidecar={sidecar} onChange={onSidecarChange} view={view === "scene" ? sceneView : null} onPreview={onTimelinePreview} />
      </aside>

      <LibraryBrowser
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        kinds={["mesh"]}
        onInsert={insertFromLibrary}
      />
    </div>
  );
}

/** Nine numeric fields editing a placement transform: position, rotation, scale. */
function TransformControls({
  transform,
  onChange,
  relative = false,
}: {
  transform: MeshTransform;
  onChange: (patch: Partial<MeshTransform>) => void;
  /** The object has a parent: the transform is relative to it. */
  relative?: boolean;
}) {
  const rows: { label: string; key: keyof MeshTransform; step: number }[] = [
    { label: "Position", key: "position", step: 0.1 },
    { label: "Rotation°", key: "rotation", step: 5 },
    { label: "Scale", key: "scale", step: 0.1 },
  ];
  return (
    <RailGroup label="Transform">
      {rows.map(({ label, key, step }) => (
        <div key={key} style={{ marginBottom: 8 }}>
          <div className={styles.hudLabel} style={{ marginBottom: 4 }}>
            {label}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[0, 1, 2].map((axis) => (
              <input
                key={axis}
                type="number"
                step={step}
                value={transform[key][axis]}
                aria-label={`${label} ${["X", "Y", "Z"][axis]}`}
                onChange={(event) => {
                  const next = [...transform[key]] as [number, number, number];
                  const parsed = Number(event.target.value);
                  next[axis] = Number.isFinite(parsed) ? parsed : 0;
                  onChange({ [key]: next } as Partial<MeshTransform>);
                }}
                style={{ width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
              />
            ))}
          </div>
        </div>
      ))}
      <RailHint>
        {relative
          ? "Relative to the parent — the object moves, turns and scales with it."
          : "Placement in the cart world — applied when the mesh renders at runtime."}
      </RailHint>
    </RailGroup>
  );
}
