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

import { useEffect, useMemo, useRef, useState } from "react";

import {
  renderMesh,
  encodeObj,
  encodeGlb,
  meshBounds,
  meshVertexCount,
  meshTriangleCount,
  type MeshAsset,
  type DecodedTexture,
} from "@cartbox/editor";

import {
  addMesh,
  removeMesh,
  renameMesh,
  setMeshTransform,
  readMeshEntry,
  type MeshSidecar,
  type MeshTransform,
} from "@/lib/meshSidecar";
import { importMeshFile, decodeMeshTextures } from "@/lib/meshImport";
import { fetchLibraryMesh } from "@/lib/libraryClient";
import type { LibraryAsset } from "@/lib/libraryManifest";
import styles from "./editor.module.css";
import { RailGroup, RailHint } from "./railControls";
import { LibraryBrowser } from "./LibraryBrowser";

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

    renderMesh(meshAsset, {
      camera: { yaw, pitch, distance: fitDistance(meshAsset) * zoom },
      size: VIEWPORT,
      out: buffers.out,
      depth: buffers.depth,
      textures: textures ?? undefined,
      background: [14, 16, 26, 255],
    });
    const image = context.createImageData(VIEWPORT, VIEWPORT);
    image.data.set(buffers.out);
    context.putImageData(image, 0, 0);
  }, [meshAsset, textures, yaw, pitch, zoom, buffers]);

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
      const asset = await importMeshFile(primary, all.filter((file) => file !== primary));
      const { sidecar: next, id } = addMesh(sidecar, asset, asset.name);
      onSidecarChange(next);
      setSelectedId(id);
      setNote(
        `Imported “${asset.name}” — ${meshTriangleCount(asset).toLocaleString()} triangles, ${meshVertexCount(
          asset,
        ).toLocaleString()} vertices.`,
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
          <RailHint>OBJ, glTF, or GLB. For OBJ, select its .mtl alongside to keep colours.</RailHint>
          {note && <RailHint>{note}</RailHint>}
        </RailGroup>

        <RailGroup label={`Meshes · ${sidecar.meshes.length}`}>
          {sidecar.meshes.length === 0 ? (
            <RailHint>No meshes yet. Import one above.</RailHint>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {sidecar.meshes.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={styles.toolBtn}
                  onClick={() => setSelectedId(entry.id)}
                  style={{
                    justifyContent: "flex-start",
                    outline: entry.id === selectedId ? "2px solid #7db8fc" : "none",
                  }}
                  title={entry.name}
                >
                  <span
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 190 }}
                  >
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </RailGroup>
      </aside>

      {/* Centre: preview */}
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

            <TransformControls transform={selectedEntry.transform} onChange={updateTransform} />

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
}: {
  transform: MeshTransform;
  onChange: (patch: Partial<MeshTransform>) => void;
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
      <RailHint>Placement in the cart world — applied when the mesh renders at runtime.</RailHint>
    </RailGroup>
  );
}
