"use client";

/**
 * Map editor: owns the map's editing state — which layer is active, its tool,
 * the brush, the zoom, the camera — and lays out the tool rail, the map stage,
 * and the inspector.
 *
 * The map is authored on four layers over one grid: tiles, the pixels inside
 * those tiles, and a cell layer that gives the map height as cubes or hexels.
 * All of them share the cart's SpriteSheet and TileMap, so art drawn in the
 * Sprites tab is immediately stampable here and a pixel touched up here shows up
 * there. Any of the four can also be filled procedurally: the generators produce
 * classes, and the mapping panel says what a class means on the active layer.
 *
 * The stage shows the map from one of two vantage points, and the toggle between
 * them is the only thing that changes — both views drive the same
 * {@link MapVoxelSpace}, so nothing is lost or converted by switching:
 *
 * - **2D** looks straight down and edits stacks as columns: raise, lower,
 *   flatten, paint. It is how terrain and ground plans are laid out quickly.
 * - **3D** puts you inside the map, where a cell is placed against the face you
 *   point at and removed by clicking it. That is what overhangs, caves, bridges
 *   and standing sprite planes need, none of which a column can describe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CollisionMap,
  MapVoxelSpace,
  MaterialMap,
  NormalMap,
  gradientSortOrder,
  isMaterialSwatchEnabled,
  materialProfileAt,
  COLUMN_MATERIAL_NONE,
  MAP_GENERATORS,
  MAX_MAP_VOXEL_HEIGHT,
  applyFieldToColumns,
  applyFieldToPixels,
  applyFieldToTiles,
  defaultClassMapping,
  defaultValues,
  findGenerator,
  loadMapVoxelSpace,
  mapColumnTarget,
  serializeMapVoxelSpace,
  type ClassField,
  type ClassInfo,
  type ClassMapping,
  type CollisionData,
  type GeneratorValues,
  type MapCellKind,
  type MapViewFocus,
  type MaterialSwatches,
  type SpriteSheet,
  type TileMap,
} from "@cartbox/editor";

import { worldSurfaceMaterial } from "@/lib/faceTextures";
import { buildMapAtlas, materialSpriteTile, spriteTileMaterial } from "@/lib/mapAtlas";
import styles from "./editor.module.css";
import { ClassMappingEditor } from "./ClassMappingEditor";
import { FieldPreview } from "./FieldPreview";
import { GeneratorPanel } from "./GeneratorPanel";
import { Map3DCanvas, type SpaceHover } from "./Map3DCanvas";
import { MapCanvas } from "./MapCanvas";
import { MapWalkCanvas, type WalkHover } from "./MapWalkCanvas";
import { standOnGround, type WalkCamera } from "./walkCamera";
import type { MapGpuStatus } from "./useMapGpu";
import { MaterialPicker } from "./MaterialPicker";
import { PalettePicker } from "./PalettePicker";
import { RailGroup, RailHint, RangeControl, SegmentedControl, ToolRail } from "./railControls";
import {
  CHANNEL_VIEWS,
  SHADING_MODELS,
  channelHint,
  shadingHint,
  type MaterialChannelView,
  type ShadingModel,
} from "./shadingModes";
import {
  InspectorHint,
  WorkbenchInspector,
  WorkbenchRail,
  type InspectorSlots,
  type RailSlots,
} from "./workbenchPanels";
import { MaterialSurface, NormalSurface } from "./paintSurface";
import { MaterialBrushSurface } from "./materialBrushSurface";
import { TilePicker } from "./TilePicker";
import { singleTileBrush, type MapBrush } from "./mapBrush";
import {
  MAP_CAMERA_MODES,
  MAP_LAYERS,
  MAP_VIEW_MODES,
  MAP_ZOOMS,
  WALK_DETAIL_LEVELS,
  PIXEL_ZOOM_INDEX,
  PLANE_KINDS,
  defaultSpaceToolFor,
  defaultToolFor,
  isColumnLayer,
  isFlatLayer,
  isPixelSpaceTool,
  layerDef,
  shapeForLayer,
  spaceLayerFor,
  spaceToolsFor,
  type MapCameraMode,
  type MapLayer,
  type MapSpaceTool,
  type MapTool,
  type MapViewMode,
} from "./maptools";

/** The tiles page the map stamps from. */
const TILES_PAGE = 0;

/** The zoom levels as the rail selects them — by index, which is what `zoom` holds. */
const ZOOM_OPTIONS = MAP_ZOOMS.map((option, index) => ({ id: index, label: option.label }));

/**
 * How far the 3D view builds around the camera, as the rail offers it. A map is
 * far larger than any one frame, so the window is what bounds the cost of a
 * rebuild; the options trade how much of the world you can see against how
 * quickly it redraws while you move.
 */
const RANGE_OPTIONS = [
  { id: 8, label: "S", hint: "17 cells across — fastest, for close detail work." },
  { id: 16, label: "M", hint: "33 cells across." },
  { id: 24, label: "L", hint: "49 cells across." },
  { id: 32, label: "XL", hint: "65 cells across — the widest view, and the slowest." },
];

