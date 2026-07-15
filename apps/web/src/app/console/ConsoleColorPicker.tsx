"use client";

/**
 * A colour field the handheld can drive with its own buttons. A native
 * `<input type="color">` opens the OS picker the moment it takes focus, which
 * on the console fires as the cursor lands on it — so this replaces it with a
 * swatch that opens an in-DOM palette on A and closes on B, fully D-pad
 * navigable (the palette overlay is a `[data-console-modal]`, so the cursor is
 * captured to it, and its `[data-console-back]` control answers B).
 */

import { useState } from "react";

/** HSL (h in degrees, s/l in 0..1) to a `#rrggbb` string. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [r, g, b] =
    hue < 60 ? [chroma, second, 0]
    : hue < 120 ? [second, chroma, 0]
    : hue < 180 ? [0, chroma, second]
    : hue < 240 ? [0, second, chroma]
    : hue < 300 ? [second, 0, chroma]
    : [chroma, 0, second];
  const channel = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// A spectrum grid: a greyscale row plus hue columns at several lightnesses.
const HUES = [0, 25, 45, 70, 100, 140, 175, 200, 220, 260, 290, 320];
const LIGHTNESSES = [0.3, 0.44, 0.57, 0.7, 0.82];
const PALETTE: string[] = [
  ...HUES.map((_, index) => hslToHex(0, 0, 0.05 + (index * 0.92) / (HUES.length - 1))),
  ...LIGHTNESSES.flatMap((lightness) => HUES.map((hue) => hslToHex(hue, 0.72, lightness))),
];
const COLUMNS = HUES.length;

export function ConsoleColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const normalized = value.toLowerCase();

  const choose = (color: string) => {
    onChange(color);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="os-color-swatch"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${label}: ${value}. Press A to change.`}
      >
        <span className="os-color-chip" style={{ background: value }} />
        <span className="os-color-name">{label}</span>
      </button>

      {open && (
        <div className="os-colorpicker" data-console-modal role="dialog" aria-label={`Choose ${label} colour`}>
          <div className="os-colorpicker-head">
            <span className="os-color-chip" style={{ background: value }} />
            <span className="os-colorpicker-title">{label}</span>
          </div>
          <div className="os-colorpicker-grid" style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)` }}>
            {PALETTE.map((color, index) => (
              <button
                key={`${color}-${index}`}
                type="button"
                className="os-swatch"
                style={{ background: color }}
                data-selected={color.toLowerCase() === normalized}
                aria-label={color}
                onClick={() => choose(color)}
              />
            ))}
          </div>
          <button type="button" className="os-btn" data-console-back onClick={() => setOpen(false)}>
            CLOSE (B)
          </button>
        </div>
      )}
    </>
  );
}
