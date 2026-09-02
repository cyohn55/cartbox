/**
 * Shortcut tests (apps/web/src/app/edit/[cartId]/shortcuts.ts and tools.ts).
 *
 * The editor bound two keys — undo and redo — and not even Ctrl+S. Adding the
 * rest brings one hazard worth testing directly: a bare letter must never fire
 * while the creator is typing, or "b" switches tools mid-sentence in the code
 * editor. Modifier chords must fire there, because Ctrl+S from inside the code
 * editor is exactly where saving is wanted.
 */

import { describe, expect, it } from "vitest";

import {
  activatesOnKey,
  chordLabel,
  isTypingTarget,
  matches,
  WORKBENCH_SHORTCUTS,
} from "@/app/edit/[cartId]/shortcuts";
import { SPRITE_TOOL_SHORTCUTS, TOOLS } from "@/app/edit/[cartId]/tools";

/** A KeyboardEvent-shaped object; `matches` reads only these fields. */
function key(
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key: name,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
  } as KeyboardEvent;
}

/** An element-shaped stand-in, since these tests run without a DOM. */
function element(tagName: string, contentEditable = false): EventTarget {
  return { tagName, isContentEditable: contentEditable } as unknown as EventTarget;
}

describe("matching a chord", () => {
  it("matches Ctrl+S to the save shortcut", () => {
    expect(matches(key("s", { ctrl: true }), WORKBENCH_SHORTCUTS.save)).toBe(true);
  });

  it("accepts Cmd as well as Ctrl", () => {
    expect(matches(key("s", { meta: true }), WORKBENCH_SHORTCUTS.save)).toBe(true);
  });

  it("does not match a bare S to Ctrl+S", () => {
    expect(matches(key("s"), WORKBENCH_SHORTCUTS.save)).toBe(false);
  });

  it("keeps undo and redo apart by their Shift", () => {
    const plain = key("z", { ctrl: true });
    const shifted = key("z", { ctrl: true, shift: true });
    expect(matches(plain, WORKBENCH_SHORTCUTS.undo)).toBe(true);
    expect(matches(plain, WORKBENCH_SHORTCUTS.redo)).toBe(false);
    expect(matches(shifted, WORKBENCH_SHORTCUTS.redo)).toBe(true);
    expect(matches(shifted, WORKBENCH_SHORTCUTS.undo)).toBe(false);
  });

  it("ignores a chord carrying Alt, which belongs to the canvas", () => {
    expect(matches(key("s", { ctrl: true, alt: true }), WORKBENCH_SHORTCUTS.save)).toBe(false);
  });

  it("is case-insensitive, so Caps Lock does not break a shortcut", () => {
    expect(matches(key("S", { ctrl: true }), WORKBENCH_SHORTCUTS.save)).toBe(true);
  });

  it("matches Ctrl+Enter to Run", () => {
    expect(matches(key("Enter", { ctrl: true }), WORKBENCH_SHORTCUTS.run)).toBe(true);
  });
});

describe("recognising a text field", () => {
  it("treats inputs, textareas and selects as typing targets", () => {
    expect(isTypingTarget(element("INPUT"))).toBe(true);
    expect(isTypingTarget(element("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(element("SELECT"))).toBe(true);
  });

  it("treats a contenteditable element as a typing target", () => {
    expect(isTypingTarget(element("DIV", true))).toBe(true);
  });

  it("does not treat a button or the document as one", () => {
    expect(isTypingTarget(element("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("the sprite tool bindings", () => {
  it("binds a key to every tool in the palette", () => {
    // A tool added to the table and left unbound is a tool nobody can reach
    // from the keyboard, and one the help overlay never lists.
    expect(SPRITE_TOOL_SHORTCUTS).toHaveLength(TOOLS.length);
  });

  it("gives no two tools the same key", () => {
    const keys = SPRITE_TOOL_SHORTCUTS.map((binding) => binding.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses single lower-case letters, which is what the handler compares", () => {
    for (const binding of SPRITE_TOOL_SHORTCUTS) {
      expect(binding.key, binding.tool).toBe(binding.key.toLowerCase());
      expect(binding.key.length, binding.tool).toBe(1);
    }
  });

  it("names each binding after the tool it selects", () => {
    for (const binding of SPRITE_TOOL_SHORTCUTS) {
      expect(TOOLS.find((tool) => tool.id === binding.tool)?.label).toBe(binding.label);
    }
  });
});

describe("chord labels", () => {
  it("spells a chord out for a PC keyboard", () => {
    expect(chordLabel(WORKBENCH_SHORTCUTS.save, false)).toBe("Ctrl+S");
    expect(chordLabel(WORKBENCH_SHORTCUTS.redo, false)).toBe("Ctrl+Shift+Z");
  });

  it("uses the Mac glyphs on a Mac", () => {
    expect(chordLabel(WORKBENCH_SHORTCUTS.save, true)).toBe("⌘S");
    expect(chordLabel(WORKBENCH_SHORTCUTS.redo, true)).toBe("⌘⇧Z");
  });
});

describe("keys the focused element already handles", () => {
  it("leaves Space to a focused button, which it activates", () => {
    // Otherwise pressing Space after clicking Play would both re-run the
    // shortcut and swallow the button's own activation.
    expect(activatesOnKey(element("BUTTON"), " ")).toBe(true);
    expect(activatesOnKey(element("A"), "Enter")).toBe(true);
  });

  it("does not withhold an ordinary letter from a button", () => {
    expect(activatesOnKey(element("BUTTON"), "b")).toBe(false);
  });

  it("does not withhold anything from a plain container", () => {
    expect(activatesOnKey(element("DIV"), " ")).toBe(false);
  });
});
