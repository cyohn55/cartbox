"use client";

/**
 * Sprite editor: the pixel half of the Assets tab. It owns its own tool state
 * (tool, brush, layer) and lays out the three work zones — tool rail, canvas
 * stage, and inspector. The SpriteSheet holds the actual pixels; `version` bumps
 * to re-render views after an in-place edit.
 *
 * What it does *not* own is which block is open or which colour is active: both
 * are lifted to the Assets container, so a named sprite asset can point at a
 * block and so a colour picked here is still the colour in the voxel sculptor.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  parsePaletteFile,
  parseAseprite,
  encodeAseprite,
  gradientSortOrder,
  isMaterialSwatchEnabled,
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
import { blockTileIndex } from "./spriteBlock";
import { PixelCanvas } from "./PixelCanvas";
import { TilePicker } from "./TilePicker";
import { PalettePicker } from "./PalettePicker";
import { LitPreview } from "./LitPreview";
import { litSpriteCode } from "./litSpriteCode";
import { VoxelPreview } from "./VoxelPreview";
import { RigPanel } from "./RigPanel";
import { MaterialSwatchPanel } from "./MaterialSwatchPanel";
import { MaterialSurface, NormalSurface, type PaintSurface } from "./paintSurface";
import { MaterialBrushSurface } from "./materialBrushSurface";
import { SpriteBlockSurface } from "./spriteBlockSurface";
import { measureCoverage, sampleChannels, valueUsage } from "./layerCoverage";
import { RailGroup, RailHint, RangeControl, SegmentedControl, ToolRail } from "./railControls";
import { SurfaceToolsPanel } from "./SurfaceToolsPanel";
import {
  InspectorHint,
  InspectorPanel,
  WorkbenchInspector,
  WorkbenchRail,
  type InspectorSlots,
  type RailSlots,
} from "./workbenchPanels";
import { capabilitiesOf } from "./toolCapabilities";
import { SPRITE_TOOL_SHORTCUTS, TOOLS, MAX_BRUSH_WEIGHT, MAX_TOLERANCE, type Tool } from "./tools";
import { MAX_ZOOM, MIN_ZOOM } from "./PixelCanvas";
import { useShortcuts, type Shortcut } from "./shortcuts";

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

/** The layer picker's options, in rail order. */
const LAYER_OPTIONS: ReadonlyArray<{ id: Layer; label: string; hint?: string }> = [
  { id: "albedo", label: "Albedo" },
  { id: "normal", label: "Normal" },
  {
    id: "material",
    label: "Material",
    hint: "Paint albedo and every material channel at once from the colour's swatch",
  },
  ...MATERIAL_LAYERS,
];

/** Sprite sizes offered, as tiles-per-side. A base tile is 8px, so 1/2/4 tiles
 *  per side are 8×8, 16×16, and 32×32 sprites (blocks of adjacent tiles). */
const SPRITE_SIZES = [
  { id: 1, label: "8×8" },
  { id: 2, label: "16×16" },
  { id: 4, label: "32×32" },
] as const;

/** The sprite sheet's two pages, as the rail names them. */
const PAGE_OPTIONS = [
  { id: 0, label: "Tiles" },
  { id: 1, label: "Sprites" },
] as const;

/**
 * The layers the coverage readout probes, in the order it reports them.
 *
 * Albedo is absent because it is what the coverage annotates, and "material" is
 * absent because it is not a plane of its own — it is the composite brush that
 * writes the other five at once, so its work already shows up in them.
 */
const COVERAGE_LAYERS = ["normal", "height", "specular", "roughness", "emissive"] as const;
type CoverageLayer = (typeof COVERAGE_LAYERS)[number];

/** Whether the canvas ticks the pixels carrying other-layer data. */
const COVERAGE_OPTIONS = [
  { id: "off", label: "Hide", hint: "Show the active layer alone." },
  { id: "on", label: "Layers", hint: "Tick the pixels that carry data on another layer." },
] as const;

