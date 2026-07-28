/**
 * EditHistory tests — the pure undo/redo timeline that backs every editor tab.
 * These drive the real class with plain snapshots and assert on observable
 * behaviour: cursor movement, redo-tail forking, no-op de-duplication, and the
 * retention limit. No hard-coded internal state is inspected; every assertion
 * goes through current()/undo()/redo()/canUndo()/canRedo().
 */

import { describe, expect, it } from "vitest";
import { EditHistory } from "@cartbox/editor";

describe("EditHistory timeline", () => {
  it("starts on the baseline with nothing to undo or redo", () => {
    const history = new EditHistory("a");
    expect(history.current()).toBe("a");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it("records edits and walks back and forward through them", () => {
    const history = new EditHistory("a");
    history.record("b");
    history.record("c");

    expect(history.current()).toBe("c");
    expect(history.undo()).toBe("b");
    expect(history.undo()).toBe("a");
    expect(history.canUndo()).toBe(false);
    expect(history.redo()).toBe("b");
    expect(history.redo()).toBe("c");
    expect(history.canRedo()).toBe(false);
  });

  it("returns null and holds position at the ends of the timeline", () => {
    const history = new EditHistory("a");
    history.record("b");

    expect(history.undo()).toBe("a");
    expect(history.undo()).toBeNull();
    expect(history.current()).toBe("a");
    expect(history.redo()).toBe("b");
    expect(history.redo()).toBeNull();
    expect(history.current()).toBe("b");
  });

  it("drops the redo tail when a new edit forks the timeline", () => {
    const history = new EditHistory("a");
    history.record("b");
    history.record("c");
    history.undo(); // back to "b"

    history.record("d"); // forks: "c" future is discarded
    expect(history.current()).toBe("d");
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toBe("b");
  });

  it("ignores a record equal to the current snapshot", () => {
    const equals = (a: { v: number }, b: { v: number }) => a.v === b.v;
    const history = new EditHistory({ v: 1 }, { equals });

    expect(history.record({ v: 1 })).toBe(false);
    expect(history.size()).toBe(1);
    expect(history.record({ v: 2 })).toBe(true);
    expect(history.size()).toBe(2);
  });

  it("evicts the oldest snapshots past the retention limit", () => {
    const history = new EditHistory("s0", { limit: 3 });
    history.record("s1");
    history.record("s2");
    history.record("s3"); // exceeds limit: "s0" evicted

    expect(history.size()).toBe(3);
    expect(history.undo()).toBe("s2");
    expect(history.undo()).toBe("s1");
    // "s0" is gone, so the timeline bottoms out at "s1".
    expect(history.canUndo()).toBe(false);
    expect(history.current()).toBe("s1");
  });

  it("keeps the cursor pointing at the same snapshot after eviction", () => {
    const history = new EditHistory(0, { limit: 2 });
    history.record(1);
    history.record(2); // evicts 0; timeline is [1, 2], cursor at 2
    expect(history.current()).toBe(2);
    expect(history.undo()).toBe(1);
  });
});
