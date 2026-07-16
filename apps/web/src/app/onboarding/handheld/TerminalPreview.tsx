"use client";

/**
 * A compact, non-interactive preview of the console OS skin, shown beside the UI
 * tuning controls in onboarding so the player sees their phosphor and scanline
 * choices immediately. It mirrors the real terminal treatment (monochrome tint +
 * CRT overlay from console.css) at a small size; the actual OS applies the same
 * look full-screen via `data-os-*` on `.os-root`.
 */

import type { OsPhosphorId, OsStyleId } from "@/app/console/consoleSettings";
import styles from "./handheld.module.css";

interface TerminalPreviewProps {
  style: OsStyleId;
  phosphor: OsPhosphorId;
  scanlines: boolean;
}

const MENU = ["FEED", "BROWSE", "LIBRARY", "PROFILE"];

export function TerminalPreview({ style, phosphor, scanlines }: TerminalPreviewProps) {
  return (
    <div
      className={styles.termPreview}
      data-os-style={style}
      data-os-phosphor={phosphor}
      data-os-scanlines={scanlines ? "on" : "off"}
      aria-label={`${style === "pipboy" ? "Pip-Boy terminal" : "Modern"} preview`}
    >
      <div className={styles.termContent}>
        <div className={styles.termTop}>
          <span>CARTBOX OS</span>
          <span>v2.6</span>
        </div>
        <div className={styles.termBoot}>&gt; INIT OK · FEED READY</div>
        <ul className={styles.termMenu}>
          {MENU.map((label, index) => (
            <li key={label} className={index === 0 ? styles.termActive : undefined}>
              <span aria-hidden>{index === 0 ? ">" : " "}</span> {label}
            </li>
          ))}
        </ul>
        <div className={styles.termFoot}>
          <span>PWR 87%</span>
          <span>ONLINE</span>
        </div>
      </div>
      {style === "pipboy" && <div className={styles.termCrt} aria-hidden />}
    </div>
  );
}
