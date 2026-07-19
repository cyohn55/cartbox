/**
 * Console OS state machine — the boot flow and screen routing that runs inside
 * the handheld's display:
 *
 *   boot loader → title screen → login/signup/guest → homescreen tabs
 *
 * Pure reducer (no React/DOM) so every transition is unit-testable. The React
 * layer feeds it events from timers (boot finishing), shell buttons (Start),
 * auth results, and tab taps.
 */

/** Which full-screen experience the display is showing. */
export type ConsoleStage = "boot" | "title" | "auth" | "shell";

/** Homescreen tabs, in tab-bar order. */
export const CONSOLE_TABS = ["feed", "browse", "create", "library", "profile"] as const;
export type ConsoleTab = (typeof CONSOLE_TABS)[number];

/** Everything the full-screen player needs to boot a cartridge. */
/**
 * Something occupying the whole screen. Either a Cartbox cartridge (a .tic run
 * by the player package) or a ported catalog title (a WebAssembly game run by
 * the Cartbox Game ABI runtime). `game` is what distinguishes them: when it is
 * present the cart fields are unused, so both kinds can flow through one
 * reducer, one launch animation, and one eject path.
 */
export interface PlayingCart {
  cartId: string;
  title: string;
  cartUrl: string;
  engineUrl: string;
  modelId: string;
  /** Present only for ported `wasm-app` titles. */
  game?: PlayingGame;
}

export interface PlayingGame {
  /**
   * Which player drives this title. `wasm-app` games run on the Cartbox Game
   * ABI (a framebuffer this host ticks); `scummvm` and `supertux` games run
   * inside their own Emscripten builds, which own their canvas and loop.
   */
  runtime?: "wasm-app" | "scummvm" | "supertux";
  /** Directory under public/games holding game.js + game.wasm (wasm-app). */
  bundleName: string;
  width: number;
  height: number;
  /** ScummVM launch target (its game id, e.g. "sky"), for the scummvm runtime. */
  target?: string;
}

export interface ConsoleOsState {
  stage: ConsoleStage;
  tab: ConsoleTab;
  /** Cart occupying the whole screen, or null when browsing the OS. */
  playing: PlayingCart | null;
  /** True once the user chose "continue as guest" (Library/Profile prompt). */
  guest: boolean;
}

export type ConsoleOsEvent =
  | { type: "BOOT_COMPLETE" }
  | { type: "TITLE_CONTINUE"; signedIn: boolean }
  | { type: "AUTH_SUCCESS" }
  | { type: "AUTH_GUEST" }
  | { type: "SET_TAB"; tab: ConsoleTab }
  | { type: "NEXT_TAB" }
  | { type: "PREVIOUS_TAB" }
  | { type: "PLAY_CART"; cart: PlayingCart }
  | { type: "EXIT_GAME" }
  | { type: "SIGN_OUT" };

export const INITIAL_CONSOLE_STATE: ConsoleOsState = {
  stage: "boot",
  tab: "feed",
  playing: null,
  guest: false,
};

function shiftTab(current: ConsoleTab, offset: number): ConsoleTab {
  const index = CONSOLE_TABS.indexOf(current);
  const next = CONSOLE_TABS[(index + offset + CONSOLE_TABS.length) % CONSOLE_TABS.length];
  return next ?? current;
}

export function consoleOsReducer(state: ConsoleOsState, event: ConsoleOsEvent): ConsoleOsState {
  switch (event.type) {
    case "BOOT_COMPLETE":
      return state.stage === "boot" ? { ...state, stage: "title" } : state;

    case "TITLE_CONTINUE":
      if (state.stage !== "title") {
        return state;
      }
      // A live session skips the sign-in screen entirely, console-style.
      return { ...state, stage: event.signedIn ? "shell" : "auth", guest: false };

    case "AUTH_SUCCESS":
      return state.stage === "auth" ? { ...state, stage: "shell", guest: false } : state;

    case "AUTH_GUEST":
      return state.stage === "auth" ? { ...state, stage: "shell", guest: true } : state;

    case "SET_TAB":
      return state.stage === "shell" && state.playing === null ? { ...state, tab: event.tab } : state;

    case "NEXT_TAB":
      return state.stage === "shell" && state.playing === null
        ? { ...state, tab: shiftTab(state.tab, 1) }
        : state;

    case "PREVIOUS_TAB":
      return state.stage === "shell" && state.playing === null
        ? { ...state, tab: shiftTab(state.tab, -1) }
        : state;

    case "PLAY_CART":
      return state.stage === "shell" ? { ...state, playing: event.cart } : state;

    case "EXIT_GAME":
      return { ...state, playing: null };

    case "SIGN_OUT":
      // Back to the sign-in screen; a game in progress is torn down with it.
      return { ...state, stage: "auth", playing: null, guest: false };

    default:
      return state;
  }
}
