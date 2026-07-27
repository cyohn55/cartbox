"use client";

/**
 * Map editor: owns the map's editing state — which layer is active, its tool,
 * the brush, the zoom — and lays out the tool rail, the scrollable map stage,
 * and the inspector.
 *
 * The map is authored on four layers over one grid: tiles, the pixels inside
 * those tiles, and a column layer that gives the map height as cubes or hexels.
 * All of them share the cart's SpriteSheet and TileMap, so art drawn in the
 * Sprites tab is immediately stampable here and a pixel touched up here shows up
 * there. Any of the four can also be filled procedurally: the generators produce
 * classes, and the mapping panel says what a class means on the active layer.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  MapVoxelLayer,
  MaterialMap,
  NormalMap,
  materialProfileAt,
  COLUMN_MATERIAL_NONE,
  surfaceForClassId,
  MAP_GENERATORS,
  MAX_MAP_COLUMN_HEIGHT,
  applyFieldToColumns,
  applyFieldToPixels,
  applyFieldToTiles,
  defaultClassMapping,
  defaultValues,
  deserializeMapVoxelLayer,
  findGenerator,
  serializeMapVoxelLayer,
  type ClassField,
  type ClassInfo,
  type ClassMapping,
  type GeneratorValues,
  type MaterialSwatches,
  type SpriteSheet,
  type TileMap,
} from "@cartbox/editor";

import { BUILD_MATERIALS, worldSurfaceMaterial } from "@/lib/faceTextures";
import styles from "./editor.module.css";
import { ClassMappingEditor } from "./ClassMappingEditor";
import { FieldPreview } from "./FieldPreview";
import { GeneratorPanel } from "./GeneratorPanel";
import { MapCanvas } from "./MapCanvas";
import { RailGroup, RangeControl, SegmentedControl, ToolRail } from "./railControls";
import { MaterialSurface, NormalSurface } from "./paintSurface";
import { MaterialBrushSurface } from "./materialBrushSurface";
import { TilePicker } from "./TilePicker";
import { singleTileBrush, type MapBrush } from "./mapBrush";
import {
  MAP_LAYERS,
  MAP_ZOOMS,
  PIXEL_ZOOM_INDEX,
  defaultToolFor,
  isColumnLayer,
  layerDef,
  shapeForLayer,
  type MapLayer,
  type MapTool,
} from "./maptools";

/** The tiles page the map stamps from. */
const TILES_PAGE = 0;

/** The zoom levels as the rail selects them — by index, which is what `zoom` holds. */
const ZOOM_OPTIONS = MAP_ZOOMS.map((option, index) => ({ id: index, label: option.label }));