/**
 * What each tool does, for the inspector's closing note.
 *
 * The map editor and the sculptor have always ended their inspector with a
 * sentence explaining the active tool; the sprite editor was the one drawing
 * surface without one, which made the same footnote look like a map-only idea
 * rather than the workbench's way of explaining a tool.
 */
const TOOL_HINT: Record<Tool, string> = {
  pencil: "Drag to paint. Raise Brush size to draw a thicker stroke; right-click paints colour 0.",
  eraser: "Drag to clear pixels back to colour 0 — transparent wherever the sprite is drawn over something.",
  fill: "Click to flood the connected run of matching pixels. Raise Tolerance to spread across near-matching shades.",
  wand: "Click to select the connected run of matching pixels. Raise Tolerance to grab shaded neighbours too.",
  marquee:
    "Drag out a box to select it, then drag inside it to move it. Arrows nudge, H and V flip, R rotates, Ctrl+C/X/V copy, cut and paste.",
  picker: "Click a pixel to take its colour as the active one. Alt-click does the same with any tool held.",
  line: "Drag from one point to another; the line previews live and commits when you let go.",
  rect: "Drag out a rectangle; it previews live and commits when you let go.",
  ellipse: "Drag out an ellipse from corner to corner; it previews live and commits when you let go.",
};

/**
 * Which block of the sheet is being edited. Lifted out of this component so a
 * named sprite asset can address it — selecting one in the asset browser moves
 * the editor here, and creating one records wherever the editor already is.
 */
