"use client";

/**
 * The pattern grid: the selected pattern's rows, each showing its note and SFX.
 * The cursor row is highlighted and kept in view; clicking a row moves the
 * cursor there. Beats (every fourth row) are emphasised, tracker-style.
 */

import { useEffect, useRef } from "react";
import type { MusicTracker } from "@cartbox/editor";

import styles from "./editor.module.css";

interface MusicGridProps {
  tracker: MusicTracker;
  pattern: number;
  cursor: number;
  version: number;
  onSelectRow: (row: number) => void;
}

export function MusicGrid({ tracker, pattern, cursor, version, onSelectRow }: MusicGridProps) {
  const cursorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <div className={styles.musicGrid} role="grid" aria-label={`Pattern ${pattern}`}>
      {Array.from({ length: tracker.rows }, (_unused, row) => {
        const cell = tracker.getCell(pattern, row);
        const isCursor = row === cursor;
        const noteClass =
          cell.kind === "note" ? styles.musicNoteOn : cell.kind === "stop" ? styles.musicNoteStop : styles.musicNoteEmpty;
        return (
          <button
            key={row}
            ref={isCursor ? cursorRef : undefined}
            type="button"
            className={`${styles.musicRow} data ${row % 4 === 0 ? styles.musicRowBeat : ""} ${
              isCursor ? styles.musicRowCursor : ""
            }`}
            onClick={() => onSelectRow(row)}
            aria-selected={isCursor}
          >
            <span className={styles.musicRowNum}>{row.toString(16).toUpperCase().padStart(2, "0")}</span>
            <span className={noteClass}>{tracker.label(cell)}</span>
            <span className={styles.musicRowSfx}>
              {cell.kind === "note" ? (cell.sfx ?? 0).toString(16).toUpperCase().padStart(2, "0") : "··"}
            </span>
            <span className={styles.musicRowFx}>{tracker.effectLabel(tracker.getEffect(pattern, row))}</span>
          </button>
        );
      })}
    </div>
  );
}
