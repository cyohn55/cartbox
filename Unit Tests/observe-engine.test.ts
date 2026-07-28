/**
 * observeEngine tests — the change-notifying wrapper that lets the workbench
 * coalesce edits into undo steps without any editor tab reporting its own edits.
 * These drive the real StubCartEngine (the same object the UI's model views sit
 * on) through the proxy and assert on observable behaviour: mutating calls fire
 * the listener, reads and bank switches do not, and every call still forwards to
 * the underlying live cart memory.
 */

import { describe, expect, it } from "vitest";
import { StubCartEngine, observeEngine } from "@cartbox/editor";

describe("observeEngine change notification", () => {
  it("forwards writes to the underlying engine and reads them back", () => {
    const engine = new StubCartEngine();
    const observed = observeEngine(engine, () => {});

    observed.setPixel(0, 3, 2, 1, 9);
    expect(observed.getPixel(0, 3, 2, 1)).toBe(9);
    // The proxy is a view onto the same cart, so the raw engine sees it too.
    expect(engine.getPixel(0, 3, 2, 1)).toBe(9);
  });

  it("fires the listener once per mutating call", () => {
    const engine = new StubCartEngine();
    let mutations = 0;
    const observed = observeEngine(engine, () => {
      mutations += 1;
    });

    observed.setPixel(0, 0, 0, 0, 5);
    observed.setMapCell(4, 4, 12);
    observed.setCode("print('hi')");
    observed.setSfxVolume(0, 0, 7);
    observed.setMusicNoteField(0, 0, 4);

    expect(mutations).toBe(5);
  });

  it("does not fire the listener for reads", () => {
    const engine = new StubCartEngine();
    engine.setPixel(0, 0, 0, 0, 4);
    let mutations = 0;
    const observed = observeEngine(engine, () => {
      mutations += 1;
    });

    observed.getPixel(0, 0, 0, 0);
    observed.getMapCell(0, 0);
    observed.getCode();
    observed.getPalette();

    expect(mutations).toBe(0);
  });

  it("treats bank switching as navigation, not an edit", () => {
    const engine = new StubCartEngine();
    let mutations = 0;
    const observed = observeEngine(engine, () => {
      mutations += 1;
    });

    observed.setBank(2);
    expect(observed.getBank()).toBe(2);
    expect(mutations).toBe(0);
  });

  it("preserves instanceof against the wrapped engine class", () => {
    const engine = new StubCartEngine();
    const observed = observeEngine(engine, () => {});
    expect(observed).toBeInstanceOf(StubCartEngine);
  });
});