/**
 * The camera the 3D view opens with: a raised three-quarter look at the ground,
 * zoomed close enough that individual cells are comfortably clickable rather than
 * a distant speck. The wheel takes it from there.
 */
const DEFAULT_CAMERA = { yaw: 0.7, pitch: 0.62, cell: 22 };

/** How far down the first-person camera looks when you first step into the map. */
const WALK_ENTRY_PITCH = -0.35;

/**
 * Convert between the two cameras' headings.
 *
 * They describe opposite things with the same number: the orbit camera's yaw is
 * the angle it has swung *around* the focus, so it looks back along `(sin yaw, 0,
 * -cos yaw)`, while the walking camera's yaw is the direction it faces, `(sin yaw,
 * 0, cos yaw)`. Reflecting through π is what makes stepping between them continue
 * the same view instead of spinning you round to face the way you came.
 *
 * Its own inverse, so one function serves both directions.
 */
function walkYawOf(yaw: number): number {
  return Math.PI - yaw;
}

interface MapEditorProps {
  sheet: SpriteSheet;
  map: TileMap;
  /** The saved map cells for this cart, or null when none were authored. */
  columnPayload: string | null;
  /** Persist the map cells (feeds the undo timeline and the save). */
  onColumnsChange: (serialized: string) => void;
  /** The saved collision layer for this cart, or null when none was authored. */
  collision: CollisionData | null;
  /** Persist the collision layer (feeds the undo timeline and the save). */
  onCollisionChange: (data: CollisionData | null) => void;
  /**
   * The cart's material channels. The pixel layer paints through them exactly as
   * the Sprites tab's Material layer does, so a colour with a swatch profile
   * stamps its normal, height, specular, roughness and emissive here too rather
   * than writing bare albedo.
   */
  normals: NormalMap;
  height: MaterialMap;
  specular: MaterialMap;
  roughness: MaterialMap;
  emissive: MaterialMap;
  swatches: MaterialSwatches;
}