interface MapEditorProps {
  sheet: SpriteSheet;
  map: TileMap;
  /** The saved column layer for this cart, or null when none was authored. */
  columnPayload: string | null;
  /** Persist the column layer (feeds the undo timeline and the save). */
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

/**
 * Restore the saved column layer, or start an empty one. A payload that does not
 * match the current map's dimensions (the console model changed) is rebuilt at
 * the map's size rather than discarded, so the columns that still fit survive.
 */
function loadColumns(payload: string | null, map: TileMap): MapVoxelLayer {
  if (!payload) return new MapVoxelLayer(map.width, map.height);
  try {
    const saved = deserializeMapVoxelLayer(payload);
    if (saved.width === map.width && saved.height === map.height) return saved;
    const resized = new MapVoxelLayer(map.width, map.height, saved.shape);
    saved.forEachColumn((x, y, column) => resized.setColumn(x, y, column.height, column.colorIndex));
    return resized;
  } catch {
    // A corrupt payload must not break the mount; start clean instead.
    return new MapVoxelLayer(map.width, map.height);
  }
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
  // The column layer is the source of truth for map height; it is seeded once
  // from the cart and handed back up serialized after every stroke.
  const columnsRef = useRef<MapVoxelLayer | null>(null);
  if (columnsRef.current === null) columnsRef.current = loadColumns(columnPayload, map);

  const [layer, setLayer] = useState<MapLayer>("tiles");
  const [tool, setTool] = useState<MapTool>(() => defaultToolFor("tiles"));
  const [brush, setBrush] = useState<MapBrush>(() => singleTileBrush(2));
  const [colorIndex, setColorIndex] = useState(1);
  const [columnStep, setColumnStep] = useState(1);
  // The material armed for the column tools, or "flat" for plain palette colour.
  const [columnMaterial, setColumnMaterial] = useState<number>(COLUMN_MATERIAL_NONE);
  const [zoom, setZoom] = useState(1);
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  // Generator state: which one, its values, and how its classes map onto the
  // active layer. The mapping is per generator, so switching back to one you
  // tuned earlier restores what you set up.
  const [generatorId, setGeneratorId] = useState(MAP_GENERATORS[0]!.id);
  const generator = findGenerator(MAP_GENERATORS, generatorId);
  const [values, setValues] = useState<GeneratorValues>(() => defaultValues(MAP_GENERATORS[0]!.params));
  // Snap each class to the nearest colour the cart's own palette holds, so a
  // generated landscape opens in plausible colours rather than at whatever sits
  // in palette slots 1..7.
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

  const columns = columnsRef.current!;
  const definition = layerDef(layer);
  const cell = (MAP_ZOOMS[zoom] ?? MAP_ZOOMS[1])!.cell;
  const palette = useMemo(() => sheet.cssPalette(), [sheet, version]);
  const mapping = mappings[generator.id] ?? paletteMapping(generator.legend);
  const bump = () => setVersion((current) => current + 1);
  const screen = hover ? map.screenOf(hover.x, hover.y) : null;

  /** Serialize the column layer up to the cart after a stroke or a generate run. */
  const commitColumns = () => {
    onColumnsChange(serializeMapVoxelLayer(columns));
    bump();
  };

  /**
   * Switch layers. The two column layers share one store and one cell shape, so
   * moving between Voxels and Hexels re-shapes the columns already authored —
   * confirmed first, since the two lattices read very differently.
   */
  const selectLayer = (next: MapLayer) => {
    if (next === layer) return;
    if (isColumnLayer(next) && isColumnLayer(layer)) {
      const shape = shapeForLayer(next);
      if (
        !columns.isEmpty &&
        !window.confirm(`Rebuild the ${columns.columnCount} authored columns as ${shape}s?`)
      ) {
        return;
      }
      columnsRef.current = columns.clone(shape);
      commitColumns();
    } else if (isColumnLayer(next) && columns.shape !== shapeForLayer(next)) {
      // Arriving from a non-column layer: adopt the shape the user picked.
      columnsRef.current = columns.clone(shapeForLayer(next));
      commitColumns();
    }
    setLayer(next);
    setTool(defaultToolFor(next));
    // The pixel layer is unusable until a tile's pixels are big enough to hit.
    if (next === "pixels" && zoom < PIXEL_ZOOM_INDEX) setZoom(PIXEL_ZOOM_INDEX);
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
      const raised = applyFieldToColumns(columns, field, mapping);
      commitColumns();
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

  const clearColumns = () => {
    if (columns.isEmpty) return;
    if (!window.confirm(`Remove all ${columns.columnCount} columns?`)) return;
    columns.clearAll();
    commitColumns();
  };

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <ToolRail label="Layer" tools={MAP_LAYERS} selected={layer} onSelect={selectLayer} />

        <ToolRail label="Tool" tools={definition.tools} selected={tool} onSelect={setTool} />

        {isColumnLayer(layer) && (
          <RailGroup label={`Step · ${columnStep}`}>
            <RangeControl
              min={1}
              max={16}
              value={columnStep}
              onChange={setColumnStep}
              ariaLabel="Column step"
            />
            <button type="button" className={styles.rendererToggle} onClick={clearColumns}>
              Clear columns
            </button>
          </RailGroup>
        )}

        <SegmentedControl label="Zoom" options={ZOOM_OPTIONS} selected={zoom} onSelect={setZoom} />
      </aside>

      <section className={styles.mapStage}>
        <MapCanvas
          sheet={sheet}
          map={map}
          columns={columns}
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
          onColumnsCommitted={commitColumns}
          onHover={setHover}
        />
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
                {hover ? `${columns.heightAt(hover.x, hover.y)}` : "—"} / {columns.columnCount} cells
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
              maxColumnHeight={MAX_MAP_COLUMN_HEIGHT}
            />
          </GeneratorPanel>
        ) : layer === "tiles" ? (
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
            {isColumnLayer(layer) && (
              <>
                <div className={styles.panelHead} style={{ marginTop: 14 }}>
                  <span className={styles.panelTitle}>Material</span>
                  <span className={styles.panelMeta}>
                    {columnMaterial < 0 ? "flat" : BUILD_MATERIALS.find((entry) => entry.material === columnMaterial)?.name}
                  </span>
                </div>
                <div className={styles.paletteGrid}>
                  <button
                    type="button"
                    className={`${styles.swatch} ${columnMaterial < 0 ? styles.swatchActive : ""}`}
                    style={{ background: palette[colorIndex] ?? "#000", outline: "1px dashed var(--faint)" }}
                    onClick={() => setColumnMaterial(COLUMN_MATERIAL_NONE)}
                    title="Flat — raise columns in the palette colour, with no texture"
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
              </>
            )}
            <p className={styles.pickerHint}>
              {layer === "pixels"
                ? "Pixels belong to the tile, not the cell — editing one cell changes every cell that stamps the same tile. A colour with a material swatch stamps its whole profile, exactly as in the Sprites tab."
                : `Raise builds ${shapeForLayer(layer)} columns up to ${MAX_MAP_COLUMN_HEIGHT} cells tall, skinned with the armed material. Brightness shows height; ${
                    layer === "hexels" ? "diamonds mark the close-packed lattice" : "squares mark cube columns"
                  }.`}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
