"use client";

/**
 * A thumbnail of the field a generator would produce, drawn in the generator's
 * own legend colours.
 *
 * The field is generated at its true target size and drawn at native resolution,
 * then scaled down by CSS — so what the preview shows is exactly what "Generate"
 * will apply, not an approximation at a smaller size. That matters for the
 * generators whose output depends on the grid (a dungeon's rooms, a maze's
 * corridors) rather than only on continuous noise.
 */

import { useEffect, useRef } from "react";
import { classFieldToRgba, type ClassField } from "@cartbox/editor";

import styles from "./editor.module.css";

interface FieldPreviewProps {
  /** The field to draw, or null while there is nothing to preview. */
  field: ClassField | null;
  label: string;
}

export function FieldPreview({ field, label }: FieldPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !field) return;
    canvas.width = field.width;
    canvas.height = field.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(field.width, field.height);
    image.data.set(classFieldToRgba(field));
    context.putImageData(image, 0, 0);
  }, [field]);

  if (!field) return null;
  return (
    <div className={styles.fieldPreview}>
      <canvas ref={canvasRef} className={styles.fieldPreviewCanvas} role="img" aria-label={label} />
      <span className={styles.panelMeta}>
        {field.width}×{field.height}
      </span>
    </div>
  );
}
