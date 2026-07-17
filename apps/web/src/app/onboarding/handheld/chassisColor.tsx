"use client";

/**
 * Shares the currently-selected handheld chassis colour between the picker (which
 * owns it) and the backdrop (which tints itself to it). They are siblings on the
 * onboarding page, so a tiny context is the lightest way to couple them without
 * lifting the picker's large state.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const DEFAULT_CHASSIS = "#3a80d0";

interface ChassisColorValue {
  /** `#rrggbb` of the active chassis. */
  readonly color: string;
  readonly setColor: (color: string) => void;
}

const ChassisColorContext = createContext<ChassisColorValue>({
  color: DEFAULT_CHASSIS,
  setColor: () => {},
});

export function ChassisColorProvider({ children }: { children: ReactNode }) {
  const [color, setColor] = useState(DEFAULT_CHASSIS);
  const value = useMemo(() => ({ color, setColor }), [color]);
  return <ChassisColorContext.Provider value={value}>{children}</ChassisColorContext.Provider>;
}

export function useChassisColor(): ChassisColorValue {
  return useContext(ChassisColorContext);
}
