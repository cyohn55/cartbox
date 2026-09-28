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
  createLiveSkinnedMesh,
  isSkinned,
  sampleClip,
  skinMatrices,
  renderMesh,
  encodeObj,
  encodeGlb,
  meshBounds,
  meshVertexCount,
  meshTriangleCount,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  type MeshAsset,
  type DecodedTexture,
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
import { StreamingPanel, StreamingPicker } from "./StreamingPanel";
import { formatBytes } from "./assetUploads";
import { AnimationPanel, CodeHint, HierarchyPanel, ParentPicker, PhysicsPanel, PhysicsWorldPanel, PrefabLibrary, PrefabPanel, PropertyEditor, TagEditor } from "./SceneObjectPanels";

const VIEWPORT = 512; // preview canvas edge in device pixels
const ORBIT_SPEED = 0.01; // radians per pixel dragged
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;

interface MeshEditorProps {
  /** The cart's mesh sidecar (the list of imported meshes). */
  sidecar: MeshSidecar;
  /** Called with the next sidecar after any import, transform, rename, or delete. */
  onSidecarChange: (sidecar: MeshSidecar) => void;
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

export function MeshEditor({ sidecar, onSidecarChange }: MeshEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(sidecar.meshes[0]?.id ?? null);
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.4);
  const [zoom, setZoom] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [textures, setTextures] = useState<(DecodedTexture | null)[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** "solo" previews the selected mesh alone; "scene" composes every instance. */
  const [view, setView] = useState<"solo" | "scene">("solo");
  /** The skeletal clip the preview is playing (index), or null for the still mesh, and how far in. */
  const [previewClip, setPreviewClip] = useState<number | null>(null);
  const [clipTime, setClipTime] = useState(0);
  /** The Scene view's viewpoint (to key a timeline camera from), and a timeline moment previewed in it. */
  const [sceneView, setSceneView] = useState<ViewpointKey | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<TimelinePreview | null>(null);
  const onTimelinePreview = useCallback((preview: TimelinePreview | null) => {
    setTimelinePreview(preview);
    if (preview) setView("scene");
  }, []);

  // Keep the selection valid as the list changes (import selects the new mesh;
  // deleting the selected one falls back to the first remaining).
  useEffect(() => {
    if (selectedId && sidecar.meshes.some((entry) => entry.id === selectedId)) return;
    setSelectedId(sidecar.meshes[0]?.id ?? null);
  }, [sidecar, selectedId]);

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
    if (liveMesh && meshAsset.skin && clip) {
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
  }, [meshAsset, textures, yaw, pitch, zoom, buffers, sidecar.lighting, liveMesh, previewClip, clipTime]);

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
      const { sidecar: next, id } = addMesh(sidecar, asset, asset.name);
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
        ).toLocaleString()} vertices.${textures}`,
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
    const { sidecar: next, id } = addMesh(sidecar, mesh, asset.name);
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

        <HierarchyPanel sidecar={sidecar} selectedId={selectedId} onSelect={setSelectedId} />

        <PrefabLibrary sidecar={sidecar} onChange={onSidecarChange} onPlaced={setSelectedId} />
      </aside>

      {/* Centre: preview — the selected mesh alone, or the whole composed scene */}
      {view === "scene" ? (
        <SceneViewport
          sidecar={sidecar}
          onSidecarChange={onSidecarChange}
          selectedId={selectedId}
          onSelectId={setSelectedId}
          previewCamera={timelinePreview?.camera ?? null}
          previewLocals={timelinePreview?.locals ?? null}
          onView={setSceneView}
        />
      ) : (
      <section className={styles.mapStage}>
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
              <AnimationPanel mesh={meshAsset} name={selectedEntry.name} playing={previewClip} onPlay={setPreviewClip} />
            )}
            {meshAsset && isSkinned(meshAsset) && (
              <AnimatorPanel sidecar={sidecar} entry={selectedEntry} mesh={meshAsset} onChange={onSidecarChange} />
            )}
            <PhysicsPanel sidecar={sidecar} entry={selectedEntry} onChange={onSidecarChange} />

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
