"use client";

import { createContext, useContext } from "react";

/**
 * The workbench top bar carries a single "⋯" overflow menu. Tab editors that
 * would otherwise grow a second "⋯" of their own — the Assets strip is the one
 * that does — render their low-frequency actions into *this* menu instead, so a
 * creator only ever hunts through one overflow button.
 *
 * The provider (EditorWorkbench) hands down the menu's portal target and a way
 * to close it after an action is chosen. `node` is null whenever the menu is not
 * mounted, which is the signal a consumer uses to fall back to its own button.
 */
export interface OverflowMenuSlot {
  /** Portal target inside the top-bar "⋯" menu, or null when unavailable. */
  node: HTMLElement | null;
  /** Close the top-bar menu — called right after an action item runs. */
  close: () => void;
}

export const OverflowMenuContext = createContext<OverflowMenuSlot | null>(null);

/** The workbench overflow slot, or null when rendered outside the workbench. */
export function useOverflowMenuSlot(): OverflowMenuSlot | null {
  return useContext(OverflowMenuContext);
}
