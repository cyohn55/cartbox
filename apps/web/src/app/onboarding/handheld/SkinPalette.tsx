"use client";

/**
 * A one-click colour palette for the handheld pixel editor. It offers two rows
 * of swatches so the artist rarely needs the slow native colour dialog:
 *
 *   1. "Your handheld" — the colours already on the skin (its region scheme),
 *      deduped, so painting details in the handheld's own palette is one tap.
 *   2. "Palette" — the console's curated authoring palette, for everything else.
 *
 * Purely presentational: it holds no state and reports a picked hex upward.
 */

import { useMemo } from "react";

import { proPaletteHex, type HandheldScheme } from "@cartbox/editor";

import styles from "./skinEditor.module.css";

interface SkinPaletteProps {
  /** The skin's region colours, surfaced as the "your handheld" swatches. */
  scheme: HandheldScheme;
  /** The currently selected paint colour, highlighted if it's in the palette. */
  activeColor: string;
  /** Report a chosen swatch colour as `#rrggbb`. */
  onPick: (hex: string) => void;
}

/** Normalise a hex to lowercase `#rrggbb` so comparison and dedup are stable. */
function canonicalHex(hex: string): string {
  return hex.trim().toLowerCase();
}

/** The scheme's colours in region order, de-duplicated. */
function schemeColors(scheme: HandheldScheme): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const value of Object.values(scheme)) {
    const hex = canonicalHex(value);
    if (seen.has(hex)) continue;
    seen.add(hex);
    colors.push(hex);
  }
  return colors;
}

export function SkinPalette({ scheme, activeColor, onPick }: SkinPaletteProps) {
  const yours = useMemo(() => schemeColors(scheme), [scheme]);
  const palette = useMemo(() => proPaletteHex().map(canonicalHex), []);
  const active = canonicalHex(activeColor);

  const swatch = (hex: string) => (
    <button
      key={hex}
      type="button"
      className={`${styles.swatch} ${hex === active ? styles.swatchActive : ""}`}
      style={{ background: hex }}
      onClick={() => onPick(hex)}
      aria-label={`Use ${hex}`}
      aria-pressed={hex === active}
      title={hex}
    />
  );

  return (
    <div className={styles.palette}>
      {yours.length > 0 && (
        <>
          <span className={styles.paletteLabel}>Your handheld</span>
          <div className={styles.swatchWrap}>{yours.map(swatch)}</div>
        </>
      )}
      <span className={styles.paletteLabel}>Palette</span>
      <div className={styles.swatchWrap}>{palette.map(swatch)}</div>
    </div>
  );
}
