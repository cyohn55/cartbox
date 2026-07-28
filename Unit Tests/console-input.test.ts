/**
 * Unit tests for the handheld input bus: shell buttons → UI listeners, and
 * (while a game runs) → synthetic key events matching the engine's default
 * keyboard bindings.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_BINDINGS, ConsoleButton } from "@cartbox/player";

import {
  CONTROL_KEY_CODES,
  ConsoleInputBus,
  type ConsoleControl,
  type ConsoleInputEvent,
} from "../apps/web/src/app/console/consoleInput";

/** Test double capturing what would become window KeyboardEvents. */
function recordingDispatcher() {
  const dispatched: Array<{ type: string; code: string }> = [];
  return {
    dispatched,
    dispatch: (type: "keydown" | "keyup", code: string) => dispatched.push({ type, code }),
  };
}

describe("control → key-code mapping", () => {
  it("maps every gamepad control to a code the engine's default bindings understand", () => {
    const gamepadControls: ConsoleControl[] = ["up", "down", "left", "right", "a", "b", "x", "y"];
    for (const control of gamepadControls) {
      const code = CONTROL_KEY_CODES[control];
      expect(code, `control "${control}" must map to a key code`).toBeTruthy();
      expect(
        DEFAULT_KEY_BINDINGS[code!],
        `code "${code}" must be bound in the player's defaults`,
      ).toBeDefined();
    }
  });

  it("maps the four face buttons to the matching console buttons", () => {
    expect(DEFAULT_KEY_BINDINGS[CONTROL_KEY_CODES.a!]).toBe(ConsoleButton.A);
    expect(DEFAULT_KEY_BINDINGS[CONTROL_KEY_CODES.b!]).toBe(ConsoleButton.B);
    expect(DEFAULT_KEY_BINDINGS[CONTROL_KEY_CODES.x!]).toBe(ConsoleButton.X);
    expect(DEFAULT_KEY_BINDINGS[CONTROL_KEY_CODES.y!]).toBe(ConsoleButton.Y);
  });

  it("gives system controls (Start/Select/shoulders) no gamepad mapping", () => {
    for (const control of ["start", "select", "l1", "l2", "r1", "r2"] as const) {
      expect(CONTROL_KEY_CODES[control], control).toBeNull();
    }
  });
});

describe("ConsoleInputBus", () => {
  it("notifies subscribers of presses and releases", () => {
    const { dispatch } = recordingDispatcher();
    const bus = new ConsoleInputBus(dispatch);
    const events: ConsoleInputEvent[] = [];
    bus.subscribe((event) => events.push(event));

    bus.press("a");
    bus.release("a");

    expect(events).toEqual([
      { control: "a", phase: "press" },
      { control: "a", phase: "release" },
    ]);
  });

  it("stops notifying after unsubscribe", () => {
    const { dispatch } = recordingDispatcher();
    const bus = new ConsoleInputBus(dispatch);
    const events: ConsoleInputEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));

    bus.press("up");
    unsubscribe();
    bus.press("down");

    expect(events).toHaveLength(1);
  });

  it("forwards no key events while no game is running", () => {
    const { dispatch, dispatched } = recordingDispatcher();
    const bus = new ConsoleInputBus(dispatch);

    bus.press("a");
    bus.release("a");

    expect(dispatched).toHaveLength(0);
  });

  it("forwards gamepad controls as key events while a game is running", () => {
    const { dispatch, dispatched } = recordingDispatcher();
    const bus = new ConsoleInputBus(dispatch);
    bus.setGameForwarding(true);

    bus.press("right");
    bus.release("right");
    bus.press("a");

    expect(dispatched).toEqual([
      { type: "keydown", code: "ArrowRight" },
      { type: "keyup", code: "ArrowRight" },
      { type: "keydown", code: "KeyZ" },
    ]);
  });

  it("never forwards Start/Select to the game, but UI listeners still hear them", () => {
    const { dispatch, dispatched } = recordingDispatcher();
    const bus = new ConsoleInputBus(dispatch);
    const events: ConsoleInputEvent[] = [];
    bus.subscribe((event) => events.push(event));
    bus.setGameForwarding(true);

    bus.press("select");
    bus.press("start");

    expect(dispatched).toHaveLength(0);
    expect(events.map((event) => event.control)).toEqual(["select", "start"]);
  });

  it("stops forwarding after the game ends", () => {
    const { dispatch, dispatched } = recordingDispatcher();
    const bus = new ConsoleInputBus(dispatch);
    bus.setGameForwarding(true);
    bus.press("a");
    bus.setGameForwarding(false);
    bus.press("b");

    expect(dispatched).toEqual([{ type: "keydown", code: "KeyZ" }]);
  });
});
