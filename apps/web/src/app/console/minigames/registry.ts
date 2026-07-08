/**
 * The mini-game registry. One entry per game; new games are appended monthly
 * (set `addedIn` to the month they ship). The default selection rotates by
 * calendar month over every registered game, so a growing registry
 * automatically folds new arrivals into the rotation.
 */

import type { MiniGame } from "./types";
import { snakeMiniGame } from "./snake";
import { asteroidsMiniGame } from "./asteroids";
import { bulletHellMiniGame } from "./bulletHell";
import { tetrisMiniGame } from "./tetris";

/** The Gotta Catch 'Em All Classic cart (seeded + baked into the demo build). */
const GOTTA_CATCH_CART_ID = "00000000-0000-4000-8000-000000000011";

export const MINI_GAMES: readonly MiniGame[] = [
  asteroidsMiniGame,
  snakeMiniGame,
  bulletHellMiniGame,
  tetrisMiniGame,
  {
    kind: "cart",
    id: "gotta-catch",
    title: "Gotta Catch 'Em All",
    addedIn: "2026-07",
    cartId: GOTTA_CATCH_CART_ID,
  },
];

/**
 * The month's featured mini-game: a stable rotation keyed to the calendar
 * month, deterministic for any registry size (each new monthly addition
 * simply extends the cycle).
 */
export function miniGameForMonth(date: Date, games: readonly MiniGame[] = MINI_GAMES): MiniGame {
  if (games.length === 0) {
    throw new Error("mini-game registry is empty");
  }
  const monthIndex = date.getFullYear() * 12 + date.getMonth();
  return games[monthIndex % games.length]!;
}

/** Resolves a settings choice ("monthly" or a registry id) to a game. */
export function resolveMiniGame(
  choice: string,
  date: Date,
  games: readonly MiniGame[] = MINI_GAMES,
): MiniGame {
  if (choice !== "monthly") {
    const picked = games.find((game) => game.id === choice);
    if (picked) {
      return picked;
    }
  }
  return miniGameForMonth(date, games);
}
