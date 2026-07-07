"use client";

/**
 * Song arrangement: the layer above patterns. For the selected track, each of
 * the MUSIC_FRAMES frames assigns a pattern to each of the 4 channels. Click a
 * cell to select it, step its pattern id, or jump into the pattern editor for
 * it. This is what turns loose patterns into an actual song.
 */

import { useState } from "react";
import type { MusicTracker } from "@cartbox/editor";

import styles from "./editor.module.css";

interface SongArrangementProps {
  tracker: MusicTracker;
  track: number;
  onOpenPattern: (pattern: number) => void;
}

export function SongArrangement({ tracker, track, onOpenPattern }: SongArrangementProps) {
  const [cell, setCell] = useState({ frame: 0, channel: 0 });
  const [, force] = useState(0);
  const bump = () => force((n) => n + 1);

  const current = tracker.getFramePattern(track, cell.frame, cell.channel);
  const setPattern = (id: number) => {
    tracker.setFramePattern(track, cell.frame, cell.channel, Math.max(0, Math.min(tracker.patternCount - 1, id)));
    bump();
  };

  return (
    <section className={styles.musicStage}>
      <div className={styles.arrangeGrid} role="grid" aria-label={`Track ${track} arrangement`}>
        <div className={`${styles.arrangeRow} ${styles.arrangeHead} data`}>
          <span className={styles.musicRowNum}>##</span>
          {Array.from({ length: tracker.channelCount }, (_unused, channel) => (
            <span key={channel}>CH{channel}</span>
          ))}
        </div>
        {Array.from({ length: tracker.frameCount }, (_unused, frame) => (
          <div key={frame} className={`${styles.arrangeRow} data`}>
            <span className={styles.musicRowNum}>{frame.toString(16).toUpperCase().padStart(2, "0")}</span>
            {Array.from({ length: tracker.channelCount }, (_unused2, channel) => {
              const id = tracker.getFramePattern(track, frame, channel);
              const selected = cell.frame === frame && cell.channel === channel;
              return (
                <button
                  key={channel}
                  type="button"
                  className={`${styles.arrangeCell} ${selected ? styles.arrangeCellSel : ""}`}
                  onClick={() => setCell({ frame, channel })}
                  aria-selected={selected}
                >
                  {id.toString().padStart(2, "0")}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className={styles.hud}>
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Frame</span>
          <span className={`${styles.hudValue} data`}>{cell.frame.toString(16).toUpperCase()}</span>
        </span>
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Ch</span>
          <span className={`${styles.hudValue} data`}>{cell.channel}</span>
        </span>
        <span className={styles.hudItem}>
          <span className={styles.hudLabel}>Pattern</span>
          <button type="button" className="cbx-btn" onClick={() => setPattern(current - 1)}>
            −
          </button>
          <span className={`${styles.hudValue} data`}>{current.toString().padStart(2, "0")}</span>
          <button type="button" className="cbx-btn" onClick={() => setPattern(current + 1)}>
            +
          </button>
        </span>
        <button type="button" className="cbx-btn cbx-btn-accent" onClick={() => onOpenPattern(current)}>
          Edit pattern
        </button>
      </div>
    </section>
  );
}
