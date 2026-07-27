/**
 * Rooms-and-corridors dungeon generation.
 *
 * Rooms are placed by rejection sampling — propose a rectangle, keep it if it
 * clears the rooms already placed — and every new room is then joined to the
 * previous one by an L-shaped corridor. Connecting to the *previous* room rather
 * than a random one is what guarantees the result is a single connected level
 * without a graph search: the corridors form a spanning path by construction,
 * which the tests assert by flooding from any floor cell.
 *
 * Pure and DOM-free.
 */

import { createClassField, setClassAt, type ClassField, type ClassInfo } from "./classField";
import { createRandom, randomInt } from "./noise";

/** Dungeon classes: solid wall, room floor, and the corridors between rooms. */
export const DUNGEON_LEGEND: readonly ClassInfo[] = [
  { id: "wall", label: "Wall", color: [38, 36, 48] },
  { id: "room", label: "Room floor", color: [186, 172, 148] },
  { id: "corridor", label: "Corridor", color: [132, 120, 104] },
];

export const DUNGEON_CLASS = { wall: 0, room: 1, corridor: 2 } as const;

export interface DungeonParams {
  readonly seed: number;
  /** How many rooms to *attempt*; overlapping proposals are discarded. */
  readonly roomAttempts: number;
  /** Smallest room edge, in cells (interior, excluding the wall ring). */
  readonly minRoomSize: number;
  /** Largest room edge, in cells. */
  readonly maxRoomSize: number;
}

export const DEFAULT_DUNGEON_PARAMS: DungeonParams = {
  seed: 1,
  roomAttempts: 40,
  minRoomSize: 4,
  maxRoomSize: 10,
};

/** A placed room, as an inclusive cell rectangle. */
export interface DungeonRoom {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The centre cell of a room, where corridors attach. */
export function roomCenter(room: DungeonRoom): [number, number] {
  return [room.x + Math.floor(room.width / 2), room.y + Math.floor(room.height / 2)];
}

/** Whether two rooms overlap, including the one-cell wall each needs around it. */
function roomsCollide(a: DungeonRoom, b: DungeonRoom): boolean {
  return (
    a.x - 1 <= b.x + b.width &&
    a.x + a.width + 1 >= b.x &&
    a.y - 1 <= b.y + b.height &&
    a.y + a.height + 1 >= b.y
  );
}

/** A generated dungeon: the class field plus the rooms that shaped it. */
export interface Dungeon {
  readonly field: ClassField;
  readonly rooms: readonly DungeonRoom[];
}

/**
 * Carve a dungeon. The outermost ring is never carved, so the level is always
 * enclosed by wall regardless of where rooms land.
 */
export function generateDungeon(
  width: number,
  height: number,
  params: DungeonParams = DEFAULT_DUNGEON_PARAMS,
): Dungeon {
  const field = createClassField(width, height, DUNGEON_LEGEND); // all wall
  const random = createRandom(params.seed);
  const rooms: DungeonRoom[] = [];

  // Clamp the requested room sizes to what the map can actually hold, leaving
  // the border ring free — otherwise a large minimum on a small map places
  // nothing at all and the level comes back solid.
  const maxEdge = Math.max(1, Math.min(params.maxRoomSize, width - 4, height - 4));
  const minEdge = Math.max(1, Math.min(params.minRoomSize, maxEdge));

  for (let attempt = 0; attempt < params.roomAttempts; attempt += 1) {
    const roomWidth = randomInt(random, minEdge, maxEdge);
    const roomHeight = randomInt(random, minEdge, maxEdge);
    const x = randomInt(random, 1, Math.max(1, width - roomWidth - 2));
    const y = randomInt(random, 1, Math.max(1, height - roomHeight - 2));
    const room: DungeonRoom = { x, y, width: roomWidth, height: roomHeight };
    if (x + roomWidth >= width - 1 || y + roomHeight >= height - 1) continue;
    if (rooms.some((placed) => roomsCollide(room, placed))) continue;

    carveRoom(field, room);
    // Join to the room placed before it, so the level is connected by construction.
    const previous = rooms[rooms.length - 1];
    if (previous) carveCorridor(field, roomCenter(previous), roomCenter(room), random);
    rooms.push(room);
  }

  return { field, rooms };
}

/** Fill a room's rectangle with floor. */
function carveRoom(field: ClassField, room: DungeonRoom): void {
  for (let y = room.y; y < room.y + room.height; y += 1) {
    for (let x = room.x; x < room.x + room.width; x += 1) {
      setClassAt(field, x, y, DUNGEON_CLASS.room);
    }
  }
}

/**
 * Carve an L-shaped corridor between two centres, with the horizontal and
 * vertical legs in a random order so corners don't all bend the same way. Cells
 * already carved as room stay room — the corridor only claims wall.
 */
function carveCorridor(
  field: ClassField,
  [fromX, fromY]: [number, number],
  [toX, toY]: [number, number],
  random: () => number,
): void {
  const horizontalFirst = random() < 0.5;
  const cornerY = horizontalFirst ? fromY : toY;
  const cornerX = horizontalFirst ? toX : fromX;
  carveHorizontal(field, fromX, toX, cornerY);
  carveVertical(field, fromY, toY, cornerX);
}

function carveHorizontal(field: ClassField, fromX: number, toX: number, y: number): void {
  const step = fromX <= toX ? 1 : -1;
  for (let x = fromX; x !== toX + step; x += step) carveCorridorCell(field, x, y);
}

function carveVertical(field: ClassField, fromY: number, toY: number, x: number): void {
  const step = fromY <= toY ? 1 : -1;
  for (let y = fromY; y !== toY + step; y += step) carveCorridorCell(field, x, y);
}

/** Claim one cell for a corridor, unless it is already a room floor. */
function carveCorridorCell(field: ClassField, x: number, y: number): void {
  // Never breach the border ring, so the level stays enclosed.
  if (x < 1 || y < 1 || x >= field.width - 1 || y >= field.height - 1) return;
  if (field.classes[y * field.width + x] === DUNGEON_CLASS.room) return;
  setClassAt(field, x, y, DUNGEON_CLASS.corridor);
}

/** Whether a dungeon class is walkable — everything that is not wall. */
export function isWalkable(value: number): boolean {
  return value !== DUNGEON_CLASS.wall;
}
