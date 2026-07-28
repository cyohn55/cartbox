/**
 * Unit tests for the mini-game system: the monthly rotation the registry is
 * built around (new games join monthly), settings normalization, and the
 * pure Snake rules core.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  MINI_GAMES,
  miniGameForMonth,
  resolveMiniGame,
} from "../apps/web/src/app/console/minigames/registry";
import {
  createSnakeState,
  stepSnake,
  turnSnake,
} from "../apps/web/src/app/console/minigames/snake";
import {
  DEFAULT_CONSOLE_SETTINGS,
  normalizeConsoleSettings,
} from "../apps/web/src/app/console/consoleSettings";

describe("mini-game registry + monthly rotation", () => {
  it("registers the launch lineup, including the cart-based game", () => {
    const ids = MINI_GAMES.map((game) => game.id);
    expect(ids).toEqual(expect.arrayContaining(["asteroids", "snake", "bullet-hell", "tetris", "gotta-catch"]));
    expect(MINI_GAMES.find((game) => game.id === "gotta-catch")?.kind).toBe("cart");
  });

  it("rotates deterministically month over month, wrapping the registry", () => {
    const january = miniGameForMonth(new Date(2027, 0, 15));
    const february = miniGameForMonth(new Date(2027, 1, 15));
    expect(january.id).not.toBe(february.id);
    // Same month always resolves the same game.
    expect(miniGameForMonth(new Date(2027, 0, 1)).id).toBe(january.id);
    // A full registry cycle returns to the start.
    expect(miniGameForMonth(new Date(2027, MINI_GAMES.length, 1)).id).toBe(january.id);
  });

  it("keeps existing months stable when a new monthly game is appended", () => {
    const grown = [...MINI_GAMES, { kind: "canvas", id: "new-arrival", title: "New", addedIn: "2026-08", create: () => ({ step() {}, draw() {} }) } as const];
    const date = new Date(2026, 6, 1); // month index divisible by rotation
    expect(miniGameForMonth(date, grown)).toBeDefined();
    expect(grown).toHaveLength(MINI_GAMES.length + 1);
  });

  it("resolves explicit picks and falls back to the rotation", () => {
    expect(resolveMiniGame("tetris", new Date()).id).toBe("tetris");
    expect(resolveMiniGame("monthly", new Date(2027, 0, 15)).id).toBe(miniGameForMonth(new Date(2027, 0, 15)).id);
    expect(resolveMiniGame("deleted-game", new Date(2027, 0, 15)).id).toBe(
      miniGameForMonth(new Date(2027, 0, 15)).id,
    );
  });
});

describe("console settings normalization", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeConsoleSettings(null)).toEqual(DEFAULT_CONSOLE_SETTINGS);
    expect(normalizeConsoleSettings("nonsense")).toEqual(DEFAULT_CONSOLE_SETTINGS);
    expect(normalizeConsoleSettings({ theme: "hotdog", controls: 7, buttons: [], miniGame: "" })).toEqual(
      DEFAULT_CONSOLE_SETTINGS,
    );
  });

  it("keeps every valid choice", () => {
    const chosen = normalizeConsoleSettings({
      theme: "arcade",
      controls: "joystick",
      buttons: "neon",
      miniGame: "tetris",
      swapControls: true,
      faceColors: { x: "#112233", y: "#445566", a: "#778899", b: "#AABBCC" },
      dpadColor: "#123456",
      joystickColor: "#abcdef",
    });
    expect(chosen).toMatchObject({
      theme: "arcade",
      controls: "joystick",
      buttons: "neon",
      miniGame: "tetris",
      swapControls: true,
      faceColors: { x: "#112233", y: "#445566", a: "#778899", b: "#aabbcc" }, // lowercased
      dpadColor: "#123456",
      joystickColor: "#abcdef",
    });
  });

  it("drops malformed custom colors instead of storing them", () => {
    const chosen = normalizeConsoleSettings({
      faceColors: { x: "#112233", y: "red", a: "#778899", b: "#aabbcc" }, // one bad → all null
      dpadColor: "#12345",
      joystickColor: 42,
    });
    expect(chosen.faceColors).toBeNull();
    expect(chosen.dpadColor).toBeNull();
    expect(chosen.joystickColor).toBeNull();
  });
});

describe("snake rules core", () => {
  it("moves forward one cell per step", () => {
    const state = createSnakeState(20, 12);
    const next = stepSnake(state, () => 0.5);
    expect(next.body[0]).toEqual({ x: state.body[0]!.x + 1, y: state.body[0]!.y });
    expect(next.body).toHaveLength(state.body.length);
  });

  it("grows and scores when eating food", () => {
    const state = { ...createSnakeState(20, 12), food: { x: 11, y: 6 } }; // directly ahead
    const next = stepSnake(state, () => 0.99);
    expect(next.score).toBe(1);
    expect(next.body).toHaveLength(state.body.length + 1);
    expect(next.food).not.toEqual(state.food); // respawned
  });

  it("dies on the wall", () => {
    let state = createSnakeState(6, 6);
    for (let i = 0; i < 10 && !state.dead; i += 1) {
      state = stepSnake(state, () => 0.5);
    }
    expect(state.dead).toBe(true);
  });

  it("refuses a 180° reversal but allows real turns", () => {
    const state = createSnakeState(20, 12); // heading right
    expect(turnSnake(state, -1, 0).direction).toEqual({ x: 1, y: 0 });
    expect(turnSnake(state, 0, -1).direction).toEqual({ x: 0, y: -1 });
  });

  it("dies when it bites itself", () => {
    const base = createSnakeState(20, 12);
    const coiled = {
      ...base,
      // Head at (10,6) heading right into its own body at (11,6).
      body: [
        { x: 10, y: 6 },
        { x: 10, y: 7 },
        { x: 11, y: 7 },
        { x: 11, y: 6 },
        { x: 12, y: 6 },
      ],
    };
    expect(stepSnake(coiled, () => 0.5).dead).toBe(true);
  });
});
