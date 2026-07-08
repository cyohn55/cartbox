/**
 * Snake — grid classic. The movement/collision core is a pure function
 * (stepSnake) so the rules are unit-testable without a canvas.
 */

import type { CanvasMiniGame, MiniGameInput, MiniGameSession } from "./types";

export interface SnakeState {
  cols: number;
  rows: number;
  /** Head first. */
  body: Array<{ x: number; y: number }>;
  direction: { x: number; y: number };
  food: { x: number; y: number };
  score: number;
  dead: boolean;
}

export function createSnakeState(cols: number, rows: number): SnakeState {
  const startX = Math.floor(cols / 2);
  const startY = Math.floor(rows / 2);
  return {
    cols,
    rows,
    body: [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ],
    direction: { x: 1, y: 0 },
    food: { x: Math.floor(cols / 4), y: Math.floor(rows / 4) },
    score: 0,
    dead: false,
  };
}

/**
 * Advances one cell. Walls and self-collision kill; food grows the snake and
 * respawns via the injected RNG (deterministic in tests).
 */
export function stepSnake(state: SnakeState, random: () => number = Math.random): SnakeState {
  if (state.dead) {
    return state;
  }
  const head = state.body[0]!;
  const next = { x: head.x + state.direction.x, y: head.y + state.direction.y };

  const hitWall = next.x < 0 || next.y < 0 || next.x >= state.cols || next.y >= state.rows;
  const hitSelf = state.body.some((cell) => cell.x === next.x && cell.y === next.y);
  if (hitWall || hitSelf) {
    return { ...state, dead: true };
  }

  const ate = next.x === state.food.x && next.y === state.food.y;
  const body = [next, ...(ate ? state.body : state.body.slice(0, -1))];
  const food = ate
    ? { x: Math.floor(random() * state.cols), y: Math.floor(random() * state.rows) }
    : state.food;
  return { ...state, body, food, score: state.score + (ate ? 1 : 0) };
}

/** Turns, refusing the 180° reversal that would eat your own neck. */
export function turnSnake(state: SnakeState, dx: number, dy: number): SnakeState {
  if (dx === -state.direction.x && dy === -state.direction.y) {
    return state;
  }
  return { ...state, direction: { x: dx, y: dy } };
}

const CELL = 12;
const TICK_FRAMES = 8; // grid steps every 8 frames ≈ 7.5 moves/sec

class SnakeSession implements MiniGameSession {
  private state: SnakeState;
  private frame = 0;
  private deadFrames = 0;

  constructor(width: number, height: number) {
    this.state = createSnakeState(Math.max(8, Math.floor(width / CELL)), Math.max(6, Math.floor(height / CELL)));
  }

  step(input: MiniGameInput, attract: boolean): void {
    this.frame += 1;

    if (this.state.dead) {
      this.deadFrames += 1;
      if (this.deadFrames > 90) {
        this.state = createSnakeState(this.state.cols, this.state.rows);
        this.deadFrames = 0;
      }
      return;
    }

    if (attract) {
      this.autopilot();
    } else if (input.up) {
      this.state = turnSnake(this.state, 0, -1);
    } else if (input.down) {
      this.state = turnSnake(this.state, 0, 1);
    } else if (input.left) {
      this.state = turnSnake(this.state, -1, 0);
    } else if (input.right) {
      this.state = turnSnake(this.state, 1, 0);
    }

    if (this.frame % TICK_FRAMES === 0) {
      this.state = stepSnake(this.state);
    }
  }

  /** Attract mode: greedy chase of the food, dodging walls. */
  private autopilot(): void {
    const head = this.state.body[0]!;
    const { food } = this.state;
    const wants: Array<[number, number]> = [];
    if (food.x > head.x) wants.push([1, 0]);
    if (food.x < head.x) wants.push([-1, 0]);
    if (food.y > head.y) wants.push([0, 1]);
    if (food.y < head.y) wants.push([0, -1]);
    wants.push([this.state.direction.x, this.state.direction.y]);
    for (const [dx, dy] of wants) {
      const nx = head.x + dx;
      const ny = head.y + dy;
      const blocked =
        nx < 0 ||
        ny < 0 ||
        nx >= this.state.cols ||
        ny >= this.state.rows ||
        this.state.body.some((cell) => cell.x === nx && cell.y === ny);
      if (!blocked) {
        this.state = turnSnake(this.state, dx, dy);
        return;
      }
    }
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number): void {
    const cellW = width / this.state.cols;
    const cellH = height / this.state.rows;

    context.fillStyle = "#57d18d";
    for (const [index, cell] of this.state.body.entries()) {
      context.globalAlpha = index === 0 ? 1 : 0.75;
      context.fillRect(cell.x * cellW + 1, cell.y * cellH + 1, cellW - 2, cellH - 2);
    }
    context.globalAlpha = 1;
    context.fillStyle = "#f6b74a";
    context.fillRect(this.state.food.x * cellW + 2, this.state.food.y * cellH + 2, cellW - 4, cellH - 4);

    context.fillStyle = "#9990bb";
    context.font = "700 10px monospace";
    context.fillText(`SNAKE ${this.state.score}`, 8, 14);
    if (this.state.dead) {
      context.fillStyle = "#ff5d8f";
      context.fillText("CRASHED", 8, 28);
    }
  }
}

export const snakeMiniGame: CanvasMiniGame = {
  kind: "canvas",
  id: "snake",
  title: "Snake",
  addedIn: "2026-07",
  create: (width, height) => new SnakeSession(width, height),
};
