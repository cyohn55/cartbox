"use client";

/**
 * The map seen from inside it: a navigable 3D view of the cart's
 * {@link MapVoxelSpace}, where cells are placed and removed on the face you point
 * at rather than raised as columns from above.
 *
 * Navigation is the point of the view, so it is bound three ways over the same
 * camera — drag to orbit, drag with a modifier (or the right button) to pan,
 * WASD/arrows to walk the focus through the map, wheel to zoom. The focus is a
 * cell coordinate the camera orbits about and the window is built around; moving
 * it is how you travel a map far larger than any one frame.
 *
 * It draws two ways. With WebGPU the built window is uploaded once per edit and
 * redrawn in hardware, at the stage's full size, with the material channels the
 * editor authors; without it the shared software rasteriser fills a fixed square
 * frame, as it always has. The two share a camera, so switching between them
 * changes only how sharp the picture is.
 *
 * Picking is exact rather than approximate. On the software path the rasteriser
 * already emits a per-pixel voxel + face buffer; on the hardware path the pointer
 * becomes a world ray and is marched through the same space. Either way a click
 * resolves to the face-local coordinates the pixel tools need to paint a single
 * texel of the sprite skinning the face you clicked, at the angle you see it.
 *
 * The space is the caller's, mutated in place and committed after each edit, the
 * same contract the top-down canvas has — so both views drive one store and an
 * edit made in either is immediately visible in the other.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  CUBE_FACES,
  DEFAULT_MODEL_LIGHT,
  HEXEL_GEOMETRY,
  MapVoxelSpace,
  castMapRay,
  geometryFor,
  isPlaneVoxel,
  mapSpaceToModel,
  orbitBasis,
  orthographicProjection,
  planeAxisOf,
  projectToScreen,
  renderVoxelModel,
  screenRay,
  type CellGeometry,
  type MapCellKind,
  type MapViewFocus,
  type MapWindow,
  type SpriteSheet,
  type TextureAtlas,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import type { PaintSurface } from "./paintSurface";
import { isPixelSpaceTool, type MapSpaceTool } from "./maptools";
import {
  applySpaceTool,
  targetOfTool,
  type SpacePick,
  type SpaceToolResult,
} from "./mapSpaceTools";
import { useLiveValue } from "./useLiveValue";
import { useMapGpu, type MapGpuStatus } from "./useMapGpu";
import { isChannelIsolated, type MaterialChannelView, type ShadingModel } from "./shadingModes";

/** Canvas edge in device pixels; also the pick buffers' resolution. */
const VIEWPORT = 640;

/** Sky behind the orbiting view, and what distance fades toward; each 0..1. */
const SKY: readonly [number, number, number] = [10 / 255, 13 / 255, 22 / 255];

/** How much an emissive texel bleeds into its surroundings. */
const BLOOM = 0.5;

/** Zoom, as output pixels per cell. */
const CELL_MIN = 3;
const CELL_MAX = 48;
const CELL_STEP = 2;

/** Pitch is clamped short of straight down so the horizon never inverts. */
const PITCH_MIN = -0.25;
const PITCH_MAX = 1.35;
const ORBIT_SPEED = 0.009; // radians per pixel dragged
const DRAG_THRESHOLD = 4; // px of movement before a press becomes a camera move

/** Bright wireframe colour of the cell the cursor is aiming at, per tool. */
const HIGHLIGHT: Record<MapSpaceTool, string> = {
  place: "#7dfcb6",
  remove: "#ff7b7b",
  paintCell: "#ffdd66",
  plane: "#9ad2ff",
  picker: "#c69dff",
  pencil: "#ffdd66",
  pixelFill: "#ffb066",
  pixelEraser: "#ff7b7b",
};

/** What the cursor is aiming at, for the HUD and the wireframe. */
export interface SpaceHover {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The cell the active tool would act on, which Place reads as the neighbour. */
  readonly target: readonly [number, number, number];
  readonly pick: SpacePick;
}

