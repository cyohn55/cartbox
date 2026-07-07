"use client";

/**
 * Map editor: owns the map editing state (tool, brush tile, zoom) and lays out
 * the tool rail, the scrollable map stage, and the brush inspector. Shares the
 * cart's SpriteSheet and TileMap with the other editors, so tiles drawn in the
 * sprite editor are immediately stampable here.
 */

import { useState } from "react";
import type { SpriteSheet, TileMap } from "@cartbox/editor";

import styles from "./editor.module.css";
import { MapCanvas } from "./MapCanvas";
import { TilePicker } from "./TilePicker";
import { singleTileBrush, type MapBrush } from "./mapBrush";
import { MAP_TOOLS, MAP_ZOOMS, type MapTool } from "./maptools";

interface MapEditorProps {
  sheet: SpriteSheet;
  map: TileMap;
}

export function MapEditor({ sheet, map }: MapEditorProps) {
  const [tool, setTool] = useState<MapTool>("stamp");
  const [brush, setBrush] = useState<MapBrush>(() => singleTileBrush(2));
  const [zoom, setZoom] = useState(1);
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const cell = (MAP_ZOOMS[zoom] ?? MAP_ZOOMS[1])!.cell;
  const bump = () => setVersion((current) => current + 1);
  const screen = hover ? map.screenOf(hover.x, hover.y) : null;

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div>
          <div className={styles.groupLabel}>Tool</div>
          <div className={styles.toolGroup}>
            {MAP_TOOLS.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className={`${styles.toolBtn} ${tool === definition.id ? styles.toolBtnActive : ""}`}
                onClick={() => setTool(definition.id)}
                aria-pressed={tool === definition.id}
              >
                <span className={styles.toolGlyph} aria-hidden>
                  {definition.glyph}
                </span>
                {definition.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Zoom</div>
          <div className={styles.segmented}>
            {MAP_ZOOMS.map((option, index) => (
              <button
                key={option.label}
                type="button"
                className={`${styles.segment} ${zoom === index ? styles.segmentActive : ""}`}
                onClick={() => setZoom(index)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <section className={styles.mapStage}>
        <MapCanvas
          sheet={sheet}
          map={map}
          brush={brush}
          tool={tool}
          cell={cell}
          version={version}
          onEdit={bump}
          onHover={setHover}
        />
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Cell</span>
            <span className={`${styles.hudValue} data`}>{hover ? `${hover.x},${hover.y}` : "—"}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Screen</span>
            <span className={`${styles.hudValue} data`}>{screen ? `${screen[0]},${screen[1]}` : "—"}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Brush</span>
            <span className={`${styles.hudValue} data`}>
              #{brush.tile.toString().padStart(3, "0")}
              {brush.width * brush.height > 1 ? ` ${brush.width}×${brush.height}` : ""}
            </span>
          </span>
        </div>
      </section>

      <aside className={styles.inspector}>
        <TilePicker
          sheet={sheet}
          page={0}
          selected={brush.tile}
          version={version}
          onSelect={(tile) => setBrush(singleTileBrush(tile))}
          onSelectBrush={setBrush}
          brush={brush}
        />
      </aside>
    </div>
  );
}
