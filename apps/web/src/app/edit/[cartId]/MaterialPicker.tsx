"use client";

/**
 * The material palette, as an inspector panel.
 *
 * One picker for the two tabs that arm a material — the voxel sculptor and the
 * map's 3D view. They had a chip grid each, built by hand, with the same
 * meanings and different affordances: only one read out what was armed, only one
 * drew the flat chip in the active colour, and they sat on opposite sides of the
 * screen. The options come from {@link ./materialPalette}; this is how they look.
 *
 * Sprite skins differ per tab, so they arrive as `extras` rather than being
 * baked in: the sculptor contributes the sculpt's own sprite materials, the map
 * contributes the one tile the brush has armed.
 */

import type { ReactNode } from "react";

import styles from "./editor.module.css";
import { MATERIAL_OPTIONS, materialOptionLabel } from "./materialPalette";
import { InspectorPanel } from "./workbenchPanels";

/** A sprite-skinned chip a tab contributes, drawn from its own art. */
export interface SpriteMaterialChip {
  /** The armed value this chip sets. */
  readonly material: number;
  /** Tooltip and accessible name — what sprite this is. */
  readonly name: string;
  /** The sprite, rendered by the tab that owns it. */
  readonly art: ReactNode;
  /** Removes this chip, when the tab allows it (right-click). */
  readonly onRemove?: () => void;
}

interface MaterialPickerProps {
  /** The armed material. */
  selected: number;
  onSelect: (material: number) => void;
  /**
   * The active palette colour, which the flat chip is drawn in — flat means
   * "this colour and nothing else", so showing it in the colour is showing what
   * you would actually get.
   */
  colorCss: string;
  /** Sprite skins this tab offers, after the world's materials. */
  extras?: readonly SpriteMaterialChip[];
  /** Sizes the sprite-number space, for reading a skin back as "sprite #n". */
  tilesPerPage: number;
  /** Anything the tab needs under the chips — the sculptor's sprite form. */
  children?: ReactNode;
}

export function MaterialPicker({
  selected,
  onSelect,
  colorCss,
  extras = [],
  tilesPerPage,
  children,
}: MaterialPickerProps) {
  return (
    <InspectorPanel title="Material" meta={materialOptionLabel(selected, tilesPerPage)}>
      <div className={styles.paletteGrid}>
        {MATERIAL_OPTIONS.map((option) => (
          <button
            key={option.material}
            type="button"
            className={`${styles.swatch} ${option.material === selected ? styles.swatchActive : ""}`}
            // The flat chip borrows the active colour and marks itself with a
            // dashed outline, so it cannot be mistaken for a grey material.
            style={
              option.flat
                ? { background: colorCss, outline: "1px dashed var(--faint)" }
                : { background: option.swatch ?? "transparent" }
            }
            onClick={() => onSelect(option.material)}
            title={option.flat ? "Flat — paint the palette colour, with no material" : option.name}
            aria-label={option.flat ? "Flat colour, no material" : `Material ${option.name}`}
            aria-pressed={option.material === selected}
          />
        ))}
        {extras.map((chip) => (
          <button
            key={`sprite:${chip.material}:${chip.name}`}
            type="button"
            className={`${styles.swatch} ${chip.material === selected ? styles.swatchActive : ""}`}
            style={{ padding: 0, overflow: "hidden" }}
            onClick={() => onSelect(chip.material)}
            onContextMenu={
              chip.onRemove &&
              ((event) => {
                event.preventDefault();
                chip.onRemove?.();
              })
            }
            title={chip.onRemove ? `${chip.name} — right-click to remove` : chip.name}
            aria-label={`Material ${chip.name}`}
            aria-pressed={chip.material === selected}
          >
            {chip.art}
          </button>
        ))}
      </div>
      {children}
    </InspectorPanel>
  );
}
