"use client";

/**
 * A grid of colour chips. Selecting a chip sets the active paint value; the
 * readout shows its index and hex. Used for both the sprite palette and the
 * normal-direction swatches — it just takes a list of colours.
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
}

export function PalettePicker({ colors, selected, onSelect, title, subtitle, order, sorted, onToggleSort }: PalettePickerProps) {
  const current = colors[selected] ?? "#000000";
  const displayOrder = order ?? colors.map((_unused, index) => index);

  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
        <span className={styles.panelMeta}>{subtitle}</span>
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
          return (
            <button
              key={index}
              type="button"
              className={`${styles.swatch} ${index === selected ? styles.swatchActive : ""}`}
              style={{ background: css }}
              onClick={() => onSelect(index)}
              title={`${index} · ${css}`}
              aria-label={`${title} ${index}, ${css}`}
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
        </span>
      </div>
    </div>
  );
}
