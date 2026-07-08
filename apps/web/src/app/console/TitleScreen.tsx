"use client";

/**
 * Cartbox title screen: logo splash + blinking "PRESS START". Continues on
 * Start/A from the shell buttons or a tap anywhere on the screen.
 */

import { useConsoleInput } from "./ConsoleInputContext";

export function TitleScreen({ onContinue }: { onContinue: () => void }) {
  useConsoleInput((event) => {
    if (event.phase === "press" && (event.control === "start" || event.control === "a")) {
      onContinue();
    }
  });

  return (
    <div
      className="os-stage os-title"
      data-testid="title-screen"
      onClick={onContinue}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onContinue();
        }
      }}
    >
      <div className="os-title-logo">CARTBOX</div>
      <div className="os-title-sub">MAKE · PLAY · SHARE</div>
      <div className="os-title-start">PRESS START</div>
    </div>
  );
}
