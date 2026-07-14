"use client";

/**
 * Sprite editor: owns the editing state (page, selected tile, colour, tool) and
 * lays out the three work zones — tool rail, canvas stage, and inspector. The
 * SpriteSheet holds the actual pixels; `version` bumps to re-render views after
 * an in-place edit.
 */

import { useMemo, useRef, useState } from "react";
import {
  parsePaletteFile,
  gradientSortOrder,
  MATERIAL_LEVELS,
  type SpriteSheet,
  type SpritePage,
  type NormalMap,
  type MaterialMap,
  type SpriteRig,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { PixelCanvas } from "./PixelCanvas";
import { TilePicker } from "./TilePicker";
import { PalettePicker } from "./PalettePicker";
import { LitPreview } from "./LitPreview";
import { VoxelPreview } from "./VoxelPreview";
import { RigPanel } from "./RigPanel";
import { MaterialSurface, NormalSurface } from "./paintSurface";
import { SpriteBlockSurface } from "./spriteBlockSurface";
import {
  TOOLS,
  WEIGHTED_TOOLS,
  TOLERANCE_TOOLS,
  MAX_BRUSH_WEIGHT,
  MAX_TOLERANCE,
  type Tool,
} from "./tools";

type Layer = "albedo" | "normal" | "height" | "specular" | "roughness" | "emissive";

/** The greyscale-ramp material layers (everything except albedo and normal). */
const MATERIAL_LAYERS: ReadonlyArray<{ id: Layer; label: string }> = [
  { id: "height", label: "Height" },
  { id: "specular", label: "Specular" },
  { id: "roughness", label: "Roughness" },
  { id: "emissive", label: "Emissive" },
];

const LAYER_LABEL: Record<Layer, string> = {
  albedo: "Colour",
  normal: "Normal",
  height: "Height",
  specular: "Specular",
  roughness: "Roughness",
  emissive: "Emissive",
};

/** Sprite sizes offered, as tiles-per-side. A base tile is 8px, so 1/2/4 tiles
 *  per side are 8×8, 16×16, and 32×32 sprites (blocks of adjacent tiles). */
const SPRITE_SIZES = [
  { tilesPerSide: 1, label: "8×8" },
  { tilesPerSide: 2, label: "16×16" },
  { tilesPerSide: 4, label: "32×32" },
] as const;

interface SpriteEditorProps {
  sheet: SpriteSheet;
  normals: NormalMap;
  height: MaterialMap;
  specular: MaterialMap;
  roughness: MaterialMap;
  emissive: MaterialMap;
  /** Cart-wide character rig, owned by the workbench so it can persist on Save. */
  rig: SpriteRig;
  onRigChange: (rig: SpriteRig) => void;
}

export function SpriteEditor({
  sheet,
  normals,
  height,
  specular,
  roughness,
  emissive,
  rig,
  onRigChange,
}: SpriteEditorProps) {
  const [page, setPage] = useState<SpritePage>(0);
  const [tile, setTile] = useState(1);
  const [color, setColor] = useState(1);
  const [tool, setTool] = useState<Tool>("pencil");
  const [weight, setWeight] = useState(1); // brush/line thickness in pixels
  const [tolerance, setTolerance] = useState(0); // fill/wand colour tolerance (0..100)
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [layer, setLayer] = useState<Layer>("albedo");
  const [direction, setDirection] = useState(1);
  const [level, setLevel] = useState(8); // brush value for material (height/spec/rough) layers
  const [spriteSize, setSpriteSize] = useState(1); // tiles per side (1/2/4)
  const [sortPalette, setSortPalette] = useState(true); // show palette as a gradient
  const [preferCpu, setPreferCpu] = useState(false);
  const [paletteNote, setPaletteNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const paletteFileRef = useRef<HTMLInputElement>(null);

  const bump = () => setVersion((current) => current + 1);

  // The pixel canvas paints albedo (SpriteSheet), normals, or a material ramp
  // (height/specular/roughness/emissive) — all match the PaintSurface shape, so
  // the canvas doesn't care which is active.
  const normalSurface = useMemo(() => new NormalSurface(normals, sheet.tileSize), [normals, sheet]);
  const heightSurface = useMemo(() => new MaterialSurface(height, sheet.tileSize), [height, sheet]);
  const specularSurface = useMemo(() => new MaterialSurface(specular, sheet.tileSize), [specular, sheet]);
  const roughnessSurface = useMemo(() => new MaterialSurface(roughness, sheet.tileSize), [roughness, sheet]);
  const emissiveSurface = useMemo(() => new MaterialSurface(emissive, sheet.tileSize), [emissive, sheet]);

  const materialMap =
    layer === "specular" ? specular : layer === "roughness" ? roughness : layer === "emissive" ? emissive : height;
  const baseSurface =
    layer === "albedo"
      ? sheet
      : layer === "normal"
        ? normalSurface
        : layer === "specular"
          ? specularSurface
          : layer === "roughness"
            ? roughnessSurface
            : layer === "emissive"
              ? emissiveSurface
              : heightSurface;
  // For sizes above one tile, wrap the base surface so the canvas edits an N×N
  // block of adjacent tiles as one sprite; 1× is the base surface unchanged.
  const surface = useMemo(
    () => (spriteSize === 1 ? baseSurface : new SpriteBlockSurface(baseSurface, sheet.sheetCols, spriteSize)),
    [baseSurface, sheet, spriteSize],
  );
  const activeValue = layer === "albedo" ? color : layer === "normal" ? direction : level;
  const setActiveValue = layer === "albedo" ? setColor : layer === "normal" ? setDirection : setLevel;
  const paletteColors =
    layer === "albedo"
      ? sheet.cssPalette()
      : layer === "normal"
        ? Array.from({ length: normals.directionCount }, (_unused, index) => normals.colorHex(index))
        : Array.from({ length: MATERIAL_LEVELS }, (_unused, index) => materialMap.colorHex(index));

  // Display the albedo palette as a gradient (grays, then hue→lightness) without
  // touching the underlying indices. Normal-direction swatches are left as-is.
  const paletteOrder = layer === "albedo" && sortPalette ? gradientSortOrder(paletteColors) : undefined;

  const importPng = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(image, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
        sheet.importImage({ data, width, height }, page);
        bump();
      }
      URL.revokeObjectURL(url);
    };
    image.src = url;
  };

  const importPalette = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { colors, format } = parsePaletteFile(String(reader.result ?? ""));
        if (colors.length === 0) {
          setPaletteNote("No colours found in that file.");
          return;
        }
        const applied = sheet.applyPalette(colors);
        const skipped = colors.length - applied;
        setPaletteNote(
          `Loaded ${applied} of ${colors.length} colours (${format})` +
            (skipped > 0 ? ` — ${skipped} over the ${sheet.paletteSize}-colour limit` : "") +
            ".",
        );
        bump();
      } catch {
        setPaletteNote("Could not read that palette file.");
      }
    };
    reader.onerror = () => setPaletteNote("Could not read that palette file.");
    reader.readAsText(file);
  };

  const exportPng = () => {
    const image = sheet.exportImage(page);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const imageData = context.createImageData(image.width, image.height);
    imageData.data.set(image.data);
    context.putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cartbox-sprites-page${page}.png`;
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div>
          <div className={styles.groupLabel}>Layer</div>
          <div className={`${styles.segmented} ${styles.segmentedWrap}`}>
            <button
              type="button"
              className={`${styles.segment} ${layer === "albedo" ? styles.segmentActive : ""}`}
              onClick={() => setLayer("albedo")}
            >
              Albedo
            </button>
            <button
              type="button"
              className={`${styles.segment} ${layer === "normal" ? styles.segmentActive : ""}`}
              onClick={() => setLayer("normal")}
            >
              Normal
            </button>
            {MATERIAL_LAYERS.map((material) => (
              <button
                key={material.id}
                type="button"
                className={`${styles.segment} ${layer === material.id ? styles.segmentActive : ""}`}
                onClick={() => setLayer(material.id)}
              >
                {material.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Tool</div>
          <div className={styles.toolGroup}>
            {TOOLS.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className={`${styles.toolBtn} ${tool === definition.id ? styles.toolBtnActive : ""}`}
                onClick={() => setTool(definition.id)}
                aria-pressed={tool === definition.id}
              >
                <span className={styles.toolGlyph} aria-hidden>
                  {definition.glyph}
                </span>
                {definition.label}
              </button>
            ))}
          </div>
        </div>

        {WEIGHTED_TOOLS.has(tool) && (
          <div>
            <div className={styles.groupLabel}>Brush size</div>
            <div className={styles.rangeRow}>
              <input
                type="range"
                min={1}
                max={MAX_BRUSH_WEIGHT}
                step={1}
                value={weight}
                onChange={(event) => setWeight(Number(event.target.value))}
                aria-label="Brush size in pixels"
              />
              <span className={`${styles.rangeValue} data`}>{weight}px</span>
            </div>
          </div>
        )}

        {TOLERANCE_TOOLS.has(tool) && (
          <div>
            <div className={styles.groupLabel}>Tolerance</div>
            <div className={styles.rangeRow}>
              <input
                type="range"
                min={0}
                max={MAX_TOLERANCE}
                step={1}
                value={tolerance}
                onChange={(event) => setTolerance(Number(event.target.value))}
                aria-label="Fill and magic-wand tolerance"
              />
              <span className={`${styles.rangeValue} data`}>{tolerance}%</span>
            </div>
          </div>
        )}

        <div>
          <div className={styles.groupLabel}>Page</div>
          <div className={styles.segmented}>
            <button
              type="button"
              className={`${styles.segment} ${page === 0 ? styles.segmentActive : ""}`}
              onClick={() => setPage(0)}
            >
              Tiles
            </button>
            <button
              type="button"
              className={`${styles.segment} ${page === 1 ? styles.segmentActive : ""}`}
              onClick={() => setPage(1)}
            >
              Sprites
            </button>
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Sprite size</div>
          <div className={styles.segmented}>
            {SPRITE_SIZES.map((option) => (
              <button
                key={option.tilesPerSide}
                type="button"
                className={`${styles.segment} ${spriteSize === option.tilesPerSide ? styles.segmentActive : ""}`}
                onClick={() => setSpriteSize(option.tilesPerSide)}
                aria-pressed={spriteSize === option.tilesPerSide}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Image</div>
          <div className={styles.toolGroup}>
            <button type="button" className={styles.toolBtn} onClick={() => fileRef.current?.click()}>
              <span className={styles.toolGlyph} aria-hidden>
                ⭳
              </span>
              Import PNG
            </button>
            <button type="button" className={styles.toolBtn} onClick={exportPng}>
              <span className={styles.toolGlyph} aria-hidden>
                ⭱
              </span>
              Export PNG
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/*" onChange={importPng} hidden />
        </div>

        <div>
          <div className={styles.groupLabel}>Palette</div>
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => paletteFileRef.current?.click()}
              title="Import a palette file (Lospec .hex / .gpl / .pal / .txt / .json)"
            >
              <span className={styles.toolGlyph} aria-hidden>
                ⭳
              </span>
              Import palette
            </button>
          </div>
          <input
            ref={paletteFileRef}
            type="file"
            accept=".hex,.gpl,.pal,.txt,.json,text/plain,application/json"
            onChange={importPalette}
            hidden
          />
          {paletteNote && (
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, lineHeight: 1.35 }}>{paletteNote}</div>
          )}
        </div>
      </aside>

      <section className={styles.stage}>
        <PixelCanvas
          surface={surface}
          page={page}
          tile={tile}
          value={activeValue}
          tool={tool}
          weight={weight}
          tolerance={tolerance}
          version={version}
          onEdit={bump}
          onHover={setHover}
        />
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Sprite</span>
            <span className={`${styles.hudValue} data`}>#{tile.toString().padStart(3, "0")}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Pos</span>
            <span className={`${styles.hudValue} data`}>
              {hover ? `${hover.x},${hover.y}` : "—"}
            </span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>{LAYER_LABEL[layer]}</span>
            <span className={styles.hudChip} style={{ background: surface.cssColor(activeValue) }} />
            <span className={`${styles.hudValue} data`}>{surface.cssColor(activeValue)}</span>
          </span>
        </div>
      </section>

      <aside className={styles.inspector}>
        <TilePicker
          sheet={sheet}
          page={page}
          selected={tile}
          version={version}
          onSelect={setTile}
          blockTiles={spriteSize}
        />
        <PalettePicker
          colors={paletteColors}
          selected={activeValue}
          onSelect={setActiveValue}
          title={layer === "albedo" ? "Palette" : layer === "normal" ? "Direction" : LAYER_LABEL[layer]}
          subtitle={
            layer === "albedo"
              ? `${sheet.paletteSize} colors`
              : layer === "normal"
                ? "16 normals"
                : `${MATERIAL_LEVELS} levels`
          }
          order={paletteOrder}
          sorted={sortPalette}
          onToggleSort={layer === "albedo" ? () => setSortPalette((value) => !value) : undefined}
        />
        <div>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Lit preview</span>
            <button
              type="button"
              className={styles.rendererToggle}
              onClick={() => setPreferCpu((value) => !value)}
              title="Toggle GPU/CPU to verify they match"
            >
              {preferCpu ? "Force CPU" : "Auto (GPU)"}
            </button>
          </div>
          <LitPreview
            key={preferCpu ? "cpu" : "auto"}
            forceCpu={preferCpu}
            sheet={sheet}
            normals={normals}
            height={height}
            specular={specular}
            roughness={roughness}
            emissive={emissive}
            page={page}
            tile={tile}
            version={version}
            blockTiles={spriteSize}
          />
        </div>
        <div>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Voxel preview</span>
          </div>
          <VoxelPreview
            sheet={sheet}
            normals={normals}
            height={height}
            specular={specular}
            roughness={roughness}
            emissive={emissive}
            page={page}
            tile={tile}
            version={version}
            blockTiles={spriteSize}
          />
        </div>
        <div>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Character rig</span>
          </div>
          <RigPanel
            sheet={sheet}
            page={page}
            tile={tile}
            blockTiles={spriteSize}
            version={version}
            rig={rig}
            onRigChange={onRigChange}
          />
        </div>
      </aside>
    </div>
  );
}