interface Map3DCanvasProps {
  sheet: SpriteSheet;
  /** The cart's map cells, mutated in place and committed after each edit. */
  space: MapVoxelSpace;
  /** World materials plus every tiles-page sprite; see `lib/mapAtlas`. */
  atlas: TextureAtlas;
  tool: MapSpaceTool;
  /** Palette index new and repainted cells take, and pixel strokes paint with. */
  colorIndex: number;
  /** Material armed for building, or {@link COLUMN_MATERIAL_NONE} for flat colour. */
  material: number;
  /** The orientation the Plane tool stands its quad in. */
  planeKind: MapCellKind;
  /** The sprite the pixel tools skin an unskinned cell with before painting it. */
  brushTile: number;
  /**
   * The surface pixel edits are written through — the composite material brush,
   * so a stroke on a face carries the colour's material profile exactly as a
   * stroke in the Sprites tab does.
   */
  pixels: PaintSurface;
  /** CSS colours of the cart palette, for rendering flat-coloured cells. */
  palette: readonly string[];
  /** Where the camera is standing. Lifted so the HUD and the 2D view can share it. */
  focus: MapViewFocus;
  onFocusChange: (focus: MapViewFocus) => void;
  /** Half-width of the built window, in cells. */
  radius: number;
  /** Camera orientation and zoom, owned by the caller so they survive a view swap. */
  yaw: number;
  pitch: number;
  cell: number;
  onCameraChange: (camera: { yaw: number; pitch: number; cell: number }) => void;
  /** Bumped when the cart's art changes, so the model and atlas rebuild. */
  version: number;
  /** A sprite's pixels changed; the caller re-reads derived state. */
  onEdit: () => void;
  /** Cells changed — the caller persists the space (one entry per action). */
  onSpaceCommitted: () => void;
  /** The Picker adopted a cell's look. */
  onPickStyle: (colorIndex: number, material: number) => void;
  onHover: (hover: SpaceHover | null) => void;
  /** Reports why a click did nothing, so the HUD can explain rather than stay silent. */
  onNote: (note: string | null) => void;
  /** Which renderer ended up drawing, so the rail can say so. */
  onRendererChange?: (status: MapGpuStatus) => void;
  /**
   * Shading model and isolated channel for the hardware view. Authoring aids,
   * not part of the cart: the software fallback ignores them, and the rail says
   * so rather than silently showing a lit frame under a "Normal" label.
   */
  shading?: ShadingModel;
  channel?: MaterialChannelView;
}

