"use client";

/**
 * Old-school boot loader: BIOS-style self-test lines typed onto a black
 * screen, then hands off to the title screen. Pure theater — the timings are
 * tuned to feel like hardware without making the user wait long.
 */

import { useEffect, useState } from "react";

const BOOT_LINES = [
  "CARTBOX BIOS v5.2 — 2026 Cartbox Systems",
  "CPU .............. LUA-80 @ 60 FPS",
  "VRAM ............. 16K OK",
  "WAVE TABLE ....... 8 CH OK",
  "CART SLOT ........ EMPTY",
  "NETWORK .......... LINK UP",
  "",
  "LOADING CARTBOX OS ...",
] as const;

/** Delay before each line "prints", ms — quick, like a memory check rushing by. */
const LINE_DELAY_MS = 170;
/** Pause after the last line before handing off to the title screen. */
const HANDOFF_DELAY_MS = 650;

export function BootScreen({ onComplete }: { onComplete: () => void }) {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    if (visibleLines < BOOT_LINES.length) {
      const timer = setTimeout(() => setVisibleLines((count) => count + 1), LINE_DELAY_MS);
      return () => clearTimeout(timer);
    }
    const handoff = setTimeout(onComplete, HANDOFF_DELAY_MS);
    return () => clearTimeout(handoff);
  }, [visibleLines, onComplete]);

  return (
    <div className="os-stage os-boot" data-testid="boot-screen">
      {BOOT_LINES.slice(0, visibleLines).map((line, index) => (
        <div key={index} className="os-boot-line">
          {line || " "}
        </div>
      ))}
      <div className="os-boot-cursor" />
    </div>
  );
}
