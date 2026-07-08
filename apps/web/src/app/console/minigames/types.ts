/**
 * Mini-games that live behind the handheld's controls (the arcade theme's
 * background, taken over via the Konami code).
 *
 * Two flavours:
 *  - "canvas": a small self-contained game stepped at ~60Hz and drawn onto a
 *    2D canvas. When nobody holds the controls it runs in attract mode and
 *    plays itself.
 *  - "cart": a real Cartbox cartridge mounted through @cartbox/player.
 *
 * The registry gains a new entry each month — `addedIn` records the month a
 * game joined so the monthly rotation stays stable as the list grows.
 */

export interface MiniGameInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  a: boolean;
  b: boolean;
}

export const IDLE_INPUT: MiniGameInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

/** A running canvas game: step once per frame, then draw. */
export interface MiniGameSession {
  /** Advances one tick. In attract mode the game supplies its own input. */
  step(input: MiniGameInput, attract: boolean): void;
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
}

interface MiniGameBase {
  id: string;
  title: string;
  /** "YYYY-MM" the game joined the registry (drives the monthly rotation). */
  addedIn: string;
}

export interface CanvasMiniGame extends MiniGameBase {
  kind: "canvas";
  create(width: number, height: number): MiniGameSession;
}

export interface CartMiniGame extends MiniGameBase {
  kind: "cart";
  /** Cart id in the catalog (also baked into the static demo catalog). */
  cartId: string;
}

export type MiniGame = CanvasMiniGame | CartMiniGame;
