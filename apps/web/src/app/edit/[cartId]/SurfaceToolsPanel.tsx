"use client";

/**
 * The Assets tab's generative tools: four things that write into the open sprite
 * block from something other than a brush stroke.
 *
 * - **Materials from art.** Derive normal, height, specular, roughness and
 *   emissive from the pixels already drawn. Until now the only way to fill those
 *   channels was to paint each one by hand or to bind a profile to every palette
 *   entry; this reads the relief the artist has *already* drawn — the light and
 *   dark texels are the height field — and hands back a starting point to edit.
 * - **Image import.** Downscale, dither and quantise an arbitrary image into the
 *   block, rather than the sheet's one-for-one nearest-colour import, which
 *   cannot make pixel art out of anything that is not already pixel art.
 * - **Texture generation.** Fill the block from a seeded procedural pattern,
 *   ramped across a run of palette entries.
 * - **LUT grading.** Re-grade the whole palette through a `.cube` film LUT, which
 *   is the only place on a fantasy console where a colour grade can actually
 *   live.
 *
 * They share a panel because they share a shape — pick settings, press a button,
 * the block changes — and because each is a *start*, not a result. None of them
 * commits anything the artist cannot then paint over.
 *
 * The panel is presentational plus one call each into the model layer; every
 * algorithm it reaches for is pure and tested without a DOM.
 */