export function MapEditor({
  sheet,
  map,
  columnPayload,
  onColumnsChange,
  collision,
  onCollisionChange,
  normals,
  height: heightMap,
  specular,
  roughness,
  emissive,
  swatches,
}: MapEditorProps) {
  // The cell space is the source of truth for everything above the ground; it is
  // seeded once from the cart and handed back up serialized after every action.
  // Payloads saved before free-form cells existed are column layers, which
  // `loadMapVoxelSpace` upgrades on the way in — and which are written back out
  // unchanged for as long as the map stays columnar.
  const spaceRef = useRef<MapVoxelSpace | null>(null);
  if (spaceRef.current === null) {
    spaceRef.current = loadMapVoxelSpace(columnPayload, map.width, map.height);
  }

  // The collision layer is seeded once from the cart and mutated in place; the
  // serialized form is handed back up after every stroke. Sized to the map, so a
  // payload saved at another size is remapped onto the current grid on the way in.
  const collisionRef = useRef<CollisionMap | null>(null);
  if (collisionRef.current === null) {
    collisionRef.current = CollisionMap.deserialize(collision, map.width, map.height);
  }
  const collisionMap = collisionRef.current;

  const [view, setView] = useState<MapViewMode>("top");
  const [layer, setLayer] = useState<MapLayer>("tiles");
  const [tool, setTool] = useState<MapTool>(() => defaultToolFor("tiles"));
  const [spaceTool, setSpaceTool] = useState<MapSpaceTool>(() => defaultSpaceToolFor("voxels"));
  const [brush, setBrush] = useState<MapBrush>(() => singleTileBrush(2));
  const [colorIndex, setColorIndex] = useState(1);
  const [columnStep, setColumnStep] = useState(1);
  // The material armed for the cell tools, or "flat" for plain palette colour.
  const [columnMaterial, setColumnMaterial] = useState<number>(COLUMN_MATERIAL_NONE);
  const [planeKind, setPlaneKind] = useState<MapCellKind>("cross");
  const [zoom, setZoom] = useState(1);
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [spaceHover, setSpaceHover] = useState<SpaceHover | null>(null);
  const [spaceNote, setSpaceNote] = useState<string | null>(null);

  // Where the 3D camera stands and how it looks. Held here rather than in the
  // canvas so switching to the top-down view and back returns you to the same
  // place, and so the HUD can report it.
  const [focus, setFocus] = useState<MapViewFocus>(() => ({
    x: Math.floor(map.width / 2),
    y: 2,
    z: Math.floor(map.height / 2),
  }));
  const [camera, setCamera] = useState(DEFAULT_CAMERA);
  const [radius, setRadius] = useState(16);
  // How the orbit view shades, and which channel it isolates. Authoring state:
  // it is never persisted with the cart, because it changes what you see and
  // nothing about what you built.
  const [shading, setShading] = useState<ShadingModel>("lit");
  const [channel, setChannel] = useState<MaterialChannelView>("shaded");

  // The first-person camera is its own thing: it has a position in the world
  // rather than a point it circles, so switching between orbiting and walking
  // must not try to reinterpret one as the other. Each keeps its own place, and
  // stepping between them carries the position across (see selectCameraMode).
  const [cameraMode, setCameraMode] = useState<MapCameraMode>("orbit");
  const [walk, setWalk] = useState<WalkCamera>(() => ({
    x: Math.floor(map.width / 2),
    y: 4,
    z: Math.floor(map.height / 2),
    yaw: 0.7,
    pitch: -0.15,
  }));
  const [walkDetail, setWalkDetail] = useState(WALK_DETAIL_LEVELS[1]!.id);
  const [walkHover, setWalkHover] = useState<WalkHover | null>(null);
  // Which renderer the 3D stage settled on. Worth surfacing rather than hiding:
  // the controls that only matter to the software path (its render resolution)
  // are meaningless on the hardware one, and an author who is quietly on the slow
  // path deserves to be told why it is slow.
  const [renderer, setRenderer] = useState<MapGpuStatus>("probing");

  // Generator state: which one, its values, and how its classes map onto the
  // active layer. The mapping is per generator, so switching back to one you
  // tuned earlier restores what you set up.
  const [generatorId, setGeneratorId] = useState(MAP_GENERATORS[0]!.id);
  const generator = findGenerator(MAP_GENERATORS, generatorId);
  const [values, setValues] = useState<GeneratorValues>(() => defaultValues(MAP_GENERATORS[0]!.params));
  // Each class opens mapped to the nearest colour the cart's palette holds *and*
  // to the world atlas material its surface names, so a generated landscape
  // arrives both plausibly coloured and properly skinned.
  const paletteMapping = useCallback(
    (legend: readonly ClassInfo[]) =>
      defaultClassMapping(legend, {
        nearestColor: ([r, g, b]) => sheet.nearestColorIndex(r, g, b),
        materialFor: worldSurfaceMaterial,
      }),
    [sheet],
  );
  const [mappings, setMappings] = useState<Record<string, ClassMapping[]>>(() => ({
    [MAP_GENERATORS[0]!.id]: defaultClassMapping(MAP_GENERATORS[0]!.legend, {
      nearestColor: ([r, g, b]) => sheet.nearestColorIndex(r, g, b),
      materialFor: worldSurfaceMaterial,
    }),
  }));
  const [generateNote, setGenerateNote] = useState<string | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);

  // The pixel layer writes through the same composite brush the Sprites tab's
  // Material layer uses, so one stroke here stamps albedo *and* the colour's
  // normal/height/specular/roughness/emissive profile. Reading the swatches
  // through a ref keeps the surface identity stable while they are edited.
  const swatchesRef = useRef(swatches);
  swatchesRef.current = swatches;
  const pixelSurface = useMemo(
    () =>
      new MaterialBrushSurface(
        sheet,
        {
          normal: new NormalSurface(normals, sheet.tileSize),
          height: new MaterialSurface(heightMap, sheet.tileSize),
          specular: new MaterialSurface(specular, sheet.tileSize),
          roughness: new MaterialSurface(roughness, sheet.tileSize),
          emissive: new MaterialSurface(emissive, sheet.tileSize),
        },
        (index) => materialProfileAt(swatchesRef.current, index),
      ),
    [sheet, normals, heightMap, specular, roughness, emissive],
  );

  const space = spaceRef.current!;
  const definition = layerDef(layer);
  const cell = (MAP_ZOOMS[zoom] ?? MAP_ZOOMS[1])!.cell;
  const palette = useMemo(() => sheet.cssPalette(), [sheet, version]);
  // Gradient ordering was a sprite-editor-only affordance; the map paints with
  // the same palette and had no way to read it. Display order only — the indices
  // under the chips, and everything stored, are untouched.
  const [sortPalette, setSortPalette] = useState(true);
  const paletteOrder = useMemo(
    () => (sortPalette ? gradientSortOrder(palette) : undefined),
    [sortPalette, palette],
  );
  // Colours that stamp a whole material profile when painted with. The map's
  // pixel tools paint through the same composite brush the sprite editor uses,
  // so the same colours behave the same way here — and the palette should say so
  // in both places rather than only in the tab where the binding is authored.
  const materialColors = useMemo(() => {
    const marked = new Set<number>();
    for (let index = 0; index < sheet.paletteSize; index += 1) {
      if (isMaterialSwatchEnabled(swatches, index)) marked.add(index);
    }
    return marked;
  }, [swatches, sheet.paletteSize]);
  const mapping = mappings[generator.id] ?? paletteMapping(generator.legend);
  const bump = () => setVersion((current) => current + 1);
  const screen = hover ? map.screenOf(hover.x, hover.y) : null;
  const inSpace = view === "space";
  // A flat layer (collision) has no palette, material, tile or generator — it is
  // pure per-cell solidity — so the inspector drops those controls for it.
  const flat = isFlatLayer(layer);
  const walking = inSpace && cameraMode === "walk";
  const spaceTools = spaceToolsFor(layer, space.shape);
  // Where the active 3D view says you are aiming — the two cameras report the
  // same thing about different pointers, so the HUD reads one of them.
  const aiming = walking ? walkHover : spaceHover;

  // The atlas the 3D view samples: the world's materials plus every sprite on the
  // tiles page, each carrying whatever the cart's Material layer painted onto it.
  // That last part is what lets a surface authored in the Sprites tab arrive in
  // the world as a *material* — its normals, height, gloss and glow intact —
  // rather than as flat colour the renderer has to guess about. Rebuilt when the
  // art changes, so a texture painted on a face shows on every cell wearing it.
  const channels = useMemo(
    () => ({
      levels: heightMap.levels,
      normalDirection: (page: 0 | 1, tile: number, x: number, y: number) =>
        normals.getDirection(page, tile, x, y),
      height: (page: 0 | 1, tile: number, x: number, y: number) => heightMap.getValue(page, tile, x, y),
      specular: (page: 0 | 1, tile: number, x: number, y: number) => specular.getValue(page, tile, x, y),
      roughness: (page: 0 | 1, tile: number, x: number, y: number) => roughness.getValue(page, tile, x, y),
      emissive: (page: 0 | 1, tile: number, x: number, y: number) => emissive.getValue(page, tile, x, y),
    }),
    [normals, heightMap, specular, roughness, emissive],
  );
  const atlas = useMemo(
    () => buildMapAtlas(sheet, channels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, channels, version],
  );

  /** Serialize the cells up to the cart after an edit or a generate run. */
  const commitSpace = () => {
    onColumnsChange(serializeMapVoxelSpace(space));
    bump();
  };

  /**
   * Serialize the collision layer up to the cart after a stroke. An empty layer
   * is stored as null so a cart that ends up with no collision keeps a clean row
   * rather than an all-zero payload.
   */
  const commitCollision = () => {
    onCollisionChange(collisionMap.isEmpty ? null : collisionMap.serialize());
    bump();
  };

  const clearCollision = () => {
    if (collisionMap.isEmpty) return;
    if (!window.confirm(`Clear all ${collisionMap.solidCount} solid cells?`)) return;
    collisionMap.clear();
    commitCollision();
  };

  /**
   * Switch layers. The two cell layers share one store and one cell shape, so
   * moving between Voxels and Hexels re-shapes what is already authored —
   * confirmed first, since the two lattices read very differently.
   */
  const selectLayer = (next: MapLayer) => {
    if (next === layer) return;
    if (isColumnLayer(next) && space.shape !== shapeForLayer(next)) {
      const shape = shapeForLayer(next);
      if (
        !space.isEmpty &&
        !window.confirm(`Rebuild the ${space.cellCount} authored cells as ${shape}s?`)
      ) {
        return;
      }
      spaceRef.current = space.clone({ shape });
      commitSpace();
    }
    // Collision is a flat, top-down attribute with no presence in 3D; selecting
    // it from inside the map steps back out so the tool has something to act on.
    if (isFlatLayer(next) && inSpace) setView("top");
    setLayer(next);
    setTool(defaultToolFor(next));
    setSpaceTool(defaultSpaceToolFor(next));
    // The pixel layer is unusable from above until a tile's pixels are big enough
    // to hit; in the 3D view zoom means something else entirely, so leave it.
    if (next === "pixels" && !inSpace && zoom < PIXEL_ZOOM_INDEX) setZoom(PIXEL_ZOOM_INDEX);
  };

  /**
   * Switch vantage point.
   *
   * Tiles are the ground plan and have no meaning as a thing to point at in
   * space, so stepping inside opens on the cell layer the map's own shape names
   * rather than leaving the rail with no usable tool.
   *
   * The camera also has to land somewhere worth looking at. A map is far wider
   * than one window, so stepping in over empty ground shows a black void with
   * nothing to aim at and no hint which way to walk; when that would happen, the
   * camera goes to the middle of what is actually built instead. Somewhere you
   * have already walked to is left alone — being teleported off your own work
   * every time you glance at the plan would be worse than the void.
   */
  const selectView = (next: MapViewMode) => {
    if (next === view) return;
    if (next === "space") {
      if (layer === "tiles" || isFlatLayer(layer)) {
        const target = spaceLayerFor(layer);
        setLayer(target);
        setSpaceTool(defaultSpaceToolFor(target));
      }
      if (!space.hasCellsNear(focus.x, focus.z, radius)) {
        const centre = space.contentCentre();
        if (centre) setFocus(centre);
      }
    }
    setSpaceNote(null);
    setView(next);
  };

  /**
   * Step between circling the map and standing in it, carrying your place across
   * so the two are the same trip rather than two unrelated cameras. Walking in
   * lands you at eye height over the ground you were looking at; orbiting back
   * out circles the cell you were standing on.
   */
  const selectCameraMode = (next: MapCameraMode) => {
    if (next === cameraMode) return;
    if (next === "walk") {
      setWalk(
        standOnGround(space, {
          x: focus.x,
          y: focus.y,
          z: focus.z,
          yaw: walkYawOf(camera.yaw),
          // Tilted a little downward, because what you step in to do is build on
          // the ground in front of you — arriving level puts the crosshair on the
          // sky and gives the tools nothing to act on.
          pitch: WALK_ENTRY_PITCH,
        }),
      );
    } else {
      setFocus({ x: walk.x, y: Math.max(0, walk.y - 1), z: walk.z });
      setCamera((current) => ({ ...current, yaw: walkYawOf(walk.yaw) }));
    }
    setSpaceNote(null);
    setCameraMode(next);
  };

  const selectGenerator = (id: string) => {
    setGeneratorId(id);
    const next = findGenerator(MAP_GENERATORS, id);
    setMappings((current) =>
      current[id] ? current : { ...current, [id]: paletteMapping(next.legend) },
    );
    setGenerateNote(null);
  };

  // The field the current settings would produce. Generated at the map's true
  // size so the preview and the applied result are the same thing, and only
  // while the panel is open so a closed panel costs nothing.
  const preview = useMemo<ClassField | null>(() => {
    if (!showGenerator) return null;
    return generator.generate(map.width, map.height, values);
  }, [showGenerator, generator, map.width, map.height, values]);

  /** Apply the previewed field to whichever layer is active. */
  const runGenerator = () => {
    // Collision is authored by hand, not generated; the panel is hidden there, but
    // guard the action too so it can never stamp a field onto the wrong layer.
    if (isFlatLayer(layer)) return;
    const field = preview ?? generator.generate(map.width, map.height, values);
    if (isColumnLayer(layer)) {
      const raised = applyFieldToColumns(mapColumnTarget(space), field, mapping);
      commitSpace();
      setGenerateNote(`${generator.label}: raised ${raised.toLocaleString()} columns.`);
      return;
    }
    if (layer === "pixels") {
      // Pixels live in the tiles page, not in map cells: two cells stamping the
      // same tile share one set of pixels, so painting a field "across the map"
      // would have those cells fight over it. The field is painted across the
      // tiles page itself instead — it generates the tile art the map stamps.
      if (!window.confirm(`Repaint the ${sheet.sheetSize}×${sheet.sheetSize} tiles page with ${generator.label}?`)) {
        return;
      }
      const written = applyFieldToPixels(
        {
          width: sheet.sheetSize,
          height: sheet.sheetSize,
          setPixel: (x, y, value) => {
            const tile = Math.floor(y / sheet.tileSize) * sheet.sheetCols + Math.floor(x / sheet.tileSize);
            // Through the material brush, so a generated texture carries its
            // colours' material profiles rather than bare albedo.
            pixelSurface.setPixel(TILES_PAGE, tile, x % sheet.tileSize, y % sheet.tileSize, value);
          },
        },
        field,
        mapping,
        { x: 0, y: 0, width: sheet.sheetSize, height: sheet.sheetSize },
      );
      bump();
      setGenerateNote(`${generator.label}: painted ${written.toLocaleString()} pixels across the tiles page.`);
      return;
    }
    const stamped = applyFieldToTiles(map, field, mapping);
    bump();
    setGenerateNote(`${generator.label}: stamped ${stamped.toLocaleString()} cells.`);
  };

  const clearCells = () => {
    if (space.isEmpty) return;
    if (!window.confirm(`Remove all ${space.cellCount} cells?`)) return;
    space.clearAll();
    commitSpace();
  };

  /** The Picker adopted a cell's look: arm both its colour and its skin. */
  const adoptStyle = (pickedColor: number, pickedMaterial: number) => {
    setColorIndex(pickedColor);
    setColumnMaterial(pickedMaterial);
    const tile = materialSpriteTile(pickedMaterial, sheet.tilesPerPage);
    if (tile !== null) setBrush(singleTileBrush(tile));
  };

  // Every rail control and inspector panel is handed to the shared containers by
  // slot; they decide the order, identically for every tab. See workbenchLayout.
  const rail: RailSlots = {
    view: (
      <>
        <SegmentedControl label="View" options={MAP_VIEW_MODES} selected={view} onSelect={selectView} />
        {inSpace && (
          <SegmentedControl
            label="Camera"
            options={MAP_CAMERA_MODES}
            selected={cameraMode}
            onSelect={selectCameraMode}
          />
        )}
      </>
    ),

    layer: <ToolRail label="Layer" tools={MAP_LAYERS} selected={layer} onSelect={selectLayer} />,

    tool: inSpace ? (
      <ToolRail label="Tool" tools={spaceTools} selected={spaceTool} onSelect={setSpaceTool} />
    ) : (
      <ToolRail label="Tool" tools={definition.tools} selected={tool} onSelect={setTool} />
    ),

    toolOptions: (
      <>
        {inSpace && spaceTool === "plane" && (
          <SegmentedControl label="Plane" options={PLANE_KINDS} selected={planeKind} onSelect={setPlaneKind} />
        )}
        {!inSpace && isColumnLayer(layer) && (
          <>
            <RangeControl
              label="Step"
              min={1}
              max={16}
              value={columnStep}
              onChange={setColumnStep}
              ariaLabel="Column step"
              // The value belongs beside the slider, as it is in every other tab —
              // it used to be folded into the group heading ("Step · 4"), which is
              // a fourth way of showing a number the rail already had three of.
              display={`${columnStep} cells`}
            />
            <RailHint>How many cells Raise and Lower move a column per click.</RailHint>
          </>
        )}
      </>
    ),

    canvas: inSpace ? (
      <>
        {walking ? (
          <>
            {renderer === "cpu" && (
              <SegmentedControl
                label="Detail"
                options={WALK_DETAIL_LEVELS}
                selected={walkDetail}
                onSelect={setWalkDetail}
              />
            )}
            <RailGroup label="Position">
              <div className={styles.toolGroup}>
                <button
                  type="button"
                  className={styles.toolBtn}
                  onClick={() => setWalk((current) => standOnGround(space, current))}
                >
                  <span className={styles.toolGlyph} aria-hidden>
                    ⤓
                  </span>
                  Stand on ground
                </button>
              </div>
            </RailGroup>
          </>
        ) : (
          <>
            <SegmentedControl label="Range" options={RANGE_OPTIONS} selected={radius} onSelect={setRadius} />
            {/* Shading and channel are hardware-only. Offering them under the
                software fallback would show a lit frame under a "Normal" label,
                which is worse than not offering them. */}
            {renderer === "gpu" && (
              <>
                <SegmentedControl
                  label="Shading"
                  options={SHADING_MODELS}
                  selected={shading}
                  onSelect={setShading}
                  wrap
                />
                <SegmentedControl
                  label="Channel"
                  options={CHANNEL_VIEWS}
                  selected={channel}
                  onSelect={setChannel}
                  wrap
                  spaced
                />
                <RailHint>
                  {channelHint(channel) ?? shadingHint(shading)}
                </RailHint>
              </>
            )}
          </>
        )}

        {/* Which renderer the 3D stage got. Belongs with the stage's own settings
            rather than with the Clear action it used to trail, so it still shows
            on the pixel layer — which has no cells to clear. */}
        <RailGroup label="Renderer">
          <RailHint>
            {renderer === "gpu"
              ? "Drawing on the GPU (WebGPU): full resolution, lit by the material channels your art carries, with glowing pixels bloomed."
              : renderer === "cpu"
                ? "WebGPU is unavailable here, so the view is being drawn in software — lower resolution and slower. Enabling hardware acceleration in your browser restores it."
                : "Choosing a renderer…"}
          </RailHint>
        </RailGroup>
      </>
    ) : (
      <SegmentedControl label="Zoom" options={ZOOM_OPTIONS} selected={zoom} onSelect={setZoom} />
    ),

    io: isColumnLayer(layer) ? (
      <RailGroup label="Cells">
        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolBtn} onClick={clearCells}>
            <span className={styles.toolGlyph} aria-hidden>
              ✕
            </span>
            Clear cells
          </button>
        </div>
      </RailGroup>
    ) : flat ? (
      <RailGroup label="Collision">
        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolBtn} onClick={clearCollision}>
            <span className={styles.toolGlyph} aria-hidden>
              ✕
            </span>
            Clear solids
          </button>
        </div>
      </RailGroup>
    ) : null,
  };

  const inspector: InspectorSlots = {
    // The sprite sheet, whenever a tool stamps it, stands it in the world, or
    // paints on it. Above the palette, as in the sprite editor — it is the art
    // you are pointed at, and the palette is what you change it with.
    source: !flat && (needsSpriteBrush(spaceTool, planeKind) || !inSpace) && (
      <TilePicker
        sheet={sheet}
        page={TILES_PAGE}
        selected={brush.tile}
        version={version}
        onSelect={(tile) => setBrush(singleTileBrush(tile))}
        onSelectBrush={setBrush}
        brush={brush}
      />
    ),

    // Colour and material are always here.
    // They used to be swapped out — for the tile picker on the Tiles layer, and
    // for the generator while it was open — which meant that opening the Map tab,
    // or generating a landscape and then wanting to paint it, left you with
    // nothing to paint *with* and no sign that a palette existed at all.
    palette: flat ? null : (
      <PalettePicker
        colors={palette}
        selected={colorIndex}
        onSelect={setColorIndex}
        title="Palette"
        subtitle={`${palette.length} colors`}
        order={paletteOrder}
        sorted={sortPalette}
        onToggleSort={() => setSortPalette((value) => !value)}
        materials={materialColors}
      />
    ),

    material: flat ? null : (
      <MaterialPicker
        selected={columnMaterial}
        onSelect={setColumnMaterial}
        colorCss={palette[colorIndex] ?? "#000"}
        tilesPerPage={sheet.tilesPerPage}
        // The armed sprite, offered as one material among the world's own rather
        // than as a separate button: skinning a cell with your own art is the
        // same kind of choice as skinning it with grass.
        extras={[
          {
            material: spriteTileMaterial(brush.tile),
            name: `Sprite #${brush.tile}`,
            art: <SpriteSwatch sheet={sheet} tile={brush.tile} version={version} />,
          },
        ]}
      />
    ),

    generate: flat ? null : (
      <div>
        <button
          type="button"
          className={styles.rendererToggle}
          onClick={() => setShowGenerator((open) => !open)}
          aria-expanded={showGenerator}
        >
          {showGenerator ? "Close generator" : "Generate…"}
        </button>

        {showGenerator && (
          <GeneratorPanel
            generators={MAP_GENERATORS}
            selectedId={generator.id}
            onSelect={selectGenerator}
            values={values}
            onValuesChange={setValues}
            onGenerate={runGenerator}
            note={generateNote}
          >
            <FieldPreview field={preview} label={`${generator.label} preview`} />
            <ClassMappingEditor
              legend={generator.legend}
              mapping={mapping}
              onChange={(next) => setMappings((current) => ({ ...current, [generator.id]: next }))}
              layer={layer}
              palette={palette}
              maxTile={sheet.tilesPerPage - 1}
              maxColumnHeight={MAX_MAP_VOXEL_HEIGHT}
            />
          </GeneratorPanel>
        )}
      </div>
    ),

    hint: (
      <InspectorHint>
        {walking
          ? "Click the view to capture the mouse, then look with the mouse and move with W A S D. Space and Shift change height, Ctrl sprints, Escape releases. Click builds, right-click breaks."
          : inSpace
            ? `Drag to orbit, shift-drag to pan, wheel to zoom. W A S D walks the focus; Q and E change height. ${hintFor(view, cameraMode, layer, spaceTool, space.shape)}`
            : hintFor(view, cameraMode, layer, spaceTool, space.shape)}
      </InspectorHint>
    ),
  };

  return (
    <div className={styles.body}>
      <WorkbenchRail slots={rail} />

      <section className={styles.mapStage}>
        {walking ? (
          <MapWalkCanvas
            sheet={sheet}
            space={space}
            atlas={atlas}
            tool={spaceTool}
            colorIndex={colorIndex}
            material={columnMaterial}
            planeKind={planeKind}
            brushTile={brush.tile}
            pixels={pixelSurface}
            palette={palette}
            camera={walk}
            onCameraChange={setWalk}
            resolution={walkDetail}
            version={version}
            onEdit={bump}
            onSpaceCommitted={commitSpace}
            onPickStyle={adoptStyle}
            onHover={setWalkHover}
            onNote={setSpaceNote}
            onRendererChange={setRenderer}
          />
        ) : inSpace ? (
          <Map3DCanvas
            sheet={sheet}
            space={space}
            atlas={atlas}
            tool={spaceTool}
            colorIndex={colorIndex}
            material={columnMaterial}
            planeKind={planeKind}
            brushTile={brush.tile}
            pixels={pixelSurface}
            palette={palette}
            focus={focus}
            onFocusChange={setFocus}
            radius={radius}
            yaw={camera.yaw}
            pitch={camera.pitch}
            cell={camera.cell}
            onCameraChange={setCamera}
            version={version}
            onEdit={bump}
            onSpaceCommitted={commitSpace}
            onPickStyle={adoptStyle}
            onHover={setSpaceHover}
            onNote={setSpaceNote}
            onRendererChange={setRenderer}
            shading={shading}
            channel={channel}
          />
        ) : (
          <MapCanvas
            sheet={sheet}
            map={map}
            space={space}
            layer={layer}
            brush={brush}
            tool={tool}
            colorIndex={colorIndex}
            pixels={pixelSurface}
            columnMaterial={columnMaterial}
            columnStep={columnStep}
            collision={collisionMap}
            cell={cell}
            version={version}
            palette={palette}
            onEdit={bump}
            onColumnsCommitted={commitSpace}
            onCollisionCommitted={commitCollision}
            onHover={setHover}
          />
        )}

        {inSpace ? (
          <div className={styles.hud}>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Standing</span>
              <span className={`${styles.hudValue} data`}>
                {walking
                  ? `${Math.round(walk.x)},${Math.round(walk.y)},${Math.round(walk.z)}`
                  : `${Math.round(focus.x)},${Math.round(focus.y)},${Math.round(focus.z)}`}
              </span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Aiming</span>
              <span className={`${styles.hudValue} data`}>
                {aiming ? `${aiming.x},${aiming.y},${aiming.z}` : "—"}
              </span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Cells</span>
              <span className={`${styles.hudValue} data`}>{space.cellCount.toLocaleString()}</span>
            </span>
            {spaceNote && (
              <span className={styles.hudNote} title={spaceNote} data-testid="map-note">
                {spaceNote}
              </span>
            )}
          </div>
        ) : (
          <div className={styles.hud}>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Cell</span>
              <span className={`${styles.hudValue} data`}>{hover ? `${hover.x},${hover.y}` : "—"}</span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Screen</span>
              <span className={`${styles.hudValue} data`}>{screen ? `${screen[0]},${screen[1]}` : "—"}</span>
            </span>
            {isColumnLayer(layer) ? (
              <span className={styles.hudItem}>
                <span className={styles.hudLabel}>Column</span>
                <span className={`${styles.hudValue} data`}>
                  {hover ? `${space.heightAt(hover.x, hover.y)}` : "—"} / {space.columnCount} columns
                </span>
              </span>
            ) : flat ? (
              <span className={styles.hudItem}>
                <span className={styles.hudLabel}>Solid</span>
                <span className={`${styles.hudValue} data`}>
                  {hover ? (collisionMap.isSolid(hover.x, hover.y) ? "yes" : "no") : "—"} ·{" "}
                  {collisionMap.solidCount.toLocaleString()} cells
                </span>
              </span>
            ) : (
              <span className={styles.hudItem}>
                <span className={styles.hudLabel}>{layer === "pixels" ? "Tile" : "Brush"}</span>
                <span className={`${styles.hudValue} data`}>
                  {layer === "pixels"
                    ? hover
                      ? `#${map.getCell(hover.x, hover.y).toString().padStart(3, "0")}`
                      : "—"
                    : `#${brush.tile.toString().padStart(3, "0")}${
                        brush.width * brush.height > 1 ? ` ${brush.width}×${brush.height}` : ""
                      }`}
                </span>
              </span>
            )}
          </div>
        )}
      </section>

      <WorkbenchInspector slots={inspector} />
    </div>
  );
}

