"use client";

/**
 * The workbench's two side panels, rendered from the slot contract.
 *
 * A tab hands its controls in keyed by slot and gets them back in the order
 * {@link ./workbenchLayout} defines. It never sees the order, so it cannot
 * disagree with it — which is the whole point: before this, every tab spelled
 * out its own `<aside className={styles.rail}>` and chose its own sequence, and
 * the sequences drifted apart one well-meaning insertion at a time.
 *
 * Purely structural. What a control *is* stays with the tab that owns it; only
 * where it lands is decided here.
 */

import { Fragment, type ReactNode } from "react";

import styles from "./editor.module.css";
import { RailGroup } from "./railControls";
import {
  INSPECTOR_SLOTS,
  INSPECTOR_SLOT_FOLDS,
  RAIL_SLOTS,
  RAIL_SLOT_FOLDS,
  orderedSlots,
  type InspectorSlot,
  type RailSlot,
  type SlotContent,
  type SlotFold,
} from "./workbenchLayout";

/** A tab's rail controls, by slot. */
export type RailSlots = SlotContent<RailSlot, ReactNode>;

/** A tab's inspector panels, by slot. */
export type InspectorSlots = SlotContent<InspectorSlot, ReactNode>;

/**
 * A slot's content, wrapped in its wholesale disclosure when the layout declares
 * one. Groups the slot already contains render plainly inside it — the fold sits
 * one level above them, so there is a single caret over the whole slot rather
 * than one per group.
 */
function foldedSlot(fold: SlotFold | undefined, content: ReactNode): ReactNode {
  if (!fold) return content;
  return (
    <RailGroup label={fold.label} collapsible advanced={fold.advanced}>
      {content}
    </RailGroup>
  );
}

/** The left rail: how you are editing. */
export function WorkbenchRail({ slots }: { slots: RailSlots }) {
  return (
    <aside className={styles.rail}>
      {orderedSlots(RAIL_SLOTS, slots).map(({ slot, content }) => (
        <Fragment key={slot}>{foldedSlot(RAIL_SLOT_FOLDS[slot], content)}</Fragment>
      ))}
    </aside>
  );
}

/** The right inspector: what you are editing with. */
export function WorkbenchInspector({ slots }: { slots: InspectorSlots }) {
  return (
    <aside className={styles.inspector}>
      {orderedSlots(INSPECTOR_SLOTS, slots).map(({ slot, content }) => (
        <Fragment key={slot}>{foldedSlot(INSPECTOR_SLOT_FOLDS[slot], content)}</Fragment>
      ))}
    </aside>
  );
}

interface InspectorPanelProps {
  /** The panel heading, e.g. "Palette". */
  title: string;
  /** The right-hand readout — the armed value, a count, a hex. */
  meta?: ReactNode;
  /** A control in the heading row, after the readout. */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * A titled inspector panel.
 *
 * The heading row (title, readout, optional control) had been rebuilt inline in
 * six places, which is how the map's material heading came to need a hand-typed
 * `marginTop: 14` to sit where every other heading sits for free.
 */
export function InspectorPanel({ title, meta, action, children }: InspectorPanelProps) {
  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
        {meta !== undefined && <span className={styles.panelMeta}>{meta}</span>}
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * The paragraph explaining what the active tool does here.
 *
 * Last in the inspector in every tab, so it reads as a footnote to the controls
 * above rather than as one more panel competing with them.
 */
export function InspectorHint({ children }: { children: ReactNode }) {
  return <p className={styles.inspectorHint}>{children}</p>;
}
