/**
 * A value written faster than its store can catch up.
 *
 * This exists because of a specific, reproducible failure: in the map's walking
 * view, holding W while moving the mouse meant the mouse stopped turning the
 * camera. Both the animation loop and the mouse listener read the camera from a
 * mirror of React state that only refreshes on render, so between one of them
 * calling the setter and the re-render arriving, the other read the old camera
 * and its update replaced the first one entirely. Measured in a real browser, the
 * same mouse gesture bought 0.73 radians of turn alone and −0.23 with a movement
 * key held.
 *
 * The tests below are that story stated as properties: updates compose, echoes of
 * our own updates are ignored, and genuinely external values are adopted.
 */

import { describe, expect, it } from "vitest";

import { createLiveValue } from "@/lib/liveValue";

interface Camera {
  readonly x: number;
  readonly yaw: number;
}

/** A cell plus the log of what it announced. */
function cellWithLog(initial: Camera) {
  const emitted: Camera[] = [];
  const cell = createLiveValue<Camera>(initial, (next) => emitted.push(next));
  return { cell, emitted };
}

describe("composing updates between commits", () => {
  it("applies each update to the result of the last, not to the stored value", () => {
    // The failure in one line: two writers, no render in between.
    const { cell, emitted } = cellWithLog({ x: 0, yaw: 0 });

    cell.update((camera) => ({ ...camera, x: camera.x + 5 })); // the walk loop
    cell.update((camera) => ({ ...camera, yaw: camera.yaw + 1 })); // the mouse

    expect(cell.current).toEqual({ x: 5, yaw: 1 });
    expect(emitted[emitted.length - 1]).toEqual({ x: 5, yaw: 1 });
  });

  it("keeps composing across many interleaved writes", () => {
    const { cell } = cellWithLog({ x: 0, yaw: 0 });

    for (let i = 0; i < 50; i += 1) {
      cell.update((camera) => ({ ...camera, x: camera.x + 1 }));
      cell.update((camera) => ({ ...camera, yaw: camera.yaw + 0.1 }));
    }

    expect(cell.current.x).toBe(50);
    expect(cell.current.yaw).toBeCloseTo(5, 10);
  });

  it("announces every update, so the store ends up with the latest", () => {
    const { cell, emitted } = cellWithLog({ x: 0, yaw: 0 });

    cell.update((camera) => ({ ...camera, x: 1 }));
    cell.update((camera) => ({ ...camera, x: 2 }));

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toBe(cell.current);
  });
});

describe("taking a value back from the store", () => {
  it("ignores the store merely catching up with our own update", () => {
    // This is what makes composition survive: the render that arrives after an
    // update carries a value the cell has already moved past.
    const { cell } = cellWithLog({ x: 0, yaw: 0 });

    const stored = cell.update((camera) => ({ ...camera, x: 1 }));
    cell.update((camera) => ({ ...camera, x: 2 })); // a second write, no render yet
    cell.receive(stored); // the render for the *first* write finally lands

    expect(cell.current.x).toBe(2);
  });

  it("adopts a value that came from somewhere else", () => {
    // A button that moves the camera, a mode switch, a reset: here the outside
    // really is the authority and the live value must yield.
    const { cell } = cellWithLog({ x: 0, yaw: 0 });
    cell.update((camera) => ({ ...camera, x: 1 }));

    cell.receive({ x: 99, yaw: 9 });

    expect(cell.current).toEqual({ x: 99, yaw: 9 });
  });

  it("ignores an echo of an older update while newer ones are in flight", () => {
    // The store does not have to catch up in one go. If it echoes an update from
    // two writes ago, that says "caught up this far" — not "go back to there".
    const { cell } = cellWithLog({ x: 0, yaw: 0 });

    const first = cell.update((camera) => ({ ...camera, x: 1 }));
    cell.update((camera) => ({ ...camera, x: 2 }));
    cell.update((camera) => ({ ...camera, x: 3 }));
    cell.receive(first);

    expect(cell.current.x).toBe(3);
  });

  it("still adopts an external value after an old echo has been seen", () => {
    const { cell } = cellWithLog({ x: 0, yaw: 0 });

    const first = cell.update((camera) => ({ ...camera, x: 1 }));
    cell.update((camera) => ({ ...camera, x: 2 }));
    cell.receive(first);
    cell.receive({ x: 42, yaw: 0 });

    expect(cell.current.x).toBe(42);
  });

  it("adopts before anything has been written at all", () => {
    const { cell } = cellWithLog({ x: 0, yaw: 0 });

    cell.receive({ x: 7, yaw: 7 });

    expect(cell.current).toEqual({ x: 7, yaw: 7 });
  });

  it("builds the next update on an adopted value", () => {
    const { cell } = cellWithLog({ x: 0, yaw: 0 });

    cell.receive({ x: 10, yaw: 0 });
    cell.update((camera) => ({ ...camera, x: camera.x + 1 }));

    expect(cell.current.x).toBe(11);
  });
});

describe("stores that do not keep the object they are given", () => {
  it("recognises its own value by fields when identity will not do", () => {
    // The orbit camera arrives as three separate numbers rebuilt each render, so
    // identity would call every render an external change and undo the drag.
    const emitted: Camera[] = [];
    const cell = createLiveValue<Camera>(
      { x: 0, yaw: 0 },
      (next) => emitted.push(next),
      (a, b) => a.x === b.x && a.yaw === b.yaw,
    );

    cell.update((camera) => ({ ...camera, yaw: 1 }));
    cell.update((camera) => ({ ...camera, yaw: 2 }));
    cell.receive({ x: 0, yaw: 1 }); // the same values, a different object

    expect(cell.current.yaw).toBe(2);
  });

  it("still adopts when the fields genuinely differ", () => {
    const cell = createLiveValue<Camera>(
      { x: 0, yaw: 0 },
      () => {},
      (a, b) => a.x === b.x && a.yaw === b.yaw,
    );

    cell.update((camera) => ({ ...camera, yaw: 1 }));
    cell.receive({ x: 0, yaw: 4 });

    expect(cell.current.yaw).toBe(4);
  });
});
