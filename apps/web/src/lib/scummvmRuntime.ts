/**
 * The `scummvm` runtime: host side for ScummVM's own Emscripten build.
 *
 * Unlike the `wasm-app` runtime (a framebuffer plus seven ABI functions this
 * host drives a frame at a time), ScummVM is a whole SDL application. It owns
 * its canvas, its main loop, its audio and its save system; the host's job is
 * narrower and different:
 *
 *   1. hand ScummVM a launch target and writable paths (`buildScummvmArgs`),
 *   2. turn the handheld's fixed buttons into the pointer a point-and-click
 *      adventure expects — the d-pad drives a `VirtualCursor`, the face buttons
 *      are mouse clicks (`controlAction`), delivered through an `InputSink` so
 *      the translation is testable without a DOM,
 *   3. carry ScummVM's save files between its in-memory filesystem and the
 *      browser's durable storage (`packSaves` / `unpackSaves`).
 *
 * Everything here except `ScummVmSession.start` is pure and DOM-free, so the
 * parts that decide *what* input ScummVM receives and *how* a save round-trips
 * are exercised directly in tests rather than through a running engine.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/** A directional hold. The d-pad can report several at once (diagonals). */
export type Direction = "up" | "down" | "left" | "right";

/** Mouse buttons ScummVM understands, in the DOM `MouseEvent.button` numbering. */
export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;

/**
 * What a handheld control does inside ScummVM.
 *
 * Point-and-click adventures are mouse-driven with a two-verb model (walk/use on
 * left, look/examine on right), so the face buttons map to the two mouse buttons
 * and the system buttons reach ScummVM's own UI. The d-pad is deliberately absent
 * here: it does not map to a discrete action but integrates a cursor over time,
 * which `VirtualCursor` owns.
 */
export type ControlAction =
  | { kind: "mouse"; button: number }
  | { kind: "key"; code: string }
  | { kind: "cursor"; direction: Direction }
  | null;

/**
 * ScummVM keeps its global menu on F5 and treats Escape as "skip/cancel"; the
 * period key is the engine-wide "skip current line of dialogue". These are the
 * controls a player reaches for that are not the pointer itself.
 */
export function controlAction(control: ConsoleControl): ControlAction {
  switch (control) {
    case "up":
    case "down":
    case "left":
    case "right":
      return { kind: "cursor", direction: control };
    case "a":
      return { kind: "mouse", button: MOUSE_LEFT };
    case "b":
      return { kind: "mouse", button: MOUSE_RIGHT };
    // Skip dialogue — the most-pressed button in a talky genre gets its own key.
    case "x":
      return { kind: "key", code: "Period" };
    case "y":
      return { kind: "key", code: "Space" };
    case "start":
      return { kind: "key", code: "F5" }; // ScummVM global menu (save/load/quit)
    case "select":
      return { kind: "key", code: "Escape" }; // skip cutscene / cancel
    default:
      return null;
  }
}

export interface ScreenBounds {
  width: number;
  height: number;
}

export interface CursorPosition {
  x: number;
  y: number;
}

/**
 * How fast the d-pad slides the cursor, in pixels of the game's own resolution
 * per second. Beneath a Steel Sky renders at 320x200, so ~260px/s crosses the
 * screen in a little over a second — quick enough to feel responsive, slow
 * enough to land on a hotspot without overshooting.
 */
export const DEFAULT_CURSOR_SPEED = 260;

/**
 * Integrates held directions into a pointer position.
 *
 * A gamepad has no absolute pointer, so the cursor is a piece of host state:
 * each frame advances it by the held direction times elapsed time, clamped to
 * the screen. Kept separate from any engine or DOM so the motion — including the
 * diagonal-speed normalisation and the clamping at the edges — is unit-tested on
 * plain numbers.
 */
export class VirtualCursor {
  #x: number;
  #y: number;
  readonly #held = new Set<Direction>();