import { useRef, useState } from "react";
import {
  DERIVABLE_CHANNELS,
  DITHER_MODES,
  MATERIAL_DERIVE_PARAMS,
  TEXTURE_GENERATORS,
  applyDerivedMaterials,
  defaultValues,
  deriveMaterials,
  findTextureGenerator,
  gradePalette,
  normalizeMaterialDeriveParams,
  parseCubeLut,
  pixelateImage,
  textureToIndices,
  type DitherMode,
  type MaterialChannel,
  type MaterialMap,
  type NormalMap,
  type SpriteSheet,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { readBlockAlbedo } from "./blockBuffers";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";
import type { SpriteSelection } from "./SpriteEditor";

interface SurfaceToolsPanelProps {
  sheet: SpriteSheet;
  normals: NormalMap;
  height: MaterialMap;
  specular: MaterialMap;
  roughness: MaterialMap;
  emissive: MaterialMap;
  /** The block these tools write into. */
  selection: SpriteSelection;
  /** The active palette index — the light end of a generated texture's ramp. */
  color: number;
  /** Something changed in the cart; the editor re-reads and the timeline records. */
  onEdit: () => void;
}

/** How many palette entries a generated texture ramps across, by default. */
const DEFAULT_RAMP_LENGTH = 4;

const CHANNEL_LABELS: Record<MaterialChannel, string> = {
  normal: "Normal",
  height: "Height",
  specular: "Specular",
  roughness: "Roughness",
  emissive: "Emissive",
};

export function SurfaceToolsPanel({
  sheet,
  normals,
  height,
  specular,
  roughness,
  emissive,
  selection,
  color,
  onEdit,
}: SurfaceToolsPanelProps) {
  const imageRef = useRef<HTMLInputElement>(null);
  const lutRef = useRef<HTMLInputElement>(null);

  const [deriveValues, setDeriveValues] = useState<Record<string, number>>(() =>
    defaultValues(MATERIAL_DERIVE_PARAMS),
  );
  const [channels, setChannels] = useState<readonly MaterialChannel[]>(DERIVABLE_CHANNELS);
  const [showDeriveParams, setShowDeriveParams] = useState(false);
  const [deriveNote, setDeriveNote] = useState<string | null>(null);

  const [dither, setDither] = useState<DitherMode>("bayer4");
  const [imageNote, setImageNote] = useState<string | null>(null);

  const [generatorId, setGeneratorId] = useState(TEXTURE_GENERATORS[0]!.id);
  const generator = findTextureGenerator(generatorId);
  const [textureValues, setTextureValues] = useState<Record<string, number>>(() =>
    defaultValues(generator.params),
  );
  const [rampLength, setRampLength] = useState(DEFAULT_RAMP_LENGTH);
  const [textureNote, setTextureNote] = useState<string | null>(null);

  const [lutAmount, setLutAmount] = useState(1);
  const [lutNote, setLutNote] = useState<string | null>(null);

  const { page, tile, tilesPerSide } = selection;
  const blockPixels = sheet.tileSize * tilesPerSide;

  /** The block as RGBA — the input every one of these tools reads or replaces. */
  const blockImage = () => ({
    data: readBlockAlbedo(sheet, page, tile, tilesPerSide),
    width: blockPixels,
    height: blockPixels,
  });

  /** Where a generated or imported image lands in the sheet. */
  const blockOrigin = () => ({
    x: (tile % sheet.sheetCols) * sheet.tileSize,
    y: Math.floor(tile / sheet.sheetCols) * sheet.tileSize,
  });

  const toggleChannel = (channel: MaterialChannel) =>
    setChannels((current) =>
      current.includes(channel) ? current.filter((entry) => entry !== channel) : [...current, channel],
    );

  const runDerive = () => {
    const derived = deriveMaterials(blockImage(), normalizeMaterialDeriveParams(deriveValues));
    const written = applyDerivedMaterials(
      derived,
      { normal: normals, height, specular, roughness, emissive },
      { page, tile, tilesWide: tilesPerSide, tilesHigh: tilesPerSide, tileSize: sheet.tileSize, sheetCols: sheet.sheetCols },
      channels,
    );
    setDeriveNote(
      written === 0
        ? "Nothing to derive — the block is empty, or no channels are selected."
        : `Wrote ${channels.length} channel${channels.length === 1 ? "" : "s"} over ${written} pixels.`,
    );
    if (written > 0) onEdit();
  };

  const importImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) {
        setImageNote("This browser would not give us a canvas to read the image with.");
        return;
      }
      context.drawImage(image, 0, 0);
      const source = context.getImageData(0, 0, image.width, image.height);

      // Square, because the block is square: fitting the image's aspect ratio
      // would leave the rest of the block holding whatever was there before,
      // which reads as a failed import rather than a letterboxed one.
      const indexed = pixelateImage(
        { data: source.data, width: source.width, height: source.height },
        sheet.paletteRgb(),
        { dither, strength: 1, alphaThreshold: 128, colors: 0, width: blockPixels, height: blockPixels },
      );
      const origin = blockOrigin();
      const written = sheet.importIndexedAt(indexed, page, origin.x, origin.y);
      setImageNote(
        `Imported ${image.width}×${image.height} into ${blockPixels}×${blockPixels} (${written} pixels, ${dither} dither).`,
      );
      onEdit();
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setImageNote("Could not read that image.");
    };
    image.src = url;
  };

  const selectGenerator = (id: string) => {
    setGeneratorId(id);
    // Parameters belong to the generator, so switching resets them rather than
    // carrying a "Veins" value over onto a checkerboard's "Squares".
    setTextureValues(defaultValues(findTextureGenerator(id).params));
  };

  const runTexture = () => {
    const field = generator.generate(blockPixels, blockPixels, textureValues);
    // The ramp runs down from the active colour, so picking a colour picks the
    // texture's light end and the shades below it come along — which is how a
    // pixel artist's palette is arranged in the first place.
    const ramp: number[] = [];
    for (let step = rampLength - 1; step >= 0; step -= 1) {
      ramp.push(Math.max(0, color - step));
    }
    const indexed = textureToIndices(field, { ramp, dither, strength: 1 });
    const origin = blockOrigin();
    const written = sheet.importIndexedAt(indexed, page, origin.x, origin.y);
    setTextureNote(`Filled ${written} pixels with ${generator.label} over ${ramp.length} colours.`);
    onEdit();
  };

  const importLut = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const lut = parseCubeLut(String(reader.result ?? ""));
        const graded = gradePalette(lut, sheet.paletteRgb(), lutAmount);
        const applied = sheet.applyPalette(graded);
        setLutNote(
          `Graded ${applied} colours through ${lut.title || file.name} (${lut.size}-point ${lut.dimensions}D).`,
        );
        onEdit();
      } catch (error) {
        setLutNote(error instanceof Error ? error.message : "Could not read that LUT.");
      }
    };
    reader.onerror = () => setLutNote("Could not read that LUT file.");
    reader.readAsText(file);
  };

  const ditherOptions = DITHER_MODES.map((mode) => ({ id: mode.id, label: mode.label, hint: mode.hint }));

  return (
    <>
      <RailGroup label="Materials">
        <div className={styles.segmented} role="group" aria-label="Channels to derive">
          {DERIVABLE_CHANNELS.map((channel) => (
            <button
              key={channel}
              type="button"
              className={`${styles.segment} ${channels.includes(channel) ? styles.segmentActive : ""}`}
              onClick={() => toggleChannel(channel)}
              aria-pressed={channels.includes(channel)}
              title={`Derive the ${CHANNEL_LABELS[channel].toLowerCase()} channel from the art`}
            >
              {CHANNEL_LABELS[channel]}
            </button>
          ))}
        </div>
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={runDerive}
            disabled={channels.length === 0}
            title="Read relief, gloss and glow out of the pixels already drawn"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ◈
            </span>
            Derive from art
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => setShowDeriveParams((current) => !current)}
            aria-expanded={showDeriveParams}
          >
            <span className={styles.toolGlyph} aria-hidden>
              {showDeriveParams ? "▾" : "▸"}
            </span>
            Settings
          </button>
        </div>
        {showDeriveParams &&
          MATERIAL_DERIVE_PARAMS.map((param) => (
            <RangeControl
              key={param.key}
              label={param.label}
              nested
              min={param.min}
              max={param.max}
              step={param.step}
              value={deriveValues[param.key] ?? param.value}
              onChange={(value) => setDeriveValues((current) => ({ ...current, [param.key]: value }))}
              ariaLabel={param.label}
              display={formatParam(deriveValues[param.key] ?? param.value, param.format)}
            />
          ))}
        <RailHint>
          {deriveNote ??
            "Luminance becomes height, its gradient becomes the normal, and brightness and saturation separate metal from paint. Transparent pixels are left alone."}
        </RailHint>
      </RailGroup>

      <RailGroup label="Dither">
        <SegmentedControl
          options={ditherOptions}
          selected={dither}
          onSelect={setDither}
          wrap
          ariaLabel="Dither pattern"
        />
        <RailHint>{DITHER_MODES.find((mode) => mode.id === dither)?.hint}</RailHint>
      </RailGroup>

      <RailGroup label="Image">
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => imageRef.current?.click()}
            title="Downscale, dither and quantise any image into this block"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ⬓
            </span>
            Pixelate image
          </button>
        </div>
        <input ref={imageRef} type="file" accept="image/*" onChange={importImage} hidden />
        {imageNote && <RailHint>{imageNote}</RailHint>}
      </RailGroup>

      <RailGroup label="Texture">
        <SegmentedControl
          options={TEXTURE_GENERATORS.map((entry) => ({
            id: entry.id,
            label: entry.label,
            hint: entry.description,
          }))}
          selected={generatorId}
          onSelect={selectGenerator}
          wrap
          ariaLabel="Texture generator"
        />
        {generator.params.map((param) => (
          <RangeControl
            key={param.key}
            label={param.label}
            nested
            min={param.min}
            max={param.max}
            step={param.step}
            value={textureValues[param.key] ?? param.value}
            onChange={(value) => setTextureValues((current) => ({ ...current, [param.key]: value }))}
            ariaLabel={`${generator.label} ${param.label}`}
            display={formatParam(textureValues[param.key] ?? param.value, param.format)}
          />
        ))}
        <RangeControl
          label="Shades"
          nested
          min={2}
          max={8}
          value={rampLength}
          onChange={setRampLength}
          ariaLabel="Palette entries the texture ramps across"
          display={`${rampLength}`}
        />
        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolBtn} onClick={runTexture}>
            <span className={styles.toolGlyph} aria-hidden>
              ▦
            </span>
            Fill block
          </button>
        </div>
        <RailHint>
          {textureNote ?? `${generator.description} Ramps down from the selected colour.`}
        </RailHint>
      </RailGroup>

      <RailGroup label="Colour grade">
        <RangeControl
          label="Strength"
          nested
          min={0}
          max={1}
          step={0.05}
          value={lutAmount}
          onChange={setLutAmount}
          ariaLabel="How far the LUT moves each palette colour"
          display={`${Math.round(lutAmount * 100)}%`}
        />
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => lutRef.current?.click()}
            title="Re-grade every palette colour through a .cube film LUT"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ◑
            </span>
            Apply .cube LUT
          </button>
        </div>
        <input ref={lutRef} type="file" accept=".cube,text/plain" onChange={importLut} hidden />
        <RailHint>
          {lutNote ??
            "Grades the palette rather than the frame — on a console with no per-pixel pipeline, the palette is where a look can live."}
        </RailHint>
      </RailGroup>
    </>
  );
}

/** Render a parameter value the way its declared format asks for. */
function formatParam(value: number, format: "integer" | "decimal" | "percent"): string {
  if (format === "percent") return `${Math.round(value * 100)}%`;
  if (format === "integer") return `${Math.round(value)}`;
  return value.toFixed(2);
}
