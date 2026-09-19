"use client";

/**
 * The active paint colour, shown as a swatch in the tool palette. Clicking it
 * opens a compact grid of the current layer's colours; picking one arms it and
 * closes the popover. It mirrors the inspector's palette for the one thing an
 * author reaches for most — "what am I painting with, and change it" — without
 * leaving the tools.
 *
 * The grid is portaled to the document body so it escapes the tool palette's own
 * overflow clipping (the palette scrolls; the popover must not be cut off by it).
 *
 * Purely a control: it renders the colours it is handed and reports the chosen
 * index. Which colours those are (albedo palette, normal directions, a ramp) is
 * the caller's call.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import styles from "./editor.module.css";

interface ToolbarColorButtonProps {
  /** Short caps label, e.g. "Colour" / "Material" / "Direction". */
  label: string;
  /** CSS colour for each selectable value, indexed by value. */
  colors: readonly string[];
  /** Display order (e.g. gradient-sorted palette); defaults to natural order. */
  order?: readonly number[];
  /** The armed value. */
  selected: number;
  onSelect: (index: number) => void;
  /** Indices to hide (uninitialised palette slots). */
  blank?: ReadonlySet<number>;
  /** Indices that stamp a whole material profile, flagged with a corner notch. */
  materials?: ReadonlySet<number>;
}

/** Popover width, kept in sync with the max-width in the stylesheet for clamping. */
const POPOVER_W = 320;

export function ToolbarColorButton({
  label,
  colors,
  order,
  selected,
  onSelect,
  blank,
  materials,
}: ToolbarColorButtonProps) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The button is anchored to the moving palette, so keep the portaled popover
    // aligned as the viewport scrolls or resizes.
    const reposition = () => tick((n) => n + 1);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  // Colours to render: the display order with hidden slots dropped, but the armed
  // one always kept so the current colour is never missing from its own picker.
  const indices = (order ?? colors.map((_unused, index) => index)).filter(
    (index) => index === selected || !blank?.has(index),
  );

  const current = colors[selected] ?? "#000000";

  const popoverStyle: CSSProperties = (() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return { top: 0, left: 0 };
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_W - 8));
    // Prefer below the button; flip above if it would spill off the bottom.
    const below = rect.bottom + 6;
    const wouldSpill = below + 260 > window.innerHeight;
    const top = wouldSpill ? Math.max(8, rect.top - 6) : below;
    const transform = wouldSpill ? "translateY(-100%)" : undefined;
    return { top, left, transform };
  })();

  return (
    <div className={styles.stripField}>
      <span className={styles.stripFieldLabel}>{label}</span>
      <button
        ref={buttonRef}
        type="button"
        className={styles.colorButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`${label} ${selected.toString().padStart(2, "0")} — ${current}. Click to change.`}
        aria-label={`Active ${label.toLowerCase()}: ${current}. Click to choose another.`}
      >
        <span className={styles.colorButtonSwatch} style={{ background: current }} />
        <span className={`${styles.colorButtonHex} data`}>{current}</span>
        <span className={styles.colorButtonCaret} aria-hidden>
          ▾
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.colorPopover}
            style={popoverStyle}
            role="dialog"
            aria-label={`Choose ${label.toLowerCase()}`}
          >
            <div className={styles.colorPopoverGrid}>
              {indices.map((index) => (
                <button
                  key={index}
                  type="button"
                  className={`${styles.swatch} ${index === selected ? styles.swatchActive : ""} ${materials?.has(index) ? styles.swatchMaterial : ""}`}
                  style={{ background: colors[index] }}
                  onClick={() => {
                    onSelect(index);
                    setOpen(false);
                  }}
                  title={`${index.toString().padStart(2, "0")} — ${colors[index]}`}
                  aria-label={`${label} ${index}`}
                  aria-pressed={index === selected}
                />
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
