"use client";

/**
 * The Code tab's API reference panel: a searchable, collapsible list of the
 * `cartbox.*` SDK and the common TIC-80 built-ins (see sdkReference.ts), each
 * insertable into the cart at the caret. It is the editor's answer to "what can I
 * even call?" — the APIs are otherwise invisible in a bare textarea.
 */

import { useMemo, useState } from "react";

import { SDK_REFERENCE, type SdkEntry } from "./sdkReference";
import styles from "./editor.module.css";

interface SdkPanelProps {
  /** Insert an entry's snippet into the cart at the current caret. */
  onInsert: (snippet: string) => void;
}

export function SdkPanel({ onInsert }: SdkPanelProps) {
  const [query, setQuery] = useState("");

  // Filter every group by a case-insensitive match on the entry name, signature
  // or doc, dropping groups that end up empty so the list collapses to hits.
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return SDK_REFERENCE.map((group) => ({ group, entries: group.entries }));
    return SDK_REFERENCE.map((group) => ({
      group,
      entries: group.entries.filter((entry) =>
        `${entry.name} ${entry.signature} ${entry.doc}`.toLowerCase().includes(needle),
      ),
    })).filter((row) => row.entries.length > 0);
  }, [query]);

  const searching = query.trim().length > 0;

  return (
    <div className={styles.sdkPanel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>API reference</span>
      </div>
      <input
        className={styles.sdkSearch}
        type="search"
        value={query}
        placeholder="Search cartbox / TIC-80…"
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search the API reference"
      />
      <div className={styles.sdkGroups}>
        {groups.length === 0 && <p className={styles.sdkEmpty}>No API matches “{query}”.</p>}
        {groups.map(({ group, entries }) => (
          <SdkGroupBlock
            key={group.label}
            label={group.label}
            entries={entries}
            defaultOpen={group.open || searching}
            onInsert={onInsert}
          />
        ))}
      </div>
    </div>
  );
}

function SdkGroupBlock({
  label,
  entries,
  defaultOpen,
  onInsert,
}: {
  label: string;
  entries: readonly SdkEntry[];
  defaultOpen: boolean;
  onInsert: (snippet: string) => void;
}) {
  // `key` on the parent list already resets this when a search flips defaultOpen,
  // so plain initial state is enough — no effect needed to track the prop.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.sdkGroup}>
      <button
        type="button"
        className={styles.sdkGroupHead}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={styles.sdkGroupCaret} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        {label}
      </button>
      {open && (
        <ul className={styles.sdkList}>
          {entries.map((entry) => (
            <li key={entry.name} className={styles.sdkEntry}>
              <button
                type="button"
                className={styles.sdkEntryButton}
                onClick={() => onInsert(entry.snippet)}
                title={`Insert: ${entry.snippet}`}
              >
                <code className={styles.sdkSig}>{entry.signature}</code>
                <span className={styles.sdkDoc}>{entry.doc}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
