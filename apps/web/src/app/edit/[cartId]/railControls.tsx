"use client";

/**
 * The workbench rail's shared controls.
 *
 * Every editor tab lays out the same left rail — a stack of labelled groups
 * holding tool buttons, segmented pickers, and sliders — and until now each tab
 * spelled that markup out again, class names and ARIA and all. The duplication
 * was not just bulk: the copies had already drifted (some segmented pickers set
 * `aria-pressed`, some didn't; sub-labels used three different top margins), so
 * a fix applied in one tab silently missed the others.
 *
 * These components are presentational and fully controlled — they own no state
 * and make no decisions about what a control means. That is what lets the sprite
 * editor, the voxel sculptor and the map editor share them without any of them
 * having to agree on what they are editing.
 */

import type { ReactNode } from "react";

import styles from "./editor.module.css";

/** An id a control can be keyed and selected by. */
type OptionId = string | number;

interface RailGroupProps {
  /** Uppercase group heading, e.g. "Tool". */
  label: string;
  children: ReactNode;
}

/** A labelled section of the rail. */
export function RailGroup({ label, children }: RailGroupProps) {
  return (
    <div>
      <div className={styles.groupLabel}>{label}</div>
      {children}
    </div>
  );
}

/**
 * Explanatory copy under a control — what the active tool does, what the current
 * setting means. Muted and spaced away from the control it follows.
 */
export function RailHint({ children }: { children: ReactNode }) {
  return <p className={styles.railHint}>{children}</p>;
}

interface ToolRailProps<Id extends OptionId> {
  label: string;
  tools: readonly { readonly id: Id; readonly label: string; readonly glyph: string; readonly hint?: string }[];
  selected: Id;
  onSelect: (id: Id) => void;
}

/**
 * A vertical list of glyph + label tool buttons.
 *
 * Generic over the id type so the same rail renders 2D drawing tools, voxel
 * tools, and the map editor's layer picker — it only needs something to key and
 * compare by.
 */
export function ToolRail<Id extends OptionId>({ label, tools, selected, onSelect }: ToolRailProps<Id>) {
  return (
    <RailGroup label={label}>
      <div className={styles.toolGroup}>
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`${styles.toolBtn} ${tool.id === selected ? styles.toolBtnActive : ""}`}
            onClick={() => onSelect(tool.id)}
            aria-pressed={tool.id === selected}
            title={tool.hint}
          >
            <span className={styles.toolGlyph} aria-hidden>
              {tool.glyph}
            </span>
            {tool.label}
          </button>
        ))}
      </div>
    </RailGroup>
  );
}

interface SegmentedControlProps<Id extends OptionId> {
  /** Group heading; omitted when the control sits inside a group already labelled. */
  label?: string;
  options: readonly { readonly id: Id; readonly label: string; readonly hint?: string }[];
  /** The active option, or null when the control can rest with nothing chosen. */
  selected: Id | null;
  onSelect: (id: Id) => void;
  /** Wrap onto multiple rows — for sets too wide to sit on one line. */
  wrap?: boolean;
  /** Separate this row from the control directly above it. */
  spaced?: boolean;
  /** Describes the control for assistive tech when there is no visible label. */
  ariaLabel?: string;
}

/**
 * A single-select row of joined buttons.
 *
 * Selection semantics stay with the caller — this reports the clicked id and
 * nothing more, so a control that toggles its active option off (the voxel scale
 * axis) and one that cannot (the sprite page) share the same component.
 */
export function SegmentedControl<Id extends OptionId>({
  label,
  options,
  selected,
  onSelect,
  wrap = false,
  spaced = false,
  ariaLabel,
}: SegmentedControlProps<Id>) {
  const row = (
    <div
      className={[styles.segmented, wrap ? styles.segmentedWrap : "", spaced ? styles.railSpaced : ""]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={ariaLabel ?? label}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`${styles.segment} ${option.id === selected ? styles.segmentActive : ""}`}
          onClick={() => onSelect(option.id)}
          aria-pressed={option.id === selected}
          title={option.hint}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  return label ? <RailGroup label={label}>{row}</RailGroup> : row;
}

interface RangeControlProps {
  /** Group heading; omitted when the caller supplies its own surrounding label. */
  label?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  /** Required: the slider carries no visible label of its own to fall back on. */
  ariaLabel: string;
  /** The readout beside the slider. Defaults to the raw value. */
  display?: string;
  /** Render the heading as a sub-label of the group it sits in. */
  nested?: boolean;
}

/**
 * A labelled slider with a value readout.
 *
 * `value` and `display` are separate because they routinely disagree — the voxel
 * brush stores a radius but reads out a diameter, and lighting stores a 0..1
 * fraction but reads out a percentage.
 */
export function RangeControl({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  ariaLabel,
  display,
  nested = false,
}: RangeControlProps) {
  const row = (
    <div className={styles.rangeRow}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={ariaLabel}
      />
      <span className={`${styles.rangeValue} data`}>{display ?? value}</span>
    </div>
  );

  if (!label) return row;
  // Nested sliders sit inside a group that already has a heading, so they get a
  // spaced sub-label rather than a group of their own.
  if (nested) {
    return (
      <>
        <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>{label}</div>
        {row}
      </>
    );
  }
  return <RailGroup label={label}>{row}</RailGroup>;
}