export interface SpriteSelection {
  readonly page: SpritePage;
  readonly tile: number;
  /** Block size in tiles per side (1/2/4 → 8×8/16×16/32×32). */
  readonly tilesPerSide: number;
}

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
  /** Which block of the sheet is open — owned above so an asset can address it. */
  /** Changes when the cart in engine memory is replaced (undo, bank switch). */
  resyncKey: string;
  selection: SpriteSelection;
  onSelectionChange: (selection: SpriteSelection) => void;
  /**
   * The active palette index, shared with the voxel sculptor so picking a colour
   * in one medium is picking it in the other.
   */
  color: number;
  onColorChange: (index: number) => void;
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
  resyncKey,
  selection,
  onSelectionChange,
  color,
  onColorChange,
}: SpriteEditorProps) {
  const { page, tile, tilesPerSide: spriteSize } = selection;
  const setPage = (next: SpritePage) => onSelectionChange({ ...selection, page: next });
  const setTile = (next: number) => onSelectionChange({ ...selection, tile: next });
  const setSpriteSize = (next: number) => onSelectionChange({ ...selection, tilesPerSide: next });
  const setColor = onColorChange;
  const [tool, setTool] = useState<Tool>("pencil");
  const [zoom, setZoom] = useState(1); // on-screen scale of the pixel canvas
  const [weight, setWeight] = useState(1); // brush/line thickness in pixels
  const [tolerance, setTolerance] = useState(0); // fill/wand colour tolerance (0..100)
  const [fillShape, setFillShape] = useState(false); // rect/ellipse: fill interior vs outline
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [layer, setLayer] = useState<Layer>("albedo");
  const [direction, setDirection] = useState(1);
  const [level, setLevel] = useState(8); // brush value for material (height/spec/rough) layers
  const [sortPalette, setSortPalette] = useState(true); // show palette as a gradient
  const [usedColorsOnly, setUsedColorsOnly] = useState(false); // hide palette colours this block never uses
  const [showCoverage, setShowCoverage] = useState(false); // tick pixels carrying other-layer data
  const [preferCpu, setPreferCpu] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [paletteNote, setPaletteNote] = useState("");
  const [asepriteNote, setAsepriteNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const paletteFileRef = useRef<HTMLInputElement>(null);
  const asepriteFileRef = useRef<HTMLInputElement>(null);

  const bump = () => setVersion((current) => current + 1);

  /**
   * The cart underneath was replaced — an undo, a redo, or a bank switch — so
   * everything read from the sheet is stale. Bumping the version re-derives it
   * all; the editor used to be remounted instead, which threw away the tool,
   * the brush size, the zoom and the canvas selection every time a creator
   * pressed Ctrl+Z.
   */
  useEffect(() => {
    setVersion((current) => current + 1);
  }, [resyncKey]);

  // Which optional rail sliders the active tool drives — asked of the tool table
  // rather than of a separate list of ids kept in step by hand.
  const toolControls = capabilitiesOf(TOOLS, tool);

  // --- Backdrop prop publishing ---------------------------------------------
  // When the backdrop manager hands off a prop to "Edit pixels", seed the sheet
  // with its pixels once on mount so you draw over the existing art.
  const [pendingProp] = useState<PendingPropEdit | null>(() => loadPendingPropEdit());
  const seededPending = useRef(false);
  useEffect(() => {
    if (seededPending.current || !pendingProp) return;
    seededPending.current = true;
    // One combined update, not two: the setters each derive from the selection
    // captured this render, so a second call would discard the first's change.
    // importImage writes at the sheet's top-left (tile 0), so view + publish the
    // block anchored there — otherwise the default tile offset clips the prop's
    // left edge out of view — and the block grows so the whole prop fits.
    const longest = Math.max(pendingProp.width, pendingProp.height);
    onSelectionChange({
      ...selection,
      tile: 0,
      tilesPerSide: longest <= sheet.tileSize ? 1 : longest <= sheet.tileSize * 2 ? 2 : 4,
    });
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

  /** Whether the open block has any painted emissive pixels (worth a code note). */
  const blockHasEmissive = (): boolean => {
    const size = sheet.tileSize;
    for (let tileRow = 0; tileRow < spriteSize; tileRow += 1) {
      for (let tileColumn = 0; tileColumn < spriteSize; tileColumn += 1) {
        const subTile = blockTileIndex(tile, tileRow, tileColumn, sheet.sheetCols);
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            if (emissive.getValue(page, subTile, x, y) > 0) return true;
          }
        }
      }
    }
    return false;
  };

  /**
   * Copy a runnable, lit cart scaffold for the open sprite block — the gap-#7
   * bridge from an authored normal-mapped sprite to a code-driven scene. Paste it
   * into the Code tab and the engine relights the sprite's authored normals.
   */
  const copyLitSpriteCode = async () => {
    const code = litSpriteCode({ page, tile, tilesPerSide: spriteSize, emissive: blockHasEmissive() });
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard blocked (permissions / insecure context): show it to copy by hand.
      window.prompt("Copy this lit-sprite cart code:", code);
    }
    setCodeCopied(true);
    window.setTimeout(() => setCodeCopied(false), 1600);
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

  /**
   * Single-key tool selection and brush sizing.
   *
   * Every binding comes from the tool table, so a tool cannot be added to the
   * palette and left unbound — or bound to a key the help overlay never lists.
   * `useShortcuts` suppresses bare letters while a field has focus, which is
   * what keeps "b" from switching tools while someone types a sprite's name.
   */
  const toolShortcuts = useMemo<ReadonlyArray<readonly [Shortcut, () => void]>>(
    () => [
      ...SPRITE_TOOL_SHORTCUTS.map(
        (binding) =>
          [
            { key: binding.key, label: binding.label, group: "Tools" as const },
            () => setTool(binding.tool),
          ] as const,
      ),
      [
        { key: "[", label: "Smaller brush", group: "Tools" as const },
        () => setWeight((current) => Math.max(1, current - 1)),
      ],
      [
        { key: "]", label: "Bigger brush", group: "Tools" as const },
        () => setWeight((current) => Math.min(MAX_BRUSH_WEIGHT, current + 1)),
      ],
    ],
    [],
  );
  useShortcuts(toolShortcuts);
  const paletteColors = paintsPalette
    ? sheet.cssPalette()
    : layer === "normal"
      ? Array.from({ length: normals.directionCount }, (_unused, index) => normals.colorHex(index))
      : Array.from({ length: MATERIAL_LEVELS }, (_unused, index) => materialMap.colorHex(index));

  // Display the albedo palette as a gradient (grays, then hue→lightness) without
  // touching the underlying indices. Normal-direction swatches are left as-is.
  const paletteOrder = paintsPalette && sortPalette ? gradientSortOrder(paletteColors) : undefined;

  // --- What the other six layers carry --------------------------------------
  // The block shows one layer at a time, so everything painted on the other six
  // is invisible from here. These reads answer the three questions that were
  // unanswerable: which layers this block uses, which pixels carry the work, and
  // what every channel says at the pixel under the cursor.
  // Each probed layer's surface, addressed over the *block* rather than the tile
  // — the same wrapper the canvas paints through, so a 2× or 4× sprite reports
  // its whole area instead of its top-left tile.
  const channelSurfaces = useMemo<Record<CoverageLayer, PaintSurface>>(() => {
    const base: Record<CoverageLayer, PaintSurface> = {
      normal: normalSurface,
      height: heightSurface,
      specular: specularSurface,
      roughness: roughnessSurface,
      emissive: emissiveSurface,
    };
    if (spriteSize === 1) return base;
    const wrapped = { ...base };
    for (const id of COVERAGE_LAYERS) {
      wrapped[id] = new SpriteBlockSurface(base[id], sheet.sheetCols, spriteSize);
    }
    return wrapped;
  }, [normalSurface, heightSurface, specularSurface, roughnessSurface, emissiveSurface, sheet, spriteSize]);

  const channels = useMemo(
    () => COVERAGE_LAYERS.map((id) => ({ id, surface: channelSurfaces[id] })),
    [channelSurfaces],
  );

  const blockSize = sheet.tileSize * spriteSize;
  const coverage = useMemo(
    () => measureCoverage(channels, page, tile, blockSize),
    // `version` is the dependency that matters and is not otherwise read here:
    // the surfaces are mutated in place, so their identity does not change when
    // their pixels do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, page, tile, blockSize, version],
  );

  // Palette usage drives both the per-chip counts and the "in use" filter, and
  // is only meaningful for the albedo domain — a ramp level is not a colour a
  // sprite "uses". Measured on the albedo surface whatever layer is active, so
  // switching to Height does not empty the counts.
  const albedoBlock = useMemo(
    () => (spriteSize === 1 ? sheet : new SpriteBlockSurface(sheet, sheet.sheetCols, spriteSize)),
    [sheet, spriteSize],
  );
  const paletteUsage = useMemo(
    () => (paintsPalette ? valueUsage(albedoBlock, page, tile, blockSize) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [albedoBlock, page, tile, blockSize, paintsPalette, version],
  );

  // Which palette colours stamp a whole material profile when painted with.
  const materialColors = useMemo(() => {
    const marked = new Set<number>();
    for (let index = 0; index < sheet.paletteSize; index += 1) {
      if (isMaterialSwatchEnabled(swatches, index)) marked.add(index);
    }
    return marked;
  }, [swatches, sheet.paletteSize]);

  // Every channel's value at the pixel under the cursor, for the readout.
  const hoveredChannels = useMemo(
    () => (hover ? sampleChannels(channels, page, tile, hover.x, hover.y) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, page, tile, hover, version],
  );
  const hoveredColor = hover ? albedoBlock.getPixel(page, tile, hover.x, hover.y) : null;

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

  // Every rail control and inspector panel is handed to the shared containers by
  // slot; they decide the order, identically for every tab. See workbenchLayout.
  const rail: RailSlots = {
    view: (
      <>
        <SegmentedControl
          label="Page"
          options={PAGE_OPTIONS}
          selected={page}
          onSelect={(id) => setPage(id === 1 ? 1 : 0)}
        />
        <SegmentedControl
          label="Sprite size"
          options={SPRITE_SIZES}
          selected={spriteSize}
          onSelect={setSpriteSize}
        />
      </>
    ),

    layer: (
      <RailGroup label="Layer">
        <SegmentedControl options={LAYER_OPTIONS} selected={layer} onSelect={setLayer} wrap ariaLabel="Layer" />
        <SegmentedControl
          options={COVERAGE_OPTIONS}
          selected={showCoverage ? "on" : "off"}
          onSelect={(id) => setShowCoverage(id === "on")}
          ariaLabel="Show other-layer coverage"
          spaced
        />
        <RailHint>
          {coverage.channels.length === 0
            ? "Nothing painted on the other layers yet."
            : showCoverage
              ? `Ticked pixels carry ${coverage.channels.map((id) => LAYER_LABEL[id]).join(", ").toLowerCase()} data.`
              : `This block also uses ${coverage.channels.map((id) => LAYER_LABEL[id]).join(", ").toLowerCase()}.`}
        </RailHint>
      </RailGroup>
    ),

    tool: <ToolRail label="Tool" tools={TOOLS} selected={tool} onSelect={setTool} />,

    toolOptions: (
      <>
        <RangeControl
          label="Zoom"
          min={MIN_ZOOM * 100}
          max={MAX_ZOOM * 100}
          step={25}
          value={Math.round(zoom * 100)}
          onChange={(next) => setZoom(next / 100)}
          ariaLabel="Canvas zoom"
          display={`${Math.round(zoom * 100)}%`}
        />
        {toolControls.weighted && (
          <RangeControl
            label="Brush size"
            min={1}
            max={MAX_BRUSH_WEIGHT}
            value={weight}
            onChange={setWeight}
            ariaLabel="Brush size in pixels"
            display={`${weight}px`}
          />
        )}
        {toolControls.tolerant && (
          <RangeControl
            label="Tolerance"
            min={0}
            max={MAX_TOLERANCE}
            value={tolerance}
            onChange={setTolerance}
            ariaLabel="Fill and magic-wand tolerance"
            display={`${tolerance}%`}
          />
        )}
        {/* Rectangle/ellipse can draw a hollow outline or a solid fill — the fill
            is the fast path for blocking in shapes (previously only flood-fill
            could fill an area, which needs an already-closed boundary). */}
        {(tool === "rect" || tool === "ellipse") && (
          <SegmentedControl
            label="Shape"
            options={[
              { id: "outline", label: "Outline" },
              { id: "fill", label: "Fill" },
            ]}
            selected={fillShape ? "fill" : "outline"}
            onSelect={(id) => setFillShape(id === "fill")}
            ariaLabel="Shape fill mode"
          />
        )}
      </>
    ),

    io: (
      <>
        <RailGroup label="Image">
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
        </RailGroup>

        {/* "Palette file", not "Palette": the inspector's colour picker is the
            Palette, and two groups by that name on opposite sides of the screen
            is precisely the kind of collision this tab had too much of. This one
            loads a palette *file*. */}
        <RailGroup label="Palette file">
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
          {paletteNote && <RailHint>{paletteNote}</RailHint>}
        </RailGroup>

        <RailGroup label="Aseprite">
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
          {asepriteNote && <RailHint>{asepriteNote}</RailHint>}
        </RailGroup>
      </>
    ),
  };

  const inspector: InspectorSlots = {
    // The generative tools (derive materials, pixelate, texture fill, LUT grade)
    // are procedural fills, so they live in the inspector's `generate` slot — which
    // folds them behind one "Generate" disclosure — rather than padding the rail's
    // import/export stack. Each is a start the artist can then paint over.
    generate: (
      <SurfaceToolsPanel
        sheet={sheet}
        normals={normals}
        height={height}
        specular={specular}
        roughness={roughness}
        emissive={emissive}
        selection={selection}
        color={color}
        onEdit={bump}
      />
    ),
    source: (
      <TilePicker
        sheet={sheet}
        page={page}
        selected={tile}
        version={version}
        onSelect={setTile}
        blockTiles={spriteSize}
      />
    ),

    palette: (
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
        materials={paintsPalette ? materialColors : undefined}
        usage={paletteUsage}
        usedOnly={usedColorsOnly}
        onToggleUsedOnly={paintsPalette ? () => setUsedColorsOnly((value) => !value) : undefined}
      />
    ),

    material: (
      <>
        {layer === "material" && (
          <MaterialSwatchPanel
            colorIndex={color}
            colorCss={sheet.cssColor(color)}
            swatches={swatches}
            onChange={onSwatchesChange}
          />
        )}

        {/* Every layer's value at the pixel under the cursor. The HUD only ever
            showed the layer you were on, so the other six were unreadable
            without switching to each in turn and hovering again. */}
        <InspectorPanel
          title="Pixel layers"
          meta={hover ? `${hover.x},${hover.y}` : "—"}
        >
          {hoveredChannels === null || hoveredColor === null ? (
            <p className={styles.inspectorHint}>Hover the canvas to read every layer at a pixel.</p>
          ) : (
            <dl className={styles.layerReadout}>
              <div className={styles.layerRow}>
                <dt>{LAYER_LABEL.albedo}</dt>
                <dd>
                  <span className={styles.hudChip} style={{ background: sheet.cssColor(hoveredColor) }} />
                  <span className="data">{hoveredColor.toString().padStart(2, "0")}</span>
                  {materialColors.has(hoveredColor) && <span className={styles.layerTag}>material</span>}
                </dd>
              </div>
              {COVERAGE_LAYERS.map((id) => {
                const value = hoveredChannels[id];
                return (
                  // Unpainted channels are dimmed rather than hidden: a row that
                  // disappears makes the readout a different height per pixel,
                  // and "this layer is empty here" is itself the answer half the
                  // time this panel is being read.
                  <div key={id} className={styles.layerRow} data-empty={value === 0}>
                    <dt>{LAYER_LABEL[id]}</dt>
                    <dd>
                      <span
                        className={styles.hudChip}
                        style={{ background: channelSurfaces[id].cssColor(value) }}
                      />
                      <span className="data">{value}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </InspectorPanel>
      </>
    ),

    preview: (
      <>
        <InspectorPanel
          title="Lit preview"
          action={
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className={styles.rendererToggle}
                onClick={() => void copyLitSpriteCode()}
                title="Copy runnable cart code that draws this sprite lit — paste into the Code tab"
              >
                {codeCopied ? "Copied ✓" : "Copy cart code"}
              </button>
              <button
                type="button"
                className={styles.rendererToggle}
                onClick={() => setPreferCpu((value) => !value)}
                title="Toggle GPU/CPU to verify they match"
              >
                {preferCpu ? "Force CPU" : "Auto (GPU)"}
              </button>
            </div>
          }
        >
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
        </InspectorPanel>

        <InspectorPanel
          title="Voxel preview"
          action={
            <button type="button" className={styles.langSelect} onClick={() => void publishBackdropProp()}>
              {pendingProp?.targetId ? `Update "${pendingProp.name}"` : "Publish as backdrop prop"}
            </button>
          }
        >
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
        </InspectorPanel>
      </>
    ),

    extras: (
      <InspectorPanel title="Character rig">
        <RigPanel
          sheet={sheet}
          page={page}
          tile={tile}
          blockTiles={spriteSize}
          version={version}
          rig={rig}
          onRigChange={onRigChange}
        />
      </InspectorPanel>
    ),

    hint: <InspectorHint>{TOOL_HINT[tool]}</InspectorHint>,
  };

  return (
    <div className={styles.body}>
      <WorkbenchRail slots={rail} />

      <section className={styles.stage}>
        <PixelCanvas
          surface={surface}
          page={page}
          tile={tile}
          value={activeValue}
          tool={tool}
          weight={weight}
          tolerance={tolerance}
          fillShape={fillShape}
          version={version}
          zoom={zoom}
          onEdit={bump}
          onHover={setHover}
          onPickValue={setActiveValue}
          // Only over albedo/material: on Height, ticking "this pixel has height
          // data" would annotate the very plane it was read from.
          coverage={showCoverage && paintsPalette ? coverage.pixels : null}
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

      <WorkbenchInspector slots={inspector} />
    </div>
  );
}
