"use client";

/**
 * A grid of colour chips. Selecting a chip sets the active paint value; the
 * readout shows its index and hex. Used for both the sprite palette and the
 * normal-direction swatches — it just takes a list of colours.
 *
 * Two things the palette can say about a chip beyond its colour, because
 * nothing else in the editor was saying them:
 *
 * - **`materials`** marks the colours that stamp a whole material profile when
 *   you paint with them. That binding lived only in the Material layer's swatch
 *   panel, so from the Albedo layer — where you actually paint — a material
 *   colour looked exactly like a plain one.
 * - **`usage`** is how many pixels of the open block use each value, which
 *   drives the optional "in use" filter. A 16- or 64-colour palette where the
 *   sprite uses six of them makes finding those six a hunt.
 *
 * Both are optional: a picker handed neither is the plain grid it always was.
 */

import styles from "./editor.module.css";

interface PalettePickerProps {
  colors: string[];
  selected: number;
  onSelect: (index: number) => void;
  title: string;
  subtitle: string;
  /** Original palette indices in display order; defaults to natural index order. */
  order?: number[];
  /** Whether the gradient sort is active (drives the toggle label). */
  sorted?: boolean;
  /** When provided, shows a control to toggle gradient vs. index ordering. */
  onToggleSort?: () => void;
  /** Values that carry a material profile; badged so they read as materials. */
  materials?: ReadonlySet<number>;
  /** Pixel count per value in the open block. Enables the "in use" filter. */
  usage?: ReadonlyMap<number, number>;
  /** Whether the filter is on. Only meaningful alongside `usage`. */
  usedOnly?: boolean;
  onToggleUsedOnly?: () => void;
}

export function PalettePicker({
  colors,
  selected,
  onSelect,
  title,
  subtitle,
  order,
  sorted,
  onToggleSort,
  materials,
  usage,
  usedOnly = false,
  onToggleUsedOnly,
}: PalettePickerProps) {
  const current = colors[selected] ?? "#000000";
  const naturalOrder = order ?? colors.map((_unused, index) => index);

  // The active colour always survives the filter. Hiding the chip you are
  // painting with — which happens the moment you pick an unused colour to start
  // using it — would read as the palette losing your selection.
  const displayOrder =
    usedOnly && usage
      ? naturalOrder.filter((index) => index === selected || (usage.get(index) ?? 0) > 0)
      : naturalOrder;

  const hiddenCount = naturalOrder.length - displayOrder.length;

  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
        <span className={styles.panelMeta}>{subtitle}</span>
        {onToggleUsedOnly && usage && (
          <button
            type="button"
            className={styles.rendererToggle}
            onClick={onToggleUsedOnly}
            title="Show only the colours this sprite actually uses"
            aria-pressed={usedOnly}
          >
            {usedOnly ? "In use" : "All"}
          </button>
        )}
        {onToggleSort && (
          <button
            type="button"
            className={styles.rendererToggle}
            onClick={onToggleSort}
            title="Toggle between gradient and index ordering"
            aria-pressed={sorted}
          >
            {sorted ? "Gradient" : "Index"}
          </button>
        )}
      </div>
      <div className={styles.paletteGrid}>
        {displayOrder.map((index) => {
          const css = colors[index] ?? "#000000";
          const count = usage?.get(index) ?? 0;
          const isMaterial = materials?.has(index) ?? false;
          return (
            <button
              key={index}
              type="button"
              className={[
                styles.swatch,
                index === selected ? styles.swatchActive : "",
                isMaterial ? styles.swatchMaterial : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ background: css }}
              onClick={() => onSelect(index)}
              title={
                `${index} · ${css}` +
                (isMaterial ? " · stamps a material" : "") +
                (usage ? ` · ${count} px` : "")
              }
              aria-label={
                `${title} ${index}, ${css}` +
                (isMaterial ? ", stamps a material" : "") +
                (usage ? `, used by ${count} pixels` : "")
              }
              aria-pressed={index === selected}
            />
          );
        })}
      </div>
      <div className={styles.paletteInfo}>
        <span className={styles.paletteSwatchLarge} style={{ background: current }} />
        <span>
          <span className="data">{selected.toString().padStart(2, "0")}</span>
          <span className="data" style={{ marginLeft: 10, color: "var(--muted)" }}>
            {current}
          </span>
          {usage && (
            <span className="data" style={{ marginLeft: 10, color: "var(--faint)" }}>
              {usage.get(selected) ?? 0} px
            </span>
          )}
        </span>
      </div>
      {hiddenCount > 0 && (
        <p className={styles.inspectorHint} style={{ marginTop: 8 }}>
          {hiddenCount} unused {hiddenCount === 1 ? "colour" : "colours"} hidden.
        </p>
      )}
    </div>
  );
}
