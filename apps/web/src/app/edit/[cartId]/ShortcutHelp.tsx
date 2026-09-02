"use client";

/**
 * The keyboard-shortcut overlay, opened with `?`.
 *
 * Shortcuts nobody can find are shortcuts nobody uses, and the editor's were
 * previously documented only in two button tooltips. The list renders from the
 * same table the keyboard obeys, so it cannot drift out of date.
 */

import { useEffect, useRef } from "react";

import styles from "./editor.module.css";
import { SPRITE_TOOL_SHORTCUTS } from "./tools";
import { WORKBENCH_SHORTCUTS, chordLabel, type Shortcut } from "./shortcuts";

interface ShortcutHelpProps {
  /** Tabs reachable by Ctrl+1..9, in display order. */
  tabs: readonly string[];
  onClose: () => void;
}

export function ShortcutHelp({ tabs, onClose }: ShortcutHelpProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups: Array<{ title: string; rows: Array<{ chord: string; label: string }> }> = [
    {
      title: "File",
      rows: [
        row(WORKBENCH_SHORTCUTS.save),
        row(WORKBENCH_SHORTCUTS.run),
        row(WORKBENCH_SHORTCUTS.download),
        row(WORKBENCH_SHORTCUTS.details),
      ],
    },
    {
      title: "Editing",
      rows: [row(WORKBENCH_SHORTCUTS.undo), row(WORKBENCH_SHORTCUTS.redo)],
    },
    {
      title: "Tabs",
      rows: tabs.map((tab, index) => ({ chord: `Ctrl+${index + 1}`, label: tab })),
    },
    {
      title: "Sprite tools",
      rows: SPRITE_TOOL_SHORTCUTS.map(({ key, label }) => ({ chord: key.toUpperCase(), label })),
    },
    {
      title: "Sprite editing",
      rows: [
        { chord: "[ / ]", label: "Brush size down / up" },
        { chord: "Alt+click", label: "Pick the colour under the cursor" },
        { chord: "Ctrl+C / X / V", label: "Copy / cut / paste the selection" },
        { chord: "H / V", label: "Flip the selection horizontally / vertically" },
        { chord: "R", label: "Rotate the selection a quarter turn" },
        { chord: "Arrows", label: "Nudge the selection one pixel" },
        { chord: "Esc", label: "Clear the selection" },
      ],
    },
    {
      title: "Sound",
      rows: [{ chord: "Space", label: "Play the selected sound or pattern" }],
    },
  ];

  return (
    <div className={styles.helpOverlay} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className={styles.helpCard}>
        <div className={styles.helpHead}>
          <h2 className={styles.helpTitle}>Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="cbx-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className={styles.helpGrid}>
          {groups.map((group) => (
            <section key={group.title} className={styles.helpGroup}>
              <h3 className={styles.helpGroupTitle}>{group.title}</h3>
              <dl className={styles.helpList}>
                {group.rows.map((entry) => (
                  <div key={`${group.title}:${entry.chord}:${entry.label}`} className={styles.helpRow}>
                    <dt className={`${styles.helpChord} data`}>{entry.chord}</dt>
                    <dd className={styles.helpLabel}>{entry.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className={styles.helpFoot}>
          A letter on its own never fires while you are typing in a field — only the Ctrl chords do.
        </p>
      </div>
    </div>
  );
}

function row(shortcut: Shortcut): { chord: string; label: string } {
  return { chord: chordLabel(shortcut), label: shortcut.label };
}