/**
 * Whether the inspector should offer the sprite sheet rather than the palette:
 * the tools that stand or paint sprite art need a tile chosen, and the tile
 * picker is the only control that does that.
 */
function needsSpriteBrush(tool: MapSpaceTool, planeKind: MapCellKind): boolean {
  return isPixelSpaceTool(tool) || (tool === "plane" && planeKind !== "solid");
}

/**
 * The sprite the material swatch stands for, drawn at its own resolution and
 * scaled up crisply — a swatch of the actual art says far more than a label.
 */
function SpriteSwatch({ sheet, tile, version }: { sheet: SpriteSheet; tile: number; version: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = context.createImageData(sheet.tileSize, sheet.tileSize);
    image.data.set(sheet.renderTileRgba(TILES_PAGE, tile));
    context.putImageData(image, 0, 0);
  }, [sheet, tile, version]);
  return (
    <canvas
      ref={canvasRef}
      width={sheet.tileSize}
      height={sheet.tileSize}
      style={{ display: "block", width: "100%", height: "100%", imageRendering: "pixelated" }}
    />
  );
}

/** The one-paragraph explanation of what the active tool does where you are. */
function hintFor(
  view: MapViewMode,
  cameraMode: MapCameraMode,
  layer: MapLayer,
  tool: MapSpaceTool,
  shape: string,
): string {
  if (view === "space") {
    if (isPixelSpaceTool(tool)) {
      return "Paints the sprite a cell wears, on the face you clicked, at the pixel under the cursor. A cell with no sprite yet is given the armed one and painted in the same click — and every cell wearing that sprite shares its pixels.";
    }
    if (tool === "plane") {
      return "Stands the armed sprite as a flat quad in the cell across the face you click — grass, wires, banners, anything that should read as art on a surface rather than a solid block. Cross stands two, so it looks the same from every side.";
    }
    if (tool === "paintCell") {
      return "Restyles the cell you click with the armed colour and material. Right-click strips it back to flat colour.";
    }
    const where =
      cameraMode === "walk"
        ? "Cells are placed against the face under the crosshair and broken by clicking them"
        : "Cells are placed against the face you point at and removed by clicking them";
    return `${where}, so overhangs, caves and bridges are all just cells. ${
      shape === "hexel" ? "Hexels only sit on the close-packed lattice, so some neighbours are not valid sites." : ""
    }`;
  }
  if (layer === "pixels") {
    return "Pixels belong to the tile, not the cell — editing one cell changes every cell that stamps the same tile. A colour with a material swatch stamps its whole profile, exactly as in the Sprites tab.";
  }
  if (layer === "collision") {
    return "Mark which cells are solid — the walls and ground a game should collide with. Solid cells show as a red overlay over the map art; Fill floods a whole enclosed region at once. The layer is saved with the cart for its own logic to read.";
  }
  return `Raise builds ${shape} columns up to ${MAX_MAP_VOXEL_HEIGHT} cells tall, skinned with the armed material. Brightness shows height; ${
    shape === "hexel" ? "diamonds mark the close-packed lattice" : "squares mark cube columns"
  }. Switch to 3D to build anything a column cannot describe.`;
}
