/**
 * Tetris — seven tetrominoes, soft/hard drop, line clears. Left/right move,
 * up (or A) rotates, down soft-drops, B hard-drops. Attract mode plays a
 * simple greedy placement.
 */

import type { CanvasMiniGame, MiniGameInput, MiniGameSession } from "./types";

const COLS = 10;
const ROWS = 16;

/** The 7 pieces as rotation-origin cell lists. */
const PIECES: Array<{ cells: Array<[number, number]>; color: string }> = [
  { cells: [[-1, 0], [0, 0], [1, 0], [2, 0]], color: "#6fdfa8" }, // I
  { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], color: "#f6b74a" }, // O
  { cells: [[-1, 0], [0, 0], [1, 0], [0, 1]], color: "#8f86c6" }, // T
  { cells: [[-1, 1], [0, 1], [0, 0], [1, 0]], color: "#57d18d" }, // S
  { cells: [[-1, 0], [0, 0], [0, 1], [1, 1]], color: "#ff5d8f" }, // Z
  { cells: [[-1, 0], [-1, 1], [0, 0], [1, 0]], color: "#ffca66" }, // J
  { cells: [[1, 1], [-1, 0], [0, 0], [1, 0]], color: "#ff8fae" }, // L
];

interface Active {
  piece: number;
  rotation: number;
  x: number;
  y: number;
}

function cellsOf(active: Active): Array<[number, number]> {
  return PIECES[active.piece]!.cells.map(([cx, cy]) => {
    let x = cx;
    let y = cy;
    for (let r = 0; r < active.rotation % 4; r += 1) {
      const t = x;
      x = -y;
      y = t;
    }
    return [active.x + x, active.y + y];
  });
}

class TetrisSession implements MiniGameSession {
  private board: (string | null)[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  private active: Active = this.spawn();
  private frame = 0;
  private lines = 0;
  private over = 0;
  private held = { left: 0, right: 0, down: 0, rotate: 0 };
  private attractTarget: number | null = null;

  private spawn(): Active {
    return { piece: Math.floor(Math.random() * PIECES.length), rotation: 0, x: Math.floor(COLS / 2), y: 1 };
  }

  private collides(active: Active): boolean {
    return cellsOf(active).some(
      ([x, y]) => x < 0 || x >= COLS || y >= ROWS || (y >= 0 && this.board[y]![x] !== null),
    );
  }

  private lock(): void {
    for (const [x, y] of cellsOf(this.active)) {
      if (y < 0) {
        this.over = 1;
        return;
      }
      this.board[y]![x] = PIECES[this.active.piece]!.color;
    }
    this.board = this.board.filter((row) => row.some((cell) => cell === null));
    const cleared = ROWS - this.board.length;
    this.lines += cleared;
    while (this.board.length < ROWS) {
      this.board.unshift(Array(COLS).fill(null));
    }
    this.active = this.spawn();
    this.attractTarget = null;
    if (this.collides(this.active)) {
      this.over = 1;
    }
  }

  private tryMove(dx: number, dy: number, dRotation = 0): boolean {
    const moved: Active = {
      ...this.active,
      x: this.active.x + dx,
      y: this.active.y + dy,
      rotation: this.active.rotation + dRotation,
    };
    if (this.collides(moved)) {
      return false;
    }
    this.active = moved;
    return true;
  }

  step(input: MiniGameInput, attract: boolean): void {
    this.frame += 1;
    if (this.over > 0) {
      this.over += 1;
      if (this.over > 120) {
        this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        this.lines = 0;
        this.active = this.spawn();
        this.over = 0;
      }
      return;
    }

    const drive = attract ? this.autopilot() : input;

    // Edge-triggered moves with slow key-repeat, so holds feel deliberate.
    this.held.left = drive.left ? this.held.left + 1 : 0;
    this.held.right = drive.right ? this.held.right + 1 : 0;
    this.held.down = drive.down ? this.held.down + 1 : 0;
    this.held.rotate = drive.up || drive.a ? this.held.rotate + 1 : 0;

    const repeats = (count: number) => count === 1 || (count > 10 && count % 5 === 0);
    if (repeats(this.held.left)) this.tryMove(-1, 0);
    if (repeats(this.held.right)) this.tryMove(1, 0);
    if (this.held.rotate === 1) this.tryMove(0, 0, 1);
    if (drive.b) {
      while (this.tryMove(0, 1)) {
        /* hard drop */
      }
      this.lock();
      return;
    }

    const gravityEvery = this.held.down > 0 ? 3 : 36;
    if (this.frame % gravityEvery === 0 && !this.tryMove(0, 1)) {
      this.lock();
    }
  }

  /** Attract mode: drift toward a column chosen per piece (cheap greedy). */
  private autopilot(): MiniGameInput {
    if (this.attractTarget === null) {
      this.attractTarget = 1 + Math.floor(Math.random() * (COLS - 2));
    }
    return {
      up: false,
      down: true,
      left: this.active.x > this.attractTarget && this.frame % 4 === 0,
      right: this.active.x < this.attractTarget && this.frame % 4 === 0,
      a: this.frame % 60 === 0,
      b: false,
    };
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number): void {
    const cell = Math.min(width / COLS, height / ROWS);
    const offsetX = (width - cell * COLS) / 2;

    context.strokeStyle = "rgba(153,144,187,0.25)";
    context.strokeRect(offsetX, 0, cell * COLS, cell * ROWS);

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const color = this.board[y]![x];
        if (color) {
          context.fillStyle = color;
          context.fillRect(offsetX + x * cell + 1, y * cell + 1, cell - 2, cell - 2);
        }
      }
    }

    if (this.over === 0) {
      context.fillStyle = PIECES[this.active.piece]!.color;
      for (const [x, y] of cellsOf(this.active)) {
        if (y >= 0) {
          context.fillRect(offsetX + x * cell + 1, y * cell + 1, cell - 2, cell - 2);
        }
      }
    }

    context.fillStyle = "#9990bb";
    context.font = "700 10px monospace";
    context.fillText(`TETRIS ${this.lines}`, 8, 14);
    if (this.over > 0) {
      context.fillStyle = "#ff5d8f";
      context.fillText("TOPPED OUT", 8, 28);
    }
  }
}

export const tetrisMiniGame: CanvasMiniGame = {
  kind: "canvas",
  id: "tetris",
  title: "Tetris",
  addedIn: "2026-07",
  create: () => new TetrisSession(),
};
