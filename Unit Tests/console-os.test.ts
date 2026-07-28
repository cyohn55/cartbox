/**
 * Unit tests for the handheld console's OS state machine — the boot flow
 * (boot → title → auth → shell) and in-shell routing (tabs, game sessions).
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  CONSOLE_TABS,
  INITIAL_CONSOLE_STATE,
  consoleOsReducer,
  type ConsoleOsEvent,
  type ConsoleOsState,
  type PlayingCart,
} from "../apps/web/src/app/console/consoleOs";

const SAMPLE_CART: PlayingCart = {
  cartId: "cart-1",
  title: "Sample",
  cartUrl: "https://cdn.example/carts/cart-1.tic",
  engineUrl: "/engine/tic80.js",
  modelId: "classic",
};

function run(events: ConsoleOsEvent[], from: ConsoleOsState = INITIAL_CONSOLE_STATE): ConsoleOsState {
  return events.reduce(consoleOsReducer, from);
}

describe("boot flow", () => {
  it("starts on the boot loader", () => {
    expect(INITIAL_CONSOLE_STATE.stage).toBe("boot");
  });

  it("walks boot → title → auth → shell for a signed-out player", () => {
    const state = run([
      { type: "BOOT_COMPLETE" },
      { type: "TITLE_CONTINUE", signedIn: false },
      { type: "AUTH_SUCCESS" },
    ]);
    expect(state.stage).toBe("shell");
    expect(state.guest).toBe(false);
    expect(state.tab).toBe("feed");
  });

  it("skips the auth screen when a session already exists", () => {
    const state = run([{ type: "BOOT_COMPLETE" }, { type: "TITLE_CONTINUE", signedIn: true }]);
    expect(state.stage).toBe("shell");
  });

  it("marks guest sessions so Library/Profile can prompt for sign-in", () => {
    const state = run([
      { type: "BOOT_COMPLETE" },
      { type: "TITLE_CONTINUE", signedIn: false },
      { type: "AUTH_GUEST" },
    ]);
    expect(state.stage).toBe("shell");
    expect(state.guest).toBe(true);
  });

  it("ignores out-of-stage events (no skipping the title screen)", () => {
    const state = run([{ type: "TITLE_CONTINUE", signedIn: true }]);
    expect(state.stage).toBe("boot");
  });
});

describe("homescreen tabs", () => {
  const atShell = run([{ type: "BOOT_COMPLETE" }, { type: "TITLE_CONTINUE", signedIn: true }]);

  it("selects a tab directly", () => {
    const state = run([{ type: "SET_TAB", tab: "library" }], atShell);
    expect(state.tab).toBe("library");
  });

  it("cycles forward through every tab and wraps around", () => {
    let state = atShell;
    for (const expected of [...CONSOLE_TABS.slice(1), CONSOLE_TABS[0]]) {
      state = consoleOsReducer(state, { type: "NEXT_TAB" });
      expect(state.tab).toBe(expected);
    }
  });

  it("cycles backward with wrap-around", () => {
    const state = run([{ type: "PREVIOUS_TAB" }], atShell);
    expect(state.tab).toBe(CONSOLE_TABS[CONSOLE_TABS.length - 1]);
  });

  it("does not change tabs while a game is running", () => {
    const playing = run([{ type: "PLAY_CART", cart: SAMPLE_CART }], atShell);
    const state = run([{ type: "SET_TAB", tab: "profile" }, { type: "NEXT_TAB" }], playing);
    expect(state.tab).toBe("feed");
  });
});

describe("game sessions", () => {
  const atShell = run([{ type: "BOOT_COMPLETE" }, { type: "TITLE_CONTINUE", signedIn: true }]);

  it("launches a cart with its full playable payload", () => {
    const state = run([{ type: "PLAY_CART", cart: SAMPLE_CART }], atShell);
    expect(state.playing).toEqual(SAMPLE_CART);
  });

  it("does not launch a cart outside the shell", () => {
    const state = run([{ type: "PLAY_CART", cart: SAMPLE_CART }]);
    expect(state.playing).toBeNull();
  });

  it("exits back to the same tab", () => {
    const state = run(
      [{ type: "SET_TAB", tab: "browse" }, { type: "PLAY_CART", cart: SAMPLE_CART }, { type: "EXIT_GAME" }],
      atShell,
    );
    expect(state.playing).toBeNull();
    expect(state.tab).toBe("browse");
  });

  it("sign-out tears down a running game and returns to auth", () => {
    const state = run([{ type: "PLAY_CART", cart: SAMPLE_CART }, { type: "SIGN_OUT" }], atShell);
    expect(state.stage).toBe("auth");
    expect(state.playing).toBeNull();
    expect(state.guest).toBe(false);
  });
});
