"use client";

/**
 * Console personalization state: loaded from localStorage once the shell
 * mounts, saved on every change, shared with the shell (theme/controls) and
 * the settings screen.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import {
  DEFAULT_CONSOLE_SETTINGS,
  loadConsoleSettings,
  saveConsoleSettings,
  type ConsoleSettings,
} from "./consoleSettings";

interface ConsoleSettingsContextValue {
  settings: ConsoleSettings;
  update: (patch: Partial<ConsoleSettings>) => void;
  /** The settings panel overlay: opened by START or the bezel gear. */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
}

const ConsoleSettingsContext = createContext<ConsoleSettingsContextValue | null>(null);

export function ConsoleSettingsProvider({ children }: { children: ReactNode }) {
  // SSR renders the defaults; the stored settings apply after hydration.
  const [settings, setSettings] = useState<ConsoleSettings>(DEFAULT_CONSOLE_SETTINGS);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    setSettings(loadConsoleSettings());
  }, []);

  const update = (patch: Partial<ConsoleSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveConsoleSettings(next);
      return next;
    });
  };

  return (
    <ConsoleSettingsContext.Provider value={{ settings, update, panelOpen, setPanelOpen }}>
      {children}
    </ConsoleSettingsContext.Provider>
  );
}

export function useConsoleSettings(): ConsoleSettingsContextValue {
  const value = useContext(ConsoleSettingsContext);
  if (!value) {
    throw new Error("useConsoleSettings must be used inside ConsoleSettingsProvider");
  }
  return value;
}
