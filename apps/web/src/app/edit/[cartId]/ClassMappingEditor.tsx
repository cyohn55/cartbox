"use client";

/**
 * The bridge between a generator's classes and the layer being authored: for
 * each class the generator can emit — water, rock, corridor — which tile stamps
 * it, which palette colour paints it, and how tall a column it raises.
 *
 * Keeping this mapping in the user's hands (rather than baking it into each
 * generator) is what lets the same four generators drive tiles, pixels and
 * columns with the cart's own art. Only the fields the active layer actually
 * uses are shown, so the panel stays readable.
 */

import type { ClassInfo, ClassMapping } from "@cartbox/editor";

import styles from "./editor.module.css";
import { isColumnLayer, type MapLayer } from "./maptools";

interface ClassMappingEditorProps {
  legend: readonly ClassInfo[];
  mapping: readonly ClassMapping[];
  onChange: (mapping: ClassMapping[]) => void;
  /** Which layer the mapping is being edited for; decides the columns shown. */
  layer: MapLayer;
  /** CSS colours of the cart palette, for the colour chips. */
  palette: readonly string[];
  /** Highest tile index the sheet holds, bounding the tile inputs. */
  maxTile: number;
  /** Tallest column the layer allows, bounding the height inputs. */
  maxColumnHeight: number;
}

export function ClassMappingEditor({
  legend,
  mapping,
  onChange,
  layer,
  palette,
  maxTile,
  maxColumnHeight,
}: ClassMappingEditorProps) {
  const showTile = layer === "tiles";
  const showColor = layer !== "tiles";
  const showHeight = isColumnLayer(layer);

  const update = (index: number, patch: Partial<ClassMapping>) => {
    onChange(mapping.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  return (
    <div className={styles.classMapping}>
      <div className={styles.groupLabel}>Classes → {layer}</div>
      {legend.map((info, index) => {
        const entry = mapping[index] ?? { tile: 0, colorIndex: 0, columnHeight: 0 };
        return (
          <div key={info.id} className={styles.classRow}>
            <span
              className={styles.classSwatch}
              style={{ background: `rgb(${info.color[0]},${info.color[1]},${info.color[2]})` }}
              aria-hidden
            />
            <span className={styles.classLabel} title={info.label}>
              {info.label}
            </span>

            {showTile && (
              <label className={styles.classField}>
                <span className={styles.classFieldLabel}>Tile</span>
                <input
                  type="number"
                  min={0}
                  max={maxTile}
                  value={entry.tile}
                  onChange={(event) => update(index, { tile: Number(event.target.value) })}
                  aria-label={`${info.label} tile index`}
                />
              </label>
            )}

            {showColor && (
              <label className={styles.classField}>
                <span
                  className={styles.classFieldLabel}
                  style={{ background: palette[entry.colorIndex] ?? "transparent" }}
                  title={`Palette ${entry.colorIndex}`}
                />
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, palette.length - 1)}
                  value={entry.colorIndex}
                  onChange={(event) => update(index, { colorIndex: Number(event.target.value) })}
                  aria-label={`${info.label} palette index`}
                />
              </label>
            )}

            {showHeight && (
              <label className={styles.classField}>
                <span className={styles.classFieldLabel}>↕</span>
                <input
                  type="number"
                  min={0}
                  max={maxColumnHeight}
                  value={entry.columnHeight}
                  onChange={(event) => update(index, { columnHeight: Number(event.target.value) })}
                  aria-label={`${info.label} column height`}
                />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
