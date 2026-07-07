/**
 * CodeDocument — the editor-facing view of the cart's source. Pure (no DOM):
 * it reads and writes the text through the engine and derives the small facts
 * the editor chrome needs (line count, cursor line/column). The React editor
 * owns the live textarea value; this model is the source of truth and the
 * boundary the WASM engine will implement.
 */

import type { CartEngine } from "../engine/CartEngine";

export interface CursorPosition {
  line: number;
  column: number;
}

export class CodeDocument {
  constructor(private readonly engine: CartEngine) {}

  getText(): string {
    return this.engine.getCode();
  }

  setText(text: string): void {
    this.engine.setCode(text);
  }

  get language(): string {
    return this.engine.getLanguage();
  }

  setLanguage(language: string): void {
    this.engine.setLanguage(language);
  }

  lineCount(): number {
    const text = this.engine.getCode();
    return text.length === 0 ? 1 : text.split("\n").length;
  }

  /** 1-based line/column for a character offset — drives the cursor readout. */
  positionAt(offset: number): CursorPosition {
    const text = this.engine.getCode();
    const clamped = Math.max(0, Math.min(offset, text.length));
    const before = text.slice(0, clamped);
    const newline = before.lastIndexOf("\n");
    return {
      line: before.split("\n").length,
      column: clamped - newline,
    };
  }
}
