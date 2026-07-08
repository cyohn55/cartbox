"use client";

/**
 * React plumbing for the handheld input bus: the shell provides one bus per
 * console; screens subscribe with a hook that handles unsubscribe on unmount.
 */

import { createContext, useContext, useEffect, useRef } from "react";

import type { ConsoleInputBus, ConsoleInputEvent } from "./consoleInput";

export const ConsoleInputContext = createContext<ConsoleInputBus | null>(null);

/** The shell's input bus. Throws when used outside <HandheldConsole>. */
export function useConsoleInputBus(): ConsoleInputBus {
  const bus = useContext(ConsoleInputContext);
  if (!bus) {
    throw new Error("useConsoleInputBus must be used inside HandheldConsole");
  }
  return bus;
}

/**
 * Subscribes to shell button events for the lifetime of the component. The
 * handler is kept in a ref so subscribers don't churn on every render.
 */
export function useConsoleInput(handler: (event: ConsoleInputEvent) => void): void {
  const bus = useConsoleInputBus();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => bus.subscribe((event) => handlerRef.current(event)), [bus]);
}