/** `#rrggbb` → 0..255 RGB triple, falling back to white on a malformed value. */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  if (Number.isNaN(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Projects a world point to canvas pixels — the renderer's camera, for overlays. */
type Project = (x: number, y: number, z: number) => [number, number];

/**
 * The renderer's own projection, rebuilt here so overlays land exactly on the
 * cells they annotate. It has to be the same arithmetic as `drawModelInto`'s, and
 * is small enough that sharing it would cost more indirection than it saves.
 */
function makeProject(yaw: number, pitch: number, cell: number, focus: MapViewFocus): Project {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const centre = VIEWPORT / 2;
  return (x, y, z) => {
    const wx = x - focus.x;
    const wy = y - focus.y;
    const wz = z - focus.z;
    const yawX = wx * cosYaw + wz * sinYaw;
    const yawZ = -wx * sinYaw + wz * cosYaw;
    const camY = wy * cosPitch - yawZ * sinPitch;
    return [centre + yawX * cell, centre - camY * cell];
  };
}

/** Stroke a closed polygon of already-projected points, with a soft glow. */
function strokePolygon(
  context: CanvasRenderingContext2D,
  points: readonly [number, number][],
  color: string,
  width: number,
): void {
  if (points.length < 2) return;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = width * 3;
  context.beginPath();
  points.forEach(([px, py], index) => (index === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
  context.closePath();
  context.stroke();
  context.restore();
}

/**
 * Outline a cell as a box wireframe. `half` is the extent on each axis, so a
 * plane — zero on the axis it stands across — draws as the flat rectangle it is,
 * through the same code path as a solid block.
 */
function drawBoxOutline(
  context: CanvasRenderingContext2D,
  project: Project,
  centre: readonly [number, number, number],
  half: readonly [number, number, number],
  color: string,
  lineWidth: number,
): void {
  const corners: [number, number][] = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push(
      project(
        centre[0] + (i & 1 ? half[0] : -half[0]),
        centre[1] + (i & 2 ? half[1] : -half[1]),
        centre[2] + (i & 4 ? half[2] : -half[2]),
      ),
    );
  }
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = lineWidth * 3;
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) {
      const diff = i ^ j;
      if (diff !== 1 && diff !== 2 && diff !== 4) continue; // box edges only
      context.beginPath();
      context.moveTo(corners[i]![0], corners[i]![1]);
      context.lineTo(corners[j]![0], corners[j]![1]);
      context.stroke();
    }
  }
  context.restore();
}

/** Outline a hexel's twelve rhombic faces — a box would misdescribe the cell. */
function drawHexelOutline(
  context: CanvasRenderingContext2D,
  project: Project,
  centre: readonly [number, number, number],
  color: string,
  lineWidth: number,
): void {
  for (const face of HEXEL_GEOMETRY.faces) {
    strokePolygon(
      context,
      face.corners.map((corner) => project(centre[0] + corner[0], centre[1] + corner[1], centre[2] + corner[2])),
      color,
      lineWidth,
    );
  }
}

export function Map3DCanvas({
  sheet,
  space,
  atlas,
  tool,
  colorIndex,
  material,
  planeKind,
  brushTile,
  pixels,
  palette,
  focus,
  onFocusChange,
  radius,
  yaw,
  pitch,
  cell,
  onCameraChange,
  version,
  onEdit,
  onSpaceCommitted,
  onPickStyle,
  onHover,
  onNote,
  onRendererChange,
  shading = "lit",
  channel = "shaded",
}: Map3DCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** The last rendered frame, so a hover change only redraws the overlay. */
  const frameRef = useRef<ImageData | null>(null);
  const hoverRef = useRef<SpaceHover | null>(null);
  const gpu = useMapGpu(atlas, version);
  const onGpu = gpu.status === "gpu";
  const activeCanvasRef = onGpu ? gpu.canvasRef : canvasRef;

  useEffect(() => {
    onRendererChange?.(gpu.status);
  }, [gpu.status, onRendererChange]);

  const geometry = useMemo<CellGeometry>(() => geometryFor(space.shape), [space.shape]);
  const paletteRgb = useCallback(
    (index: number): readonly [number, number, number] => hexToRgb(palette[index] ?? "#ffffff"),
    [palette],
  );

  // Fixed-size render + pick buffers: allocated once, independent of map size.
  const buffers = useMemo(
    () => ({
      out: new Uint8ClampedArray(VIEWPORT * VIEWPORT * 4),
      depth: new Float32Array(VIEWPORT * VIEWPORT),
      pickVoxel: new Int32Array(VIEWPORT * VIEWPORT),
      pickFace: new Int8Array(VIEWPORT * VIEWPORT),
      pickU: new Float32Array(VIEWPORT * VIEWPORT),
      pickV: new Float32Array(VIEWPORT * VIEWPORT),
    }),
    [],
  );

  // The window of the map that is actually built. Rebuilt when the space changes
  // (version), when the focus moves, or when the range control widens it.
  const model = useMemo(
    () => mapSpaceToModel(space, { palette: paletteRgb, focus, radius, geometry }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [space, version, focus.x, focus.y, focus.z, radius, geometry, paletteRgb],
  );

  /**
   * The window of columns that was actually built. A pick has to be held to it:
   * the map extends well past what the view drew, and a click near the frame's
   * edge must not act on a cell nobody can see.
   */
  const bounds = useMemo<MapWindow>(
    () => ({
      minX: Math.max(0, Math.floor(focus.x) - radius),
      maxX: Math.min(space.width - 1, Math.floor(focus.x) + radius),
      minZ: Math.max(0, Math.floor(focus.z) - radius),
      maxZ: Math.min(space.depth - 1, Math.floor(focus.z) + radius),
    }),
    [focus.x, focus.z, radius, space.depth, space.width],
  );

  const basis = useMemo(() => orbitBasis(yaw, pitch), [yaw, pitch]);

  /**
   * The orthographic slab, sized to hold the whole built window at any rotation.
   * Too shallow and the far half of your own landscape is clipped away.
   */
  const depthRange = useMemo(
    () => radius * 2 + space.maxHeight + 8,
    [radius, space.maxHeight],
  );

  /** The hardware projection for the canvas as it is currently sized. */
  const gpuProjection = useCallback(
    (canvas: HTMLCanvasElement) =>
      orthographicProjection({
        // `cell` is stated in CSS pixels, and the canvas is drawn in device ones.
        cell: cell * (canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1),
        width: canvas.width,
        height: canvas.height,
        range: depthRange,
      }),
    [cell, depthRange],
  );

  /** The software frame's projection, in its fixed square of pixels. */
  const projectFixed = useMemo(() => makeProject(yaw, pitch, cell, focus), [yaw, pitch, cell, focus]);

  /** The same projection over the hardware frame, in that canvas's own pixels. */
  const gpuProject = useCallback(
    (canvas: HTMLCanvasElement): Project => {
      const projection = gpuProjection(canvas);
      return (x, y, z) => {
        const at = projectToScreen([0, 0, 0], basis, projection, [x - focus.x, y - focus.y, z - focus.z]);
        return [at.x * canvas.width, at.y * canvas.height];
      };
    },
    [basis, focus.x, focus.y, focus.z, gpuProjection],
  );

  /**
   * The model-space corners of a picked face, with a plane's collapsed along its
   * axis exactly as the renderer collapses it — the basis every overlay and the
   * texel lookup are expressed in.
   */
  const faceCorners = useCallback(
    (pick: SpacePick): [number, number, number][] => {
      const faces = pick.plane ? CUBE_FACES : geometry.faces;
      const face = faces[pick.face];
      if (!face) return [];
      // A plane's quad is collapsed along whichever axis its face normal runs on.
      const axis = pick.plane ? face.normal.findIndex((component) => component !== 0) : -1;
      return face.corners.map((corner) => [
        pick.x + (axis === 0 ? 0 : corner[0]!),
        pick.y + (axis === 1 ? 0 : corner[1]!),
        pick.z + (axis === 2 ? 0 : corner[2]!),
      ]);
    },
    [geometry],
  );

  /**
   * Blit the last render and stroke the cursor overlay over it.
   *
   * On the hardware path the frame is already on screen and the overlay lives on
   * its own transparent canvas — a WebGPU canvas has no 2D context to stroke into
   * — so the two paths differ only in which surface is drawn on and at what
   * scale. Everything after that is one piece of code.
   */
  const paint = useCallback(() => {
    let context: CanvasRenderingContext2D | null = null;
    let project: Project;
    let scale = 1;

    if (onGpu) {
      const overlay = overlayRef.current;
      const canvas = gpu.canvasRef.current;
      context = overlay?.getContext("2d") ?? null;
      if (!overlay || !canvas || !context) return;
      context.clearRect(0, 0, overlay.width, overlay.height);
      project = gpuProject(canvas);
      scale = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    } else {
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      context = canvas?.getContext("2d") ?? null;
      if (!canvas || !frame || !context) return;
      context.putImageData(frame, 0, 0);
      project = projectFixed;
    }

    const hover = hoverRef.current;
    if (!hover) return;
    const color = HIGHLIGHT[tool];
    const lineWidth = Math.max(1.5, cell * 0.1) * scale;

    if (isPixelSpaceTool(tool)) {
      // Outline the face, then the single texel the stroke would land on — the
      // difference between painting where you are looking and painting blind.
      const corners = faceCorners(hover.pick);
      if (corners.length === 4) {
        strokePolygon(context, corners.map(([x, y, z]) => project(x, y, z)), color, lineWidth * 0.6);
        const size = sheet.tileSize;
        const u0 = Math.floor(hover.pick.u * size) / size;
        const v0 = Math.floor(hover.pick.v * size) / size;
        const step = 1 / size;
        const at = (u: number, v: number): [number, number] => {
          const point: [number, number, number] = [0, 0, 0];
          for (let axis = 0; axis < 3; axis += 1) {
            point[axis] =
              corners[0]![axis]! +
              u * (corners[1]![axis]! - corners[0]![axis]!) +
              v * (corners[3]![axis]! - corners[0]![axis]!);
          }
          return project(point[0], point[1], point[2]);
        };
        strokePolygon(
          context,
          [at(u0, v0), at(u0 + step, v0), at(u0 + step, v0 + step), at(u0, v0 + step)],
          color,
          lineWidth,
        );
      }
      return;
    }

    const [tx, ty, tz] = hover.target;
    const planing = tool === "plane";
    if (space.shape === "hexel" && !planing) {
      drawHexelOutline(context, project, [tx, ty, tz], color, lineWidth);
    } else {
      // A plane previews as the flat quad it will actually stand: zero extent on
      // the axis it faces along. A cross stands two, so it keeps its full box.
      const axis = planing ? planeAxisOf(planeKind) : -1;
      const half: [number, number, number] = [0.5, 0.5, 0.5];
      if (axis >= 0) half[axis] = 0;
      drawBoxOutline(context, project, [tx, ty, tz], half, color, lineWidth);
    }
  }, [tool, cell, faceCorners, gpu.canvasRef, gpuProject, onGpu, projectFixed, sheet.tileSize, space.shape, planeKind]);

  // Rendering the window is the expensive step, so it is kept off the overlay's
  // path: changing tool or hover only re-blits the frame and re-strokes the
  // cursor, and the model is rebuilt only when the camera or the map moves.
  const paintRef = useRef(paint);
  paintRef.current = paint;

  /** Fit the hardware canvas and its overlay to the stage, in device pixels. */
  useEffect(() => {
    if (!onGpu) return;
    const canvas = gpu.canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      const overlay = overlayRef.current;
      if (overlay && (overlay.width !== width || overlay.height !== height)) {
        overlay.width = width;
        overlay.height = height;
      }
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      drawRef.current();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [gpu.canvasRef, onGpu]);

  // Upload the built window whenever it changes. This is the work the GPU path
  // trades for: once per edit or camera move, rather than once per frame.
  useEffect(() => {
    if (!onGpu) return;
    gpu.uploadModel(model);
  }, [gpu, model, onGpu]);

  /** Draw one hardware frame at the canvas's current size. */
  const drawGpu = useCallback(() => {
    const canvas = gpu.canvasRef.current;
    if (!canvas) return;
    gpu.draw({
      // The model is already expressed relative to the focus, so the eye sits at
      // the origin and the camera is pure rotation.
      eye: [0, 0, 0],
      basis,
      projection: gpuProjection(canvas),
      light: DEFAULT_MODEL_LIGHT,
      sky: SKY,
      // Orbiting looks at the whole build from outside, where haze would only
      // grey it out; the window's edge is a visible slice, and that is honest.
      fogDistance: 0,
      // An isolated channel is a measurement, not a picture: bloom would bleed
      // one texel's value into its neighbours and make the readout a lie.
      bloom: isChannelIsolated(channel) ? 0 : BLOOM,
      shading,
      channel,
    });
    paintRef.current();
  }, [basis, channel, gpu, gpuProjection, shading]);
  const drawRef = useRef(drawGpu);
  drawRef.current = drawGpu;

  useEffect(() => {
    if (!onGpu) return;
    drawGpu();
  }, [drawGpu, model, onGpu]);

  // The software path: rasterise into the fixed square frame and blit it.
  useEffect(() => {
    if (onGpu) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = VIEWPORT;
    canvas.height = VIEWPORT;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderVoxelModel(model, {
      yaw,
      pitch,
      cell,
      size: VIEWPORT,
      light: DEFAULT_MODEL_LIGHT,
      atlas,
      out: buffers.out,
      depthBuffer: buffers.depth,
      pickVoxel: buffers.pickVoxel,
      pickFace: buffers.pickFace,
      pickU: buffers.pickU,
      pickV: buffers.pickV,
    });
    const frame = context.createImageData(VIEWPORT, VIEWPORT);
    frame.data.set(buffers.out);
    frameRef.current = frame;
    paintRef.current();
  }, [model, yaw, pitch, cell, atlas, buffers, onGpu]);

  useEffect(() => {
    paint();
  }, [paint]);

  /**
   * Resolve a canvas position to the cell and face under it.
   *
   * The software path reads its own pick buffers. The hardware path has none, so
   * the pointer becomes a world ray and is marched through the space — held to
   * the window that was actually built, so a click can only reach what was drawn.
   */
  const pickAt = (clientX: number, clientY: number): SpacePick | null => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;

    if (onGpu) {
      const ray = screenRay(
        [focus.x, focus.y, focus.z],
        basis,
        orthographicProjection({ cell, width: rect.width, height: rect.height, range: depthRange }),
        fx,
        fy,
      );
      const hit = castMapRay(space, ray.origin, ray.direction, {
        atlas,
        maxDistance: depthRange * 2,
        bounds,
      });
      if (!hit) return null;
      const struck = space.cellAt(hit.x, hit.y, hit.z);
      return {
        x: hit.x,
        y: hit.y,
        z: hit.z,
        face: hit.face,
        u: hit.u,
        v: hit.v,
        plane: struck !== null && struck.kind !== "solid",
      };
    }

    const px = Math.floor(fx * VIEWPORT);
    const py = Math.floor(fy * VIEWPORT);
    const index = py * VIEWPORT + px;
    const voxel = buffers.pickVoxel[index]!;
    if (voxel < 0) return null; // empty space
    const [x, y, z] = space.coordsOf(model.gridIndex[voxel]!);
    return {
      x,
      y,
      z,
      face: buffers.pickFace[index]!,
      u: buffers.pickU[index]!,
      v: buffers.pickV[index]!,
      plane: isPlaneVoxel(model, voxel),
    };
  };

  /** Everything the shared tools need besides where the pointer was aimed. */
  const toolContext = () => ({
    space,
    tileSize: sheet.tileSize,
    tilesPerPage: sheet.tilesPerPage,
    pixels,
    colorIndex,
    material,
    planeKind,
    brushTile,
  });

  /** Route a tool's report to the caller: persist, redraw, arm, explain. */
  const report = (result: SpaceToolResult) => {
    if (result.picked) onPickStyle(result.picked.colorIndex, result.picked.material);
    if (result.changedCells) onSpaceCommitted();
    else if (result.changedPixels) onEdit();
    onNote(result.note);
  };

  /** The cell the active tool would act on. */
  const targetOf = (pick: SpacePick): [number, number, number] => targetOfTool(tool, space, pick);

  /** Apply the active tool at a canvas position. The secondary button removes. */
  const applyAt = (clientX: number, clientY: number, secondary: boolean) => {
    const pick = pickAt(clientX, clientY);
    if (!pick) {
      onNote("Nothing under the cursor — aim at a cell.");
      return;
    }
    report(applySpaceTool(tool, pick, secondary, toolContext()));
  };

  /**
   * Whether two hovers would draw the same cursor. The pixel tools highlight a
   * single texel, so for them the face-local position matters and moving within
   * one face is a change; for the building tools only the cell and face are.
   */
  const sameHover = (a: SpaceHover | null, b: SpaceHover | null): boolean => {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a.pick.x !== b.pick.x || a.pick.y !== b.pick.y || a.pick.z !== b.pick.z) return false;
    if (a.pick.face !== b.pick.face) return false;
    if (!isPixelSpaceTool(tool)) return true;
    const size = sheet.tileSize;
    return (
      Math.floor(a.pick.u * size) === Math.floor(b.pick.u * size) &&
      Math.floor(a.pick.v * size) === Math.floor(b.pick.v * size)
    );
  };

  const setHover = (hover: SpaceHover | null) => {
    if (sameHover(hoverRef.current, hover)) return;
    hoverRef.current = hover;
    onHover(hover);
    paint();
  };

  // --- Camera and travel -----------------------------------------------------
  // Both the camera and the focus are written far faster than React re-renders —
  // a drag is dozens of pointer events per commit, and a held key repeats — so
  // both go through a live value. Computing each step from the prop instead means
  // every event after the first in a frame starts from the same stale angle, and
  // all but the last one's movement is thrown away: a fast drag turns a fraction
  // of what the hand asked for. See useLiveValue.
  const [, updateCamera] = useLiveValue(
    useMemo(() => ({ yaw, pitch, cell }), [yaw, pitch, cell]),
    onCameraChange,
    (a, b) => a.yaw === b.yaw && a.pitch === b.pitch && a.cell === b.cell,
  );
  const [, updateFocus] = useLiveValue(
    focus,
    onFocusChange,
    (a, b) => a.x === b.x && a.y === b.y && a.z === b.z,
  );

  const moveFocus = (right: number, forward: number, up: number) => {
    updateFocus((current) => {
      // Screen-right and screen-forward on the ground plane, from the current
      // yaw — what "move me that way" means once the camera has been turned.
      const x = current.x + Math.cos(yaw) * right - Math.sin(yaw) * forward;
      const z = current.z + Math.sin(yaw) * right + Math.cos(yaw) * forward;
      return {
        x: Math.max(0, Math.min(space.width - 1, x)),
        y: Math.max(0, Math.min(space.maxHeight - 1, current.y + up)),
        z: Math.max(0, Math.min(space.depth - 1, z)),
      };
    });
  };

  const drag = useRef<{ lastX: number; lastY: number; moved: boolean; button: number; pan: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    // The travel keys are bound to the canvas, so a press has to focus it or
    // WASD would go nowhere until the user found the canvas with Tab.
    event.currentTarget.focus();
    drag.current = {
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      button: event.button,
      // Middle button, or Shift/Space with any button, pans instead of orbiting.
      pan: event.button === 1 || event.shiftKey,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (state) {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!state.moved) setHover(null); // this press became a camera move, not a click
      state.moved = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      if (state.pan) {
        // Drag the world under the cursor: the scene follows the pointer, so the
        // focus travels the other way. Vertical drags are divided by how steeply
        // the camera looks down, since a shallow pitch foreshortens the ground —
        // floored so a near-horizontal view pans at a sane rate instead of leaping.
        const foreshorten = Math.max(0.25, Math.sin(pitch));
        moveFocus(-dx / cell, -dy / (cell * foreshorten), 0);
      } else {
        updateCamera((current) => ({
          yaw: current.yaw - dx * ORBIT_SPEED,
          pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, current.pitch + dy * ORBIT_SPEED)),
          cell: current.cell,
        }));
      }
      return;
    }
    const pick = pickAt(event.clientX, event.clientY);
    setHover(pick ? { x: pick.x, y: pick.y, z: pick.z, target: targetOf(pick), pick } : null);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) applyAt(event.clientX, event.clientY, state.button === 2);
  };

  // Wheel zoom without letting the page scroll under the cursor. React's onWheel
  // is passive and cannot preventDefault, so bind a native listener.
  useEffect(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      updateCamera((current) => ({
        ...current,
        cell: Math.max(CELL_MIN, Math.min(CELL_MAX, current.cell - Math.sign(event.deltaY) * CELL_STEP)),
      }));
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [activeCanvasRef, updateCamera]);

  // Walk the focus with the keyboard. Bound to the canvas rather than the window
  // so it never eats typing elsewhere in the editor; the canvas is focusable and
  // takes focus on pointer-down.
  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const step = event.shiftKey ? 4 : 1;
    const moves: Record<string, [number, number, number]> = {
      w: [0, step, 0],
      arrowup: [0, step, 0],
      s: [0, -step, 0],
      arrowdown: [0, -step, 0],
      a: [-step, 0, 0],
      arrowleft: [-step, 0, 0],
      d: [step, 0, 0],
      arrowright: [step, 0, 0],
      e: [0, 0, step],
      pageup: [0, 0, step],
      q: [0, 0, -step],
      pagedown: [0, 0, -step],
    };
    const move = moves[event.key.toLowerCase()];
    if (!move) return;
    event.preventDefault();
    moveFocus(move[0], move[1], move[2]);
  };

  const label = `Map in 3D, ${space.width} by ${space.depth} cells. Drag to orbit, shift-drag to pan, W A S D to move, Q and E for height.`;
  const pointerProps = {
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: () => (drag.current = null),
    onPointerLeave: () => setHover(null),
    onKeyDown,
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
    role: "application",
    "aria-label": label,
  } as const;

  return (
    <div className={styles.spaceViewport}>
      <div className={styles.spaceStack}>
        {/* Both canvases exist from the first render: a WebGPU context can only
            be taken from a canvas that has never had a 2D one, so which renderer
            draws cannot be decided after the element is created. */}
        <canvas ref={gpu.canvasRef} className={styles.gpuCanvas} hidden={!onGpu} {...pointerProps} />
        <canvas
          ref={canvasRef}
          className={styles.spaceCanvas}
          hidden={onGpu}
          width={VIEWPORT}
          height={VIEWPORT}
          {...pointerProps}
        />
        {onGpu && <canvas ref={overlayRef} className={styles.overlayCanvas} aria-hidden />}
      </div>
    </div>
  );
}
