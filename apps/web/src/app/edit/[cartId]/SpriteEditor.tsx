"use client";

/**
 * Sprite editor: owns the editing state (page, selected tile, colour, tool) and
 * lays out the three work zones — tool rail, canvas stage, and inspector. The
 * SpriteSheet holds the actual pixels; `version` bumps to re-render views after
 * an in-place edit.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  parsePaletteFile,
  parseAseprite,
  encodeAseprite,
  gradientSortOrder,
  materialProfileAt,
  MATERIAL_LEVELS,
  type SpriteSheet,
  type SpritePage,
  type NormalMap,
  type MaterialMap,
  type MaterialSwatches,
  type SpriteRig,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { decodeBase64Bytes, encodePropArt } from "@/lib/backdropProps";
import {
  clearPendingPropEdit,
  loadPendingPropEdit,
  loadPublishedSet,
  loadWorkingSet,
  saveWorkingSet,
  type PendingPropEdit,
} from "@/lib/backdropPropsStore";
import { readBlockAlbedo, readBlockMaterial } from "./blockBuffers";
import { PixelCanvas } from "./PixelCanvas";
import { TilePicker } from "./TilePicker";
import { PalettePicker } from "./PalettePicker";
import { LitPreview } from "./LitPreview";
import { VoxelPreview } from "./VoxelPreview";
import { RigPanel } from "./RigPanel";
import { MaterialSwatchPanel } from "./MaterialSwatchPanel";
import { MaterialSurface, NormalSurface } from "./paintSurface";
import { MaterialBrushSurface } from "./materialBrushSurface";
import { SpriteBlockSurface } from "./spriteBlockSurface";
import {
  TOOLS,
  WEIGHTED_TOOLS,
  TOLERANCE_TOOLS,
  MAX_BRUSH_WEIGHT,
  MAX_TOLERANCE,
  type Tool,
} from "./tools";

type Layer = "albedo" | "normal" | "material" | "height" | "specular" | "roughness" | "emissive";

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
  material: "Material",
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
  /** Per-colour material bindings, owned by the workbench so they persist on Save. */
  swatches: MaterialSwatches;
  onSwatchesChange: (swatches: MaterialSwatches) => void;
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
  swatches,
  onSwatchesChange,
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
  const [asepriteNote, setAsepriteNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const paletteFileRef = useRef<HTMLInputElement>(null);
  const asepriteFileRef = useRef<HTMLInputElement>(null);

  const bump = () => setVersion((current) => current + 1);

  // --- Backdrop prop publishing ---------------------------------------------
  // When the backdrop manager hands off a prop to "Edit pixels", seed the sheet
  // with its pixels once on mount so you draw over the existing art.
  const [pendingProp] = useState<PendingPropEdit | null>(() => loadPendingPropEdit());
  const seededPending = useRef(false);
  useEffect(() => {
    if (seededPending.current || !pendingProp) return;
    seededPending.current = true;
    // Grow the editing block so the prop's pixels fit before importing them.
    const longest = Math.max(pendingProp.width, pendingProp.height);
    setSpriteSize(longest <= sheet.tileSize ? 1 : longest <= sheet.tileSize * 2 ? 2 : 4);
    const data = new Uint8ClampedArray(decodeBase64Bytes(pendingProp.albedo));
    sheet.importImage({ data, width: pendingProp.width, height: pendingProp.height }, page);
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Publish the current sprite block as a backdrop prop (overwrite or add). */
  const publishBackdropProp = async () => {
    const dim = sheet.tileSize * spriteSize;
    const albedo = readBlockAlbedo(sheet, page, tile, spriteSize);
    const material = readBlockMaterial(height, specular, roughness, emissive, sheet, page, tile, spriteSize);
    const emissivePlane = new Uint8Array(dim * dim);
    for (let i = 0; i < dim * dim; i += 1) emissivePlane[i] = material[i * 4 + 3] ?? 0;
    const art = encodePropArt(albedo, emissivePlane, dim, dim);

    const base = loadWorkingSet() ?? (await loadPublishedSet());
    const target = pendingProp?.targetId;
    let next;
    if (target && base.props.some((p) => p.id === target)) {
      // Editing an existing prop: replace its pixels, keep placement + motion.
      next = { ...base, props: base.props.map((p) => (p.id === target ? { ...p, art } : p)) };
    } else {
      const name = pendingProp?.name ?? window.prompt("Name this backdrop prop", "New prop") ?? "New prop";
      next = {
        ...base,
        props: [
          ...base.props,
          {
            id: `prop-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now()}`,
            name,
            art,
            depth: 6,
            fx: 0.5,
            fy: 0.5,
            cell: 2,
            motion: { bobAmplitude: 3, bobPeriod: 4, bobPhase: Math.random(), spinCycle: 12, spinDuration: 3, spinPhase: Math.random() },
          },
        ],
      };
    }
    saveWorkingSet(next);
    clearPendingPropEdit();
    window.alert(
      `Published to your backdrop working set. Open /backdrop to arrange it — it previews live on the onboarding screen.`,
    );
  };

  // The pixel canvas paints albedo (SpriteSheet), normals, or a material ramp
  // (height/specular/roughness/emissive) — all match the PaintSurface shape, so
  // the canvas doesn't care which is active.
  const normalSurface = useMemo(() => new NormalSurface(normals, sheet.tileSize), [normals, sheet]);
  const heightSurface = useMemo(() => new MaterialSurface(height, sheet.tileSize), [height, sheet]);
  const specularSurface = useMemo(() => new MaterialSurface(specular, sheet.tileSize), [specular, sheet]);
  const roughnessSurface = useMemo(() => new MaterialSurface(roughness, sheet.tileSize), [roughness, sheet]);
  const emissiveSurface = useMemo(() => new MaterialSurface(emissive, sheet.tileSize), [emissive, sheet]);

  // The composite "material" brush paints albedo and every channel at once,
  // reading each colour's profile through a ref so its identity stays stable as
  // swatches are edited (a rebuilt surface would drop the canvas selection).
  const swatchesRef = useRef(swatches);
  swatchesRef.current = swatches;
  const materialBrush = useMemo(
    () =>
      new MaterialBrushSurface(
        sheet,
        {
          normal: normalSurface,
          height: heightSurface,
          specular: specularSurface,
          roughness: roughnessSurface,
          emissive: emissiveSurface,
        },
        (index) => materialProfileAt(swatchesRef.current, index),
      ),
    [sheet, normalSurface, heightSurface, specularSurface, roughnessSurface, emissiveSurface],
  );

  const materialMap =
    layer === "specular" ? specular : layer === "roughness" ? roughness : layer === "emissive" ? emissive : height;
  const baseSurface =
    layer === "albedo"
      ? sheet
      : layer === "material"
        ? materialBrush
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
  // The material brush paints in the albedo palette-index domain — it just also
  // stamps the colour's material channels — so it shares albedo's value/palette.
  const paintsPalette = layer === "albedo" || layer === "material";
  const activeValue = paintsPalette ? color : layer === "normal" ? direction : level;
  const setActiveValue = paintsPalette ? setColor : layer === "normal" ? setDirection : setLevel;
  const paletteColors = paintsPalette
    ? sheet.cssPalette()
    : layer === "normal"
      ? Array.from({ length: normals.directionCount }, (_unused, index) => normals.colorHex(index))
      : Array.from({ length: MATERIAL_LEVELS }, (_unused, index) => materialMap.colorHex(index));

  // Display the albedo palette as a gradient (grays, then hue→lightness) without
  // touching the underlying indices. Normal-direction swatches are left as-is.
  const paletteOrder = paintsPalette && sortPalette ? gradientSortOrder(paletteColors) : undefined;

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

  // Import an Aseprite sprite: adopt its palette so indexed colours map exactly,
  // then lay every animation frame onto the active page as consecutive tile
  // blocks (frame 0 top-left, wrapping across the sheet) so the animation becomes
  // a run of sprites the cart can flip through with `spr(base + frame)`.
  const importAseprite = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAsepriteNote("Reading…");
    try {
      const document_ = await parseAseprite(new Uint8Array(await file.arrayBuffer()));
      if (document_.frames.length === 0) {
        setAsepriteNote("That Aseprite file has no frames.");
        return;
      }
      if (document_.palette.length > 0) sheet.applyPalette(document_.palette);
      const frames = document_.frames.map((frame) => ({
        data: frame.pixels,
        width: document_.width,
        height: document_.height,
      }));
      const { placed, skipped, tilesWide, tilesHigh, cropped } = sheet.importFrames(frames, page);
      if (cropped) {
        setAsepriteNote(
          `Imported the top-left ${sheet.sheetSize}×${sheet.sheetSize} — source is ${document_.width}×${document_.height}, ` +
            `larger than the sprite sheet. Resize it to ${sheet.sheetSize}px or smaller for a full import.`,
        );
      } else {
        const blockLabel = `${tilesWide * sheet.tileSize}×${tilesHigh * sheet.tileSize}`;
        setAsepriteNote(
          `Imported ${placed} frame${placed === 1 ? "" : "s"} (${blockLabel} each)` +
            (skipped > 0 ? ` — ${skipped} didn't fit the page` : "") +
            ".",
        );
      }
      bump();
    } catch (error) {
      setAsepriteNote(error instanceof Error ? error.message : "Could not read that Aseprite file.");
    }
  };

  // Export the active page as an indexed .aseprite, preserving the exact palette
  // index of every pixel so the sprites reopen in Aseprite unchanged.
  const exportAseprite = async () => {
    try {
      const { indices, width, height } = sheet.exportIndexed(page);
      const bytes = await encodeAseprite({ width, height, palette: sheet.paletteRgb(), indices });
      const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cartbox-sprites-page${page}.aseprite`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setAsepriteNote(error instanceof Error ? error.message : "Could not export the Aseprite file.");
    }
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
            <button
              type="button"
              className={`${styles.segment} ${layer === "material" ? styles.segmentActive : ""}`}
              onClick={() => setLayer("material")}
              title="Paint albedo and every material channel at once from the colour's swatch"
            >
              Material
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

        <div>
          <div className={styles.groupLabel}>Aseprite</div>
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => asepriteFileRef.current?.click()}
              title="Import an Aseprite sprite (.aseprite / .ase): adopts its palette and lays every animation frame across the page's tiles"
            >
              <span className={styles.toolGlyph} aria-hidden>
                ⭳
              </span>
              Import Aseprite
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={exportAseprite}
              title="Export this page as an indexed .aseprite you can edit in Aseprite"
            >
              <span className={styles.toolGlyph} aria-hidden>
                ⭱
              </span>
              Export Aseprite
            </button>
          </div>
          <input
            ref={asepriteFileRef}
            type="file"
            accept=".aseprite,.ase"
            onChange={importAseprite}
            hidden
          />
          {asepriteNote && (
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, lineHeight: 1.35 }}>{asepriteNote}</div>
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
          title={
            layer === "albedo"
              ? "Palette"
              : layer === "material"
                ? "Material colors"
                : layer === "normal"
                  ? "Direction"
                  : LAYER_LABEL[layer]
          }
          subtitle={
            paintsPalette ? `${sheet.paletteSize} colors` : layer === "normal" ? "16 normals" : `${MATERIAL_LEVELS} levels`
          }
          order={paletteOrder}
          sorted={sortPalette}
          onToggleSort={paintsPalette ? () => setSortPalette((value) => !value) : undefined}
        />
        {layer === "material" && (
          <MaterialSwatchPanel
            colorIndex={color}
            colorCss={sheet.cssColor(color)}
            swatches={swatches}
            onChange={onSwatchesChange}
          />
        )}
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
            <button type="button" className={styles.langSelect} onClick={() => void publishBackdropProp()}>
              {pendingProp?.targetId ? `Update "${pendingProp.name}"` : "Publish as backdrop prop"}
            </button>
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
