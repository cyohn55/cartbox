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

import { useEffect, useState, type ReactNode } from "react";

import styles from "./editor.module.css";
import { resolveGroupOpen, useEditorDensity } from "./editorDensity";

/** An id a control can be keyed and selected by. */
type OptionId = string | number;

interface RailGroupProps {
  /** Uppercase group heading, e.g. "Tool". */
  label: string;
  children: ReactNode;
  /**
   * Render as a disclosure the creator can fold away. A collapsible group rests
   * closed; pass {@link advanced} to have it follow the editor's density instead.
   */
  collapsible?: boolean;
  /**
   * Mark this as an infrequently-used group. It becomes collapsible and, unless
   * {@link defaultOpen} overrides it, folds away in Simple density and opens in
   * Full — the single lever that declutters every tab at once.
   */
  advanced?: boolean;
  /** Force the initial open state, overriding the density-driven default. */
  defaultOpen?: boolean;
}

/**
 * A labelled section of the rail.
 *
 * Plain by default: a heading over its controls, exactly as every tab has always
 * drawn it. Passing {@link RailGroupProps.collapsible} or
 * {@link RailGroupProps.advanced} turns it into a disclosure so the rare controls
 * can tuck behind their heading — the mechanism the whole declutter rests on, so
 * it lives in the one shared primitive rather than being re-invented per tab.
 */
export function RailGroup({ label, children, collapsible = false, advanced = false, defaultOpen }: RailGroupProps) {
  const density = useEditorDensity();
  const foldable = collapsible || advanced;
  const [open, setOpen] = useState(() => resolveGroupOpen(density, { advanced, defaultOpen }));

  // An advanced group follows the density switch: flipping Simple/Full is an
  // explicit "hide/show the advanced controls" gesture, so it re-resolves the
  // rest state. A caller that pinned the state with defaultOpen keeps its choice.
  useEffect(() => {
    if (advanced && defaultOpen === undefined) setOpen(density === "full");
  }, [density, advanced, defaultOpen]);

  if (!foldable) {
    return (
      <div>
        <div className={styles.groupLabel}>{label}</div>
        {children}
      </div>
    );
  }

  return (
    <div className={styles.railGroupFoldable} data-open={open || undefined}>
      <button
        type="button"
        className={styles.railDisclosure}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.railDisclosureCaret} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className={styles.groupLabel}>{label}</span>
      </button>
      {open && <div className={styles.railGroupBody}>{children}</div>}
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

interface StepperProps {
  label: string;
  /** Accessible name and tooltip for the decrement button. */
  decreaseLabel: string;
  /** Accessible name and tooltip for the increment button. */
  increaseLabel: string;
  onDecrease: () => void;
  onIncrease: () => void;
  decreaseDisabled?: boolean;
  increaseDisabled?: boolean;
  /** Tooltip override for a disabled increment — "Maximum zoom" rather than silence. */
  increaseHint?: string;
}

/**
 * A −/＋ pair in the shape of a segmented control.
 *
 * Zoom is the case this exists for, and it is deliberately *not* a
 * {@link SegmentedControl}: that models "pick one of these", and stepping a
 * continuous value is not picking. Borrowing the segmented look keeps it in the
 * rail's visual family anyway, so a tab that steps its zoom and one that picks
 * from presets still read as the same control in the same slot.
 */
export function Stepper({
  label,
  decreaseLabel,
  increaseLabel,
  onDecrease,
  onIncrease,
  decreaseDisabled = false,
  increaseDisabled = false,
  increaseHint,
}: StepperProps) {
  return (
    <RailGroup label={label}>
      <div className={styles.segmented} role="group" aria-label={label}>
        <button
          type="button"
          className={styles.segment}
          onClick={onDecrease}
          disabled={decreaseDisabled}
          aria-label={decreaseLabel}
          title={decreaseLabel}
        >
          −
        </button>
        <button
          type="button"
          className={styles.segment}
          onClick={onIncrease}
          disabled={increaseDisabled}
          aria-label={increaseLabel}
          title={increaseDisabled ? (increaseHint ?? increaseLabel) : increaseLabel}
        >
          ＋
        </button>
      </div>
    </RailGroup>
  );
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
