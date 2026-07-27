/**
 * Maze generation by randomized depth-first search ("recursive backtracker"),
 * carved on the odd cells of the grid so every corridor keeps a wall between it
 * and its neighbours.
 *
 * A perfect maze — exactly one route between any two cells — is the natural
 * output, and an optional *braid* pass then removes a share of the dead ends to
 * add loops, which plays better than a perfect maze in most games. Both
 * properties are structural, so the tests assert them (connectivity, and dead-end
 * count falling as braid rises) rather than comparing against a fixed layout.
 *
 * Pure and DOM-free.
 */

import { createClassField, setClassAt, type ClassField, type ClassInfo } from "./classField";
import { createRandom, type RandomSource } from "./noise";

/** Maze classes, deliberately sharing the cave legend's two-class shape. */
export const MAZE_LEGEND: readonly ClassInfo[] = [
  { id: "wall", label: "Wall", color: [44, 42, 58] },
  { id: "path", label: "Path", color: [198, 190, 168] },
];

export const MAZE_CLASS = { wall: 0, path: 1 } as const;

export interface MazeParams {
  readonly seed: number;
  /**
   * Share of dead ends to open into loops, 0..1. At 0 the maze is perfect (one
   * route between any two cells); at 1 nearly every dead end becomes a junction.
   */
  readonly braid: number;
}

export const DEFAULT_MAZE_PARAMS: MazeParams = { seed: 1, braid: 0.25 };

/** The four cardinal steps, in the two-cell stride the carver walks. */
const STRIDES: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
];

/** Shuffle in place with a seeded source (Fisher-Yates), so runs are reproducible. */
function shuffle<T>(items: T[], random: RandomSource): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
  return items;
}

/**
 * Carve a maze into a `width` x `height` field. Corridors occupy odd
 * coordinates; even coordinates are the walls between them, which is why a maze
 * on an even-sized grid simply leaves its last row and column solid.
 */
export function generateMaze(width: number, height: number, params: MazeParams = DEFAULT_MAZE_PARAMS): ClassField {
  const field = createClassField(width, height, MAZE_LEGEND); // all wall
  const random = createRandom(params.seed);

  // With no room for a single corridor cell there is nothing to carve.
  if (width < 3 || height < 3) return field;

  const isPath = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && field.classes[y * width + x] === MAZE_CLASS.path;

  // Iterative DFS: an explicit stack rather than recursion, so a large maze
  // cannot overflow the call stack.
  const stack: Array<[number, number]> = [[1, 1]];
  setClassAt(field, 1, 1, MAZE_CLASS.path);
  while (stack.length > 0) {
    const [x, y] = stack[stack.length - 1]!;
    const options = shuffle([...STRIDES], random).filter(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx > 0 && ny > 0 && nx < width - 1 && ny < height - 1 && !isPath(nx, ny);
    });
    const step = options[0];
    if (!step) {
      stack.pop();
      continue;
    }
    const [dx, dy] = step;
    // Carve the wall between the two cells as well as the cell itself.
    setClassAt(field, x + dx / 2, y + dy / 2, MAZE_CLASS.path);
    setClassAt(field, x + dx, y + dy, MAZE_CLASS.path);
    stack.push([x + dx, y + dy]);
  }

  if (params.braid > 0) braidDeadEnds(field, params.braid, random);
  return field;
}

/** The path neighbours of a cell, as cardinal offsets. */
function pathNeighbors(field: ClassField, x: number, y: number): Array<readonly [number, number]> {
  const steps: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  return steps.filter(([dx, dy]) => {
    const nx = x + dx;
    const ny = y + dy;
    return (
      nx >= 0 && ny >= 0 && nx < field.width && ny < field.height && field.classes[ny * field.width + nx] === MAZE_CLASS.path
    );
  });
}

/**
 * Open a share of the dead ends into loops by knocking through one of the walls
 * around each chosen dead end. Only interior walls are candidates, so braiding
 * can never breach the maze's border.
 */
function braidDeadEnds(field: ClassField, braid: number, random: RandomSource): void {
  const deadEnds: Array<[number, number]> = [];
  for (let y = 1; y < field.height - 1; y += 1) {
    for (let x = 1; x < field.width - 1; x += 1) {
      if (field.classes[y * field.width + x] !== MAZE_CLASS.path) continue;
      if (pathNeighbors(field, x, y).length === 1) deadEnds.push([x, y]);
    }
  }

  for (const [x, y] of deadEnds) {
    if (random() >= braid) continue;
    // Any interior wall neighbour whose far side is also inside the maze: opening
    // it joins two corridors instead of carving a stub into the border.
    const candidates = shuffle(
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as Array<[number, number]>,
      random,
    ).filter(([dx, dy]) => {
      const wx = x + dx;
      const wy = y + dy;
      const fx = x + dx * 2;
      const fy = y + dy * 2;
      if (wx < 1 || wy < 1 || wx >= field.width - 1 || wy >= field.height - 1) return false;
      if (fx < 1 || fy < 1 || fx >= field.width - 1 || fy >= field.height - 1) return false;
      return (
        field.classes[wy * field.width + wx] === MAZE_CLASS.wall &&
        field.classes[fy * field.width + fx] === MAZE_CLASS.path
      );
    });
    const opening = candidates[0];
    if (opening) setClassAt(field, x + opening[0], y + opening[1], MAZE_CLASS.path);
  }
}
