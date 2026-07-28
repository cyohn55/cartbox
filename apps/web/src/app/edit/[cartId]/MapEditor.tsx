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

import { useCallback, useMemo, useRef, useState } from "react";
import {
  MapVoxelSpace,
  MaterialMap,
  NormalMap,
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
  type GeneratorValues,
  type MapCellKind,
  type MapViewFocus,
  type MaterialSwatches,
  type SpriteSheet,
  type TileMap,
} from "@cartbox/editor";

import { BUILD_MATERIALS, worldSurfaceMaterial } from "@/lib/faceTextures";
import { buildMapAtlas, materialSpriteTile, spriteTileMaterial } from "@/lib/mapAtlas";
import styles from "./editor.module.css";
import { ClassMappingEditor } from "./ClassMappingEditor";
import { FieldPreview } from "./FieldPreview";
import { GeneratorPanel } from "./GeneratorPanel";
import { Map3DCanvas, type SpaceHover } from "./Map3DCanvas";
import { MapCanvas } from "./MapCanvas";
import { RailGroup, RailHint, RangeControl, SegmentedControl, ToolRail } from "./railControls";
import { MaterialSurface, NormalSurface } from "./paintSurface";
import { MaterialBrushSurface } from "./materialBrushSurface";
import { TilePicker } from "./TilePicker";
import { singleTileBrush, type MapBrush } from "./mapBrush";
import {
  MAP_LAYERS,
  MAP_VIEW_MODES,
  MAP_ZOOMS,
  PIXEL_ZOOM_INDEX,
  PLANE_KINDS,
  defaultSpaceToolFor,
  defaultToolFor,
  isColumnLayer,
  isPixelSpaceTool,
  layerDef,
  shapeForLayer,
  spaceLayerFor,
  spaceToolsFor,
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

interface MapEditorProps {
  sheet: SpriteSheet;
  map: TileMap;
  /** The saved map cells for this cart, or null when none were authored. */
  columnPayload: string | null;
  /** Persist the map cells (feeds the undo timeline and the save). */
  onColumnsChange: (serialized: string) => void;
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
  const mapping = mappings[generator.id] ?? paletteMapping(generator.legend);
  const bump = () => setVersion((current) => current + 1);
  const screen = hover ? map.screenOf(hover.x, hover.y) : null;
  const inSpace = view === "space";
  const spaceTools = spaceToolsFor(layer, space.shape);

  // The atlas the 3D view samples: the world's materials plus every sprite on the
  // tiles page. Rebuilt when the art changes so a texture painted on a face shows
  // on every cell wearing that sprite.
  const atlas = useMemo(() => buildMapAtlas(sheet), [sheet, version]);

  /** Serialize the cells up to the cart after an edit or a generate run. */
  const commitSpace = () => {
    onColumnsChange(serializeMapVoxelSpace(space));
    bump();
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
      if (layer === "tiles") {
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

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <SegmentedControl label="View" options={MAP_VIEW_MODES} selected={view} onSelect={selectView} />

        <ToolRail label="Layer" tools={MAP_LAYERS} selected={layer} onSelect={selectLayer} />

        {inSpace ? (
          <ToolRail label="Tool" tools={spaceTools} selected={spaceTool} onSelect={setSpaceTool} />
        ) : (
          <ToolRail label="Tool" tools={definition.tools} selected={tool} onSelect={setTool} />
        )}

        {inSpace && spaceTool === "plane" && (
          <SegmentedControl
            label="Plane"
            options={PLANE_KINDS}
            selected={planeKind}
            onSelect={setPlaneKind}
          />
        )}

        {inSpace ? (
          <>
            <SegmentedControl label="Range" options={RANGE_OPTIONS} selected={radius} onSelect={setRadius} />
            <RailHint>
              Drag to orbit, shift-drag to pan, wheel to zoom. W A S D walks; Q and E change height. Right-click
              removes.
            </RailHint>
            {isColumnLayer(layer) && (
              <button type="button" className={styles.rendererToggle} onClick={clearCells}>
                Clear cells
              </button>
            )}
          </>
        ) : (
          <>
            {isColumnLayer(layer) && (
              <RailGroup label={`Step · ${columnStep}`}>
                <RangeControl
                  min={1}
                  max={16}
                  value={columnStep}
                  onChange={setColumnStep}
                  ariaLabel="Column step"
                />
                <button type="button" className={styles.rendererToggle} onClick={clearCells}>
                  Clear cells
                </button>
              </RailGroup>
            )}
            <SegmentedControl label="Zoom" options={ZOOM_OPTIONS} selected={zoom} onSelect={setZoom} />
          </>
        )}
      </aside>

      <section className={styles.mapStage}>
        {inSpace ? (
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
            cell={cell}
            version={version}
            palette={palette}
            onEdit={bump}
            onColumnsCommitted={commitSpace}
            onHover={setHover}
          />
        )}

        {inSpace ? (
          <div className={styles.hud}>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Standing</span>
              <span className={`${styles.hudValue} data`}>
                {Math.round(focus.x)},{Math.round(focus.y)},{Math.round(focus.z)}
              </span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Aiming</span>
              <span className={`${styles.hudValue} data`}>
                {spaceHover ? `${spaceHover.x},${spaceHover.y},${spaceHover.z}` : "—"}
              </span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Cells</span>
              <span className={`${styles.hudValue} data`}>{space.cellCount.toLocaleString()}</span>
            </span>
            {spaceNote && (
              <span className={styles.hudNote} title={spaceNote}>
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

      <aside className={styles.inspector}>
        <button
          type="button"
          className={styles.rendererToggle}
          onClick={() => setShowGenerator((open) => !open)}
          aria-expanded={showGenerator}
        >
          {showGenerator ? "Close generator" : "Generate…"}
        </button>

        {showGenerator ? (
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
        ) : layer === "tiles" || (inSpace && needsSpriteBrush(spaceTool, planeKind)) ? (
          <TilePicker
            sheet={sheet}
            page={TILES_PAGE}
            selected={brush.tile}
            version={version}
            onSelect={(tile) => setBrush(singleTileBrush(tile))}
            onSelectBrush={setBrush}
            brush={brush}
          />
        ) : (
          <div>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Palette</span>
              <span className={styles.panelMeta}>{palette[colorIndex] ?? "—"}</span>
            </div>
            <div className={styles.paletteGrid}>
              {palette.map((css, index) => (
                <button
                  key={index}
                  type="button"
                  className={`${styles.swatch} ${index === colorIndex ? styles.swatchActive : ""}`}
                  style={{ background: css }}
                  onClick={() => setColorIndex(index)}
                  title={`${index} · ${css}`}
                  aria-label={`Colour ${index}, ${css}`}
                  aria-pressed={index === colorIndex}
                />
              ))}
            </div>
            {(isColumnLayer(layer) || inSpace) && (
              <>
                <div className={styles.panelHead} style={{ marginTop: 14 }}>
                  <span className={styles.panelTitle}>Material</span>
                  <span className={styles.panelMeta}>{materialLabel(columnMaterial, sheet.tilesPerPage)}</span>
                </div>
                <div className={styles.paletteGrid}>
                  <button
                    type="button"
                    className={`${styles.swatch} ${columnMaterial < 0 ? styles.swatchActive : ""}`}
                    style={{ background: palette[colorIndex] ?? "#000", outline: "1px dashed var(--faint)" }}
                    onClick={() => setColumnMaterial(COLUMN_MATERIAL_NONE)}
                    title="Flat — build in the palette colour, with no texture"
                    aria-label="Flat colour, no material"
                    aria-pressed={columnMaterial < 0}
                  />
                  {BUILD_MATERIALS.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      className={`${styles.swatch} ${entry.material === columnMaterial ? styles.swatchActive : ""}`}
                      style={{ background: entry.swatch }}
                      onClick={() => setColumnMaterial(entry.material)}
                      title={entry.name}
                      aria-label={`Material ${entry.name}`}
                      aria-pressed={entry.material === columnMaterial}
                    />
                  ))}
                </div>
                {inSpace && (
                  <button
                    type="button"
                    className={styles.rendererToggle}
                    style={{ marginTop: 10 }}
                    onClick={() => setColumnMaterial(spriteTileMaterial(brush.tile))}
                  >
                    Skin with sprite #{brush.tile}
                  </button>
                )}
              </>
            )}
            <p className={styles.pickerHint}>{hintFor(view, layer, spaceTool, space.shape)}</p>
          </div>
        )}
      </aside>
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

/** What the armed material is, for the inspector's readout. */
function materialLabel(material: number, tilesPerPage: number): string {
  if (material < 0) return "flat";
  const tile = materialSpriteTile(material, tilesPerPage);
  if (tile !== null) return `sprite #${tile}`;
  return BUILD_MATERIALS.find((entry) => entry.material === material)?.name ?? "flat";
}

/** The one-paragraph explanation of what the active tool does where you are. */
function hintFor(view: MapViewMode, layer: MapLayer, tool: MapSpaceTool, shape: string): string {
  if (view === "space") {
    if (isPixelSpaceTool(tool)) {
      return "Paints the sprite a cell is skinned with, on the face you clicked, at the pixel under the cursor. A cell with no sprite yet takes the armed one on the first click.";
    }
    if (tool === "plane") {
      return "Stands a flat sprite quad in the cell across the face you click — grass, wires, banners, anything that should read as art on a surface rather than a solid block. Cross stands two, so it looks the same from every side.";
    }
    return `Cells are placed against the face you point at and removed by clicking them, so overhangs, caves and bridges are all just cells. ${
      shape === "hexel" ? "Hexels only sit on the close-packed lattice, so some neighbours are not valid sites." : ""
    }`;
  }
  if (layer === "pixels") {
    return "Pixels belong to the tile, not the cell — editing one cell changes every cell that stamps the same tile. A colour with a material swatch stamps its whole profile, exactly as in the Sprites tab.";
  }
  return `Raise builds ${shape} columns up to ${MAX_MAP_VOXEL_HEIGHT} cells tall, skinned with the armed material. Brightness shows height; ${
    shape === "hexel" ? "diamonds mark the close-packed lattice" : "squares mark cube columns"
  }. Switch to 3D to build anything a column cannot describe.`;
}