  constructor(
    private readonly bounds: ScreenBounds,
    private readonly speed = DEFAULT_CURSOR_SPEED,
    start?: CursorPosition,
  ) {
    // Default to the screen centre: a known, on-screen starting point rather
    // than a corner the player then has to drag away from.
    this.#x = start ? clamp(start.x, 0, bounds.width) : bounds.width / 2;
    this.#y = start ? clamp(start.y, 0, bounds.height) : bounds.height / 2;
  }

  get position(): CursorPosition {
    return { x: this.#x, y: this.#y };
  }

  hold(direction: Direction): void {
    this.#held.add(direction);
  }

  release(direction: Direction): void {
    this.#held.delete(direction);
  }

  releaseAll(): void {
    this.#held.clear();
  }

  get moving(): boolean {
    return this.#held.size > 0;
  }

  /**
   * Advances the cursor by the currently held directions.
   *
   * Returns the new position when it actually changed, or null when nothing is
   * held or the elapsed time is degenerate — so a caller only emits a pointer
   * event when there is real movement to report.
   */
  advance(deltaSeconds: number): CursorPosition | null {
    if (this.#held.size === 0 || !(deltaSeconds > 0)) {
      return null;
    }
    let dx = 0;
    let dy = 0;
    if (this.#held.has("left")) dx -= 1;
    if (this.#held.has("right")) dx += 1;
    if (this.#held.has("up")) dy -= 1;
    if (this.#held.has("down")) dy += 1;
    if (dx === 0 && dy === 0) {
      return null; // Opposite directions held: they cancel.
    }
    // Normalise so a diagonal is not √2 faster than a straight move.
    const length = Math.hypot(dx, dy);
    const step = this.speed * deltaSeconds;
    const nextX = clamp(this.#x + (dx / length) * step, 0, this.bounds.width);
    const nextY = clamp(this.#y + (dy / length) * step, 0, this.bounds.height);
    if (nextX === this.#x && nextY === this.#y) {
      return null; // Pinned against an edge; nothing moved.
    }
    this.#x = nextX;
    this.#y = nextY;
    return this.position;
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Launch arguments for ScummVM.
 *
 * ScummVM is a command-line program under the hood; its Emscripten build reads
 * the same argv. The target (`sky` for Beneath a Steel Sky) is looked up in the
 * bundled `scummvm.ini`, and the paths point at directories the caller has made
 * writable in the module filesystem so saves and config survive.
 */
export interface ScummvmArgOptions {
  /** Where ScummVM writes save games. Mounted to durable storage by the host. */
  savePath: string;
  /** Where ScummVM writes its config. */
  configPath?: string;
  /** Extra data path holding the bundled game data, if not already registered. */
  extraPath?: string;
  /** Force a renderer scale of 1 so the host controls upscaling with the canvas. */
  noAspectCorrection?: boolean;
}

export function buildScummvmArgs(target: string, options: ScummvmArgOptions): string[] {
  if (!/^[A-Za-z0-9:_-]+$/.test(target)) {
    // The target reaches an exec argv; keep it to the id charset ScummVM uses.
    throw new RangeError(`Invalid ScummVM target: ${target}`);
  }
  const args = [`--savepath=${options.savePath}`];
  if (options.configPath) {
    args.push(`--config=${options.configPath}`);
  }
  if (options.extraPath) {
    args.push(`--extrapath=${options.extraPath}`);
  }
  if (options.noAspectCorrection) {
    args.push("--no-aspect-ratio-correction");
  }
  // Fullscreen inside the canvas; the host sizes the canvas itself.
  args.push("--fullscreen");
  args.push(target);
  return args;
}

/**
 * A single file in ScummVM's save directory.
 *
 * ScummVM writes one file per save slot (plus a metadata file), so a title's
 * saves are a small set of named blobs rather than one opaque buffer. The host's
 * SaveStore holds one blob per title, so the directory is packed into a single
 * container and unpacked on the way back.
 */
export interface SaveFile {
  name: string;
  data: Uint8Array;
}

const SAVE_MAGIC = 0x53564d31; // "SVM1"

/**
 * Packs ScummVM's save files into one blob for the host SaveStore.
 *
 * A minimal, self-describing container: magic, count, then per-file a name and
 * length header followed by the bytes. Named files (not a positional array) so a
 * future ScummVM version adding a file does not shift everything after it.
 */
export function packSaves(files: readonly SaveFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const encodedNames = files.map((file) => encoder.encode(file.name));
  let total = 8; // magic + count
  for (let i = 0; i < files.length; i += 1) {
    total += 2 + encodedNames[i]!.byteLength + 4 + files[i]!.data.byteLength;
  }
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, SAVE_MAGIC);
  view.setUint32(4, files.length);
  let offset = 8;
  for (let i = 0; i < files.length; i += 1) {
    const name = encodedNames[i]!;
    if (name.byteLength > 0xffff) {
      throw new RangeError(`Save name too long: ${files[i]!.name}`);
    }
    view.setUint16(offset, name.byteLength);
    offset += 2;
    buffer.set(name, offset);
    offset += name.byteLength;
    view.setUint32(offset, files[i]!.data.byteLength);
    offset += 4;
    buffer.set(files[i]!.data, offset);
    offset += files[i]!.data.byteLength;
  }
  return buffer;
}

/**
 * Restores the save files packed by `packSaves`.
 *
 * Returns an empty list for anything that is not a container this runtime wrote,
 * so a corrupt or foreign blob loses the saves rather than crashing the loader —
 * the same "a refusal is expected, not an error" stance the ABI save path takes.
 */
export function unpackSaves(blob: Uint8Array): SaveFile[] {
  if (blob.byteLength < 8) {
    return [];
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (view.getUint32(0) !== SAVE_MAGIC) {
    return [];
  }
  const count = view.getUint32(4);
  const decoder = new TextDecoder();
  const files: SaveFile[] = [];
  let offset = 8;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > blob.byteLength) return files;
    const nameLength = view.getUint16(offset);
    offset += 2;
    if (offset + nameLength + 4 > blob.byteLength) return files;
    const name = decoder.decode(blob.subarray(offset, offset + nameLength));
    offset += nameLength;
    const dataLength = view.getUint32(offset);
    offset += 4;
    if (offset + dataLength > blob.byteLength) return files;
    files.push({ name, data: blob.slice(offset, offset + dataLength) });
    offset += dataLength;
  }
  return files;
}

/**
 * The slice of ScummVM's Emscripten filesystem the host touches.
 *
 * Emscripten's `FS` is far larger than this; narrowing it to the calls the save
 * bridge makes keeps the dependency auditable and lets tests supply a plain
 * in-memory stand-in.
 */
export interface ModuleFileSystem {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

/** Restores packed saves into a ScummVM save directory before launch. */
export function restoreSavesTo(fs: ModuleFileSystem, savePath: string, blob: Uint8Array): number {
  const files = unpackSaves(blob);
  fs.mkdirTree(savePath);
  for (const file of files) {
    fs.writeFile(joinPath(savePath, file.name), file.data);
  }
  return files.length;
}

/** Collects a ScummVM save directory into a blob for the host SaveStore. */
export function collectSavesFrom(fs: ModuleFileSystem, savePath: string): Uint8Array {
  if (!fs.analyzePath(savePath).exists) {
    return packSaves([]);
  }
  const files = fs
    .readdir(savePath)
    .filter((name) => name !== "." && name !== "..")
    .map<SaveFile>((name) => ({ name, data: fs.readFile(joinPath(savePath, name)) }));
  return packSaves(files);
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/**
 * The minimum of ScummVM's Emscripten Module the host drives.
 *
 * ScummVM's build is the classic (non-MODULARIZE) Emscripten shape: a factory is
 * handed a config object and resolves once the runtime is up. The fields here are
 * the ones the host sets or reads; the engine populates the rest.
 */
export interface ScummVmModule {
  FS: ModuleFileSystem;
  /** Emscripten's clean shutdown, when the build exposes it. */
  exit?: (code: number) => void;
  /** The canvas SDL renders into. */
  canvas?: HTMLCanvasElement;
}

export type ScummVmModuleFactory = (config: Record<string, unknown>) => Promise<ScummVmModule>;

/** Where a session sends the input it derives from the handheld. */
export interface InputSink {
  mouseMove(position: CursorPosition): void;
  mouseButton(button: number, down: boolean): void;
  key(code: string, down: boolean): void;
}

export interface ScummVmSessionOptions {
  target: string;
  bounds: ScreenBounds;
  savePath?: string;
  /** Prior saves for this title, as packed by `packSaves`. */
  restoreBlob?: Uint8Array | null;
  cursorSpeed?: number;
}

export const DEFAULT_SAVE_PATH = "/saves";

/**
 * A running ScummVM game.
 *
 * Owns the module, the cursor, and the mapping from handheld controls to the
 * InputSink. The factory and sink are injected so the whole press → pointer/click
 * path is testable against a fake module and a recording sink; the React player
 * supplies the real Emscripten factory and a DOM-event sink.
 */
export class ScummVmSession {
  readonly cursor: VirtualCursor;
  #disposed = false;

  private constructor(
    private readonly module: ScummVmModule,
    private readonly sink: InputSink,
    readonly bounds: ScreenBounds,
    private readonly savePath: string,
    cursorSpeed: number,
  ) {
    this.cursor = new VirtualCursor(bounds, cursorSpeed);
  }

  static async start(
    factory: ScummVmModuleFactory,
    sink: InputSink,
    options: ScummVmSessionOptions,
    extraConfig: Record<string, unknown> = {},
  ): Promise<ScummVmSession> {
    if (options.bounds.width <= 0 || options.bounds.height <= 0) {
      throw new RangeError("Screen bounds must be positive");
    }
    const savePath = options.savePath ?? DEFAULT_SAVE_PATH;
    const args = buildScummvmArgs(options.target, { savePath, noAspectCorrection: true });
    const module = await factory({ arguments: args, ...extraConfig });
    module.FS.mkdirTree(savePath);
    if (options.restoreBlob && options.restoreBlob.byteLength > 0) {
      restoreSavesTo(module.FS, savePath, options.restoreBlob);
    }
    return new ScummVmSession(module, sink, options.bounds, savePath, options.cursorSpeed ?? DEFAULT_CURSOR_SPEED);
  }

  /** Routes one handheld control press or release to ScummVM. */
  handleControl(control: ConsoleControl, down: boolean): void {
    if (this.#disposed) return;
    const action = controlAction(control);
    if (!action) return;
    switch (action.kind) {
      case "cursor":
        if (down) this.cursor.hold(action.direction);
        else this.cursor.release(action.direction);
        break;
      case "mouse":
        // A click lands wherever the cursor currently is, so move first.
        this.sink.mouseMove(this.cursor.position);
        this.sink.mouseButton(action.button, down);
        break;
      case "key":
        this.sink.key(action.code, down);
        break;
    }
  }

  /** Advances the cursor and emits a pointer move when it changed. */
  tickCursor(deltaSeconds: number): void {
    if (this.#disposed) return;
    const moved = this.cursor.advance(deltaSeconds);
    if (moved) {
      this.sink.mouseMove(moved);
    }
  }

  /** The current saves, packed for the host SaveStore. */
  collectSaves(): Uint8Array {
    return collectSavesFrom(this.module.FS, this.savePath);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cursor.releaseAll();
    try {
      this.module.exit?.(0);
    } catch {
      // Emscripten throws ExitStatus to unwind main; a clean teardown, not a fault.
    }
  }
}
