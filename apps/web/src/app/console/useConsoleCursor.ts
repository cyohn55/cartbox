"use client";

/**
 * The button-driven cursor. While the UI owns the input, D-pad presses move
 * real focus between the interactive elements of every visible
 * `[data-console-nav]` region (screens opt in), A activates the focused
 * element, and B activates the region's `[data-console-back]` control.
 * Spatial choice is the pure pickNextFocus(); this hook feeds it live
 * getBoundingClientRect() values and styles the focused element.
 */

import { useRef, type RefObject } from "react";

import { useConsoleInput, useConsoleInputBus } from "./ConsoleInputContext";
import { pickInitialFocus, pickNextFocus, type CursorDirection } from "./consoleNavigation";

const FOCUSABLE_SELECTOR = 'button, a[href], input, select, textarea, [tabindex="0"]';
const CURSOR_CLASS = "os-cursor";

const DIRECTIONS = new Set<string>(["up", "down", "left", "right"]);

function collectCandidates(root: HTMLElement): HTMLElement[] {
  // A modal region (e.g. the settings overlay) captures the cursor: elements
  // underneath it stay in the DOM but must be unreachable.
  const modal = root.querySelector<HTMLElement>("[data-console-modal]");
  const regions = modal
    ? [modal]
    : [...root.querySelectorAll<HTMLElement>("[data-console-nav]")];
  const seen = new Set<HTMLElement>();
  const candidates: HTMLElement[] = [];
  for (const region of regions) {
    for (const el of region.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      if (seen.has(el) || el.hasAttribute("disabled")) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue; // display:none — not on screen at all
      }
      seen.add(el);
      candidates.push(el);
    }
  }
  return candidates;
}

/** Wires the cursor to everything rendered under `rootRef`. */
export function useConsoleCursor(rootRef: RefObject<HTMLElement | null>): void {
  const bus = useConsoleInputBus();
  // Fallback identity: tapping a physical shell button can steal DOM focus,
  // so the last cursor position is remembered independently of activeElement.
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const moveCursorTo = (element: HTMLElement) => {
    lastFocusedRef.current?.classList.remove(CURSOR_CLASS);
    element.classList.add(CURSOR_CLASS);
    lastFocusedRef.current = element;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  useConsoleInput((event) => {
    if (event.phase !== "press" || bus.owner !== "ui") {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const candidates = collectCandidates(root);
    if (candidates.length === 0) {
      return;
    }

    const remembered = lastFocusedRef.current;
    const current =
      document.activeElement instanceof HTMLElement && candidates.includes(document.activeElement)
        ? document.activeElement
        : remembered && remembered.isConnected && candidates.includes(remembered)
          ? remembered
          : null;

    if (DIRECTIONS.has(event.control)) {
      const rects = candidates.map((el) => el.getBoundingClientRect());
      const nextIndex = current
        ? pickNextFocus(current.getBoundingClientRect(), rects, event.control as CursorDirection)
        : pickInitialFocus(rects);
      if (nextIndex >= 0 && candidates[nextIndex] !== current) {
        moveCursorTo(candidates[nextIndex]!);
      }
      return;
    }

    if (event.control === "a") {
      if (current) {
        current.click();
      } else {
        moveCursorTo(candidates[pickInitialFocus(candidates.map((el) => el.getBoundingClientRect()))]!);
      }
      return;
    }

    if (event.control === "b") {
      root.querySelector<HTMLElement>("[data-console-back]")?.click();
    }
  });
}

/** True when the cursor currently sits on an element (feed cards use this to
 * keep their own A-button shortcuts from double-firing). */
export function cursorHasFocus(): boolean {
  return document.activeElement instanceof HTMLElement && document.activeElement.classList.contains(CURSOR_CLASS);
}
