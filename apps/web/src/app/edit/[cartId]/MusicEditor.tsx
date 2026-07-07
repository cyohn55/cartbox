"use client";

/**
 * Music editor with two modes. In Pattern mode it's a tracker: place notes into
 * the shared MusicTracker from the on-screen keyboard or the computer keyboard
 * (Z..M is a chromatic octave), with per-row SFX and effects. In Song mode it's
 * the arrangement matrix, assigning patterns to the 4 channels across a track's
 * frames. Both edit the same cart the rest of the workbench does.
 */

import { useEffect, useState } from "react";
import { MUSIC_COMMANDS, NOTE_NAMES, type MusicTracker } from "@cartbox/editor";

import styles from "./editor.module.css";
import { MusicGrid } from "./MusicGrid";
import { SongArrangement } from "./SongArrangement";

const OCTAVES = [0, 1, 2, 3, 4, 5, 6, 7];
const SHARP = new Set([1, 3, 6, 8, 10]);
/** Computer-keyboard piano row: one chromatic octave from Z to M. */
const KEY_TO_NOTE: Record<string, number> = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
};

type Mode = "pattern" | "song";

interface MusicEditorProps {
  tracker: MusicTracker;
}

export function MusicEditor({ tracker }: MusicEditorProps) {
  const [mode, setMode] = useState<Mode>("pattern");
  const [track, setTrack] = useState(0);
  const [pattern, setPattern] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [octave, setOctave] = useState(4);
  const [sfx, setSfx] = useState(0);
  const [version, setVersion] = useState(0);

  const bump = () => setVersion((current) => current + 1);
  const advance = () => setCursor((current) => (current + 1) % tracker.rows);

  const placeNote = (note: number) => {
    tracker.setNote(pattern, cursor, note, octave, sfx);
    bump();
    advance();
  };
  const placeStop = () => {
    tracker.setStop(pattern, cursor);
    bump();
    advance();
  };
  const clearCell = () => {
    tracker.clear(pattern, cursor);
    bump();
    advance();
  };

  const effect = tracker.getEffect(pattern, cursor);
  const setCommand = (command: number) => {
    tracker.setCommand(pattern, cursor, command);
    bump();
  };
  const setParam = (param: number) => {
    tracker.setParam(pattern, cursor, Math.max(0, Math.min(255, param)));
    bump();
  };

  const openPattern = (next: number) => {
    setPattern(next);
    setCursor(0);
    setMode("pattern");
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (mode !== "pattern") return; // the piano row only edits patterns
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const note = KEY_TO_NOTE[event.key.toLowerCase()];
      if (note !== undefined) {
        event.preventDefault();
        placeNote(note);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((current) => (current + 1) % tracker.rows);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((current) => (current - 1 + tracker.rows) % tracker.rows);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        clearCell();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div className={styles.segmented}>
          <button
            type="button"
            className={`${styles.segment} ${mode === "pattern" ? styles.segmentActive : ""}`}
            onClick={() => setMode("pattern")}
          >
            Pattern
          </button>
          <button
            type="button"
            className={`${styles.segment} ${mode === "song" ? styles.segmentActive : ""}`}
            onClick={() => setMode("song")}
          >
            Song
          </button>
        </div>

        {mode === "pattern" ? (
          <>
            <div>
              <div className={styles.groupLabel}>Octave</div>
              <div className={styles.waveGrid}>
                {OCTAVES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`${styles.waveBtn} data ${octave === value ? styles.waveBtnActive : ""}`}
                    onClick={() => setOctave(value)}
                    aria-pressed={octave === value}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className={styles.groupLabel}>SFX</div>
              <div className={styles.stepper}>
                <button type="button" className="cbx-btn" onClick={() => setSfx((s) => Math.max(0, s - 1))}>
                  −
                </button>
                <span className={`${styles.stepperValue} data`}>{sfx.toString(16).toUpperCase().padStart(2, "0")}</span>
                <button type="button" className="cbx-btn" onClick={() => setSfx((s) => Math.min(63, s + 1))}>
                  +
                </button>
              </div>
            </div>

            <div>
              <div className={styles.groupLabel}>Row</div>
              <div className={styles.toolGroup}>
                <button type="button" className={styles.toolBtn} onClick={placeStop}>
                  <span className={styles.toolGlyph} aria-hidden>
                    ✕
                  </span>
                  Note off
                </button>
                <button type="button" className={styles.toolBtn} onClick={clearCell}>
                  <span className={styles.toolGlyph} aria-hidden>
                    ⌫
                  </span>
                  Clear
                </button>
              </div>
            </div>

            <div>
              <div className={styles.groupLabel}>Effect</div>
              <div className={styles.waveGrid}>
                {MUSIC_COMMANDS.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
                    className={`${styles.waveBtn} data ${effect.command === index ? styles.waveBtnActive : ""}`}
                    onClick={() => setCommand(index)}
                    title={command.name}
                    aria-pressed={effect.command === index}
                  >
                    {command.code}
                  </button>
                ))}
              </div>
              <div className={styles.stepper} style={{ marginTop: 6 }}>
                <button type="button" className="cbx-btn" onClick={() => setParam(effect.param - 1)}>
                  −
                </button>
                <span className={`${styles.stepperValue} data`}>
                  {effect.param.toString(16).toUpperCase().padStart(2, "0")}
                </span>
                <button type="button" className="cbx-btn" onClick={() => setParam(effect.param + 1)}>
                  +
                </button>
              </div>
            </div>
          </>
        ) : (
          <div>
            <div className={styles.groupLabel}>Track</div>
            <div className={styles.stepper}>
              <button type="button" className="cbx-btn" onClick={() => setTrack((t) => Math.max(0, t - 1))}>
                −
              </button>
              <span className={`${styles.stepperValue} data`}>{track}</span>
              <button
                type="button"
                className="cbx-btn"
                onClick={() => setTrack((t) => Math.min(tracker.trackCount - 1, t + 1))}
              >
                +
              </button>
            </div>
          </div>
        )}
      </aside>

      {mode === "pattern" ? (
        <>
          <section className={styles.musicStage}>
            <MusicGrid tracker={tracker} pattern={pattern} cursor={cursor} version={version} onSelectRow={setCursor} />

            <div className={styles.hud}>
              <span className={styles.hudItem}>
                <span className={styles.hudLabel}>Pattern</span>
                <span className={`${styles.hudValue} data`}>{pattern.toString().padStart(2, "0")}</span>
              </span>
              <span className={styles.hudItem}>
                <span className={styles.hudLabel}>Row</span>
                <span className={`${styles.hudValue} data`}>{cursor.toString(16).toUpperCase().padStart(2, "0")}</span>
              </span>
              <span className={styles.hudItem}>
                <span className={styles.hudLabel}>Oct</span>
                <span className={`${styles.hudValue} data`}>{octave}</span>
              </span>
            </div>

            <div className={styles.piano}>
              {NOTE_NAMES.map((name, note) => (
                <button
                  key={name}
                  type="button"
                  className={`${styles.pianoKey} data ${SHARP.has(note) ? styles.pianoKeySharp : ""}`}
                  onClick={() => placeNote(note)}
                  title={`${name}${octave}`}
                >
                  {name}
                </button>
              ))}
            </div>
          </section>

          <aside className={styles.inspector}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Patterns</span>
              <span className={`${styles.panelMeta} data`}>{pattern.toString().padStart(2, "0")}</span>
            </div>
            <div className={styles.patternGrid}>
              {Array.from({ length: tracker.patternCount }, (_unused, index) => (
                <button
                  key={index}
                  type="button"
                  className={`${styles.sampleCell} data ${index === pattern ? styles.sampleCellActive : ""} ${
                    tracker.isEmpty(index) ? styles.sampleCellSilent : ""
                  }`}
                  onClick={() => {
                    setPattern(index);
                    setCursor(0);
                  }}
                  aria-pressed={index === pattern}
                  title={`Pattern ${index}`}
                >
                  {index.toString().padStart(2, "0")}
                </button>
              ))}
            </div>
          </aside>
        </>
      ) : (
        <>
          <SongArrangement tracker={tracker} track={track} onOpenPattern={openPattern} />
          <aside className={styles.inspector}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Song {track}</span>
            </div>
            <p className={styles.songHelp}>
              Each frame plays one pattern per channel. Select a cell, step its pattern, then Edit pattern to write
              the notes.
            </p>
          </aside>
        </>
      )}
    </div>
  );
}
