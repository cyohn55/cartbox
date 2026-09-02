"use client";

/**
 * Keyboard shortcuts for the workbench.
 *
 * The editor bound exactly two keys — undo and redo — which for a tool people
 * sit inside for hours is close to none. Not even Ctrl+S. This module holds the
 * vocabulary (so the shortcut and the help overlay can never disagree) and the
 * one rule every binding needs: a shortcut must not fire while the creator is
 * typing. The code textarea, the details panel and every numeric field are all
 * places where "b" means the letter b.
 */

import { useEffect } from "react";

/** A key chord as the creator would describe it. */
export interface Shortcut {
  /** Lower-case `event.key`, or a single digit. */
  readonly key: string;
  /** Requires Ctrl (Cmd on macOS). */
  readonly mod?: boolean;
  readonly shift?: boolean;
  /** What it does, for the help overlay. */
  readonly label: string;
  /** Which group it belongs to in the help overlay. */
  readonly group: "File" | "Editing" | "Tools" | "Navigation";
}

/** How a chord reads on this platform, e.g. "⌘S" or "Ctrl+S". */
export function chordLabel(shortcut: Shortcut, mac = isMac()): string {
  const parts: string[] = [];
  if (shortcut.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (shortcut.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return mac ? parts.join("") : parts.join("+");
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * Whether a key event landed in a text field, where a bare-letter shortcut
 * would eat the keystroke. Chords carrying Ctrl/Cmd still fire — Ctrl+S must
 * save from inside the code editor, which is exactly where it is wanted.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  // Duck-typed rather than `instanceof HTMLElement`: an element inside another
  // realm (an iframe, a portal) is not an instance of *this* realm's
  // constructor, and would wrongly be treated as safe to steal a key from.
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Whether the focused element would act on this key itself.
 *
 * Space and Enter activate a focused button or link. A bare-key shortcut that
 * fired anyway would both run and swallow the click — press Space after
 * clicking Play and the button would stop responding. Chords are unaffected:
 * nothing activates a button with Ctrl held.
 */
export function activatesOnKey(target: EventTarget | null, key: string): boolean {
  if (key !== " " && key !== "Enter" && key.toLowerCase() !== "enter") return false;
  const element = target as { tagName?: unknown; getAttribute?: (name: string) => string | null } | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toUpperCase();
  return tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
}

/** Does this event match the chord? */
export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (Boolean(shortcut.mod) !== mod) return false;
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  if (event.altKey) return false;
  return event.key.toLowerCase() === shortcut.key.toLowerCase();
}

/**
 * Bind a set of shortcuts for as long as the component is mounted.
 *
 * Handlers are looked up by shortcut id, so a caller declares its bindings once
 * and the overlay renders the same list the keyboard obeys. Bare-letter chords
 * are suppressed inside text fields; modifier chords are not.
 */
export function useShortcuts(
  bindings: ReadonlyArray<readonly [Shortcut, () => void]>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = isTypingTarget(event.target);
      for (const [shortcut, run] of bindings) {
        if (!matches(event, shortcut)) continue;
        // A bare key belongs to whatever has focus: a field being typed into,
        // or a button that Space and Enter already activate.
        if (!shortcut.mod && (typing || activatesOnKey(event.target, event.key))) continue;
        event.preventDefault();
        run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, enabled]);
}

/** The workbench-level shortcuts, which the help overlay also renders. */
export const WORKBENCH_SHORTCUTS = {
  save: { key: "s", mod: true, label: "Save", group: "File" },
  run: { key: "enter", mod: true, label: "Run the cartridge", group: "File" },
  download: { key: "d", mod: true, shift: true, label: "Download as .tic", group: "File" },
  undo: { key: "z", mod: true, label: "Undo", group: "Editing" },
  redo: { key: "z", mod: true, shift: true, label: "Redo", group: "Editing" },
  redoAlt: { key: "y", mod: true, label: "Redo", group: "Editing" },
  details: { key: "i", mod: true, label: "Cartridge details", group: "File" },
  help: { key: "?", shift: true, label: "This list", group: "Navigation" },
} as const satisfies Record<string, Shortcut>;

/** Tab switching is Ctrl+1..9 over the visible tab order. */
export const TAB_SHORTCUT_LIMIT = 9;
