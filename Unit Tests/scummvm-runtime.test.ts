/**
 * Tests for the `scummvm` runtime host logic.
 *
 * These exercise the parts that decide what input ScummVM receives and how a
 * save round-trips — the pieces that must be right for a point-and-click game to
 * be playable on a gamepad — against real values, with a fake module and a
 * recording input sink standing in for the engine and the DOM.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CURSOR_SPEED,
  DEFAULT_SAVE_PATH,
  MOUSE_LEFT,
  MOUSE_RIGHT,
  ScummVmSession,
  VirtualCursor,
  buildScummvmArgs,
  collectSavesFrom,
  controlAction,
  packSaves,
  restoreSavesTo,
  unpackSaves,
  type CursorPosition,
  type InputSink,
  type ModuleFileSystem,
  type SaveFile,
  type ScummVmModule,
} from "../apps/web/src/lib/scummvmRuntime";

/** An in-memory stand-in for Emscripten's FS, holding exactly the calls used. */
class FakeFileSystem implements ModuleFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(["/"]);

  mkdirTree(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  writeFile(path: string, data: Uint8Array): void {
    this.files.set(path, Uint8Array.from(data));
  }

  readFile(path: string): Uint8Array {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such file: ${path}`);
    return data;
  }

  readdir(path: string): string[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>([".", ".."]);
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        names.add(filePath.slice(prefix.length).split("/")[0]!);
      }
    }
    return [...names];
  }

  unlink(path: string): void {
    this.files.delete(path);
  }

  analyzePath(path: string): { exists: boolean } {
    return { exists: this.dirs.has(path) || this.files.has(path) };
  }
}

/** Records everything a session pushes, so translation is asserted on outputs. */
class RecordingSink implements InputSink {
  readonly moves: CursorPosition[] = [];
  readonly buttons: Array<{ button: number; down: boolean; at: CursorPosition }> = [];
  readonly keys: Array<{ code: string; down: boolean }> = [];
  #last: CursorPosition = { x: 0, y: 0 };

  mouseMove(position: CursorPosition): void {
    this.#last = position;
    this.moves.push(position);
  }

  mouseButton(button: number, down: boolean): void {
    this.buttons.push({ button, down, at: this.#last });
  }

  key(code: string, down: boolean): void {
    this.keys.push({ code, down });
  }
}

function fakeModule(fs: FakeFileSystem): ScummVmModule {
  return { FS: fs, exit: () => undefined };
}

describe("controlAction", () => {
  it("maps the face buttons to the two mouse buttons a two-verb adventure needs", () => {
    expect(controlAction("a")).toEqual({ kind: "mouse", button: MOUSE_LEFT });
    expect(controlAction("b")).toEqual({ kind: "mouse", button: MOUSE_RIGHT });
  });

  it("routes the d-pad to cursor motion, not discrete actions", () => {
    for (const direction of ["up", "down", "left", "right"] as const) {
      expect(controlAction(direction)).toEqual({ kind: "cursor", direction });
    }
  });

  it("reaches ScummVM's own UI from the system buttons", () => {
    expect(controlAction("start")).toEqual({ kind: "key", code: "F5" });
    expect(controlAction("select")).toEqual({ kind: "key", code: "Escape" });
  });
});

describe("VirtualCursor", () => {
  it("starts centred so the pointer is on-screen before any input", () => {
    const cursor = new VirtualCursor({ width: 320, height: 200 });
    expect(cursor.position).toEqual({ x: 160, y: 100 });
    expect(cursor.moving).toBe(false);
  });

  it("moves at the configured speed for the elapsed time", () => {
    const cursor = new VirtualCursor({ width: 320, height: 200 }, 100);
    cursor.hold("right");
    const moved = cursor.advance(0.5); // 100px/s for 0.5s = 50px
    expect(moved).toEqual({ x: 210, y: 100 });
  });

  it("normalises diagonal speed so it is not faster than a straight move", () => {
    const straight = new VirtualCursor({ width: 1000, height: 1000 }, 100, { x: 0, y: 0 });
    straight.hold("right");
    const straightMove = straight.advance(1);

    const diagonal = new VirtualCursor({ width: 1000, height: 1000 }, 100, { x: 0, y: 0 });
    diagonal.hold("right");
    diagonal.hold("down");
    const diagonalMove = diagonal.advance(1);

    const straightDistance = Math.hypot(straightMove!.x, straightMove!.y);
    const diagonalDistance = Math.hypot(diagonalMove!.x, diagonalMove!.y);
    expect(diagonalDistance).toBeCloseTo(straightDistance, 5);
  });

  it("clamps to the screen and reports no move when pinned at an edge", () => {
    const cursor = new VirtualCursor({ width: 320, height: 200 }, 1000, { x: 315, y: 100 });
    cursor.hold("right");
    expect(cursor.advance(1)).toEqual({ x: 320, y: 100 }); // clamped to the edge
    expect(cursor.advance(1)).toBeNull(); // already there — nothing to report
  });

  it("cancels opposite directions held together", () => {
    const cursor = new VirtualCursor({ width: 320, height: 200 }, 100);
    cursor.hold("left");
    cursor.hold("right");
    expect(cursor.advance(1)).toBeNull();
  });

  it("reports no movement once every direction is released", () => {
    const cursor = new VirtualCursor({ width: 320, height: 200 }, 100);
    cursor.hold("up");
    cursor.advance(0.1);
    cursor.release("up");
    expect(cursor.moving).toBe(false);
    expect(cursor.advance(1)).toBeNull();
  });
});

describe("buildScummvmArgs", () => {
  it("passes the save path and the target through to ScummVM's argv", () => {
    const args = buildScummvmArgs("sky", { savePath: "/saves" });
    expect(args).toContain("--savepath=/saves");
    expect(args[args.length - 1]).toBe("sky"); // target is positional and last
  });

  it("rejects a target that could smuggle extra argv tokens", () => {
    expect(() => buildScummvmArgs("sky --config=/etc/passwd", { savePath: "/saves" })).toThrow(RangeError);
  });
});

describe("save packing", () => {
  it("round-trips a set of named save files", () => {
    const files: SaveFile[] = [
      { name: "sky.000", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "sky.001", data: new Uint8Array([9, 8, 7]) },
    ];
    const restored = unpackSaves(packSaves(files));
    expect(restored).toHaveLength(2);
    expect(restored[0]).toEqual(files[0]);
    expect(restored[1]).toEqual(files[1]);
  });

  it("treats a foreign or corrupt blob as no saves rather than throwing", () => {
    expect(unpackSaves(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toEqual([]);
    expect(unpackSaves(new Uint8Array(2))).toEqual([]);
  });

  it("survives a truncated container by returning what it could read", () => {
    const packed = packSaves([{ name: "sky.000", data: new Uint8Array([1, 2, 3, 4]) }]);
    // Cut the payload short: the header promises more bytes than remain.
    const truncated = packed.slice(0, packed.byteLength - 2);
    expect(unpackSaves(truncated)).toEqual([]);
  });
});

describe("save directory bridge", () => {
  it("restores packed saves into the module filesystem before launch", () => {
    const fs = new FakeFileSystem();
    const blob = packSaves([{ name: "sky.000", data: new Uint8Array([5, 6, 7]) }]);
    const count = restoreSavesTo(fs, "/saves", blob);
    expect(count).toBe(1);
    expect(fs.readFile("/saves/sky.000")).toEqual(new Uint8Array([5, 6, 7]));
  });

  it("collects the saves the engine wrote back into a blob", () => {
    const fs = new FakeFileSystem();
    fs.mkdirTree("/saves");
    fs.writeFile("/saves/sky.000", new Uint8Array([1, 1, 2, 3, 5]));
    const collected = collectSavesFrom(fs, "/saves");
    const files = unpackSaves(collected);
    expect(files).toEqual([{ name: "sky.000", data: new Uint8Array([1, 1, 2, 3, 5]) }]);
  });

  it("returns an empty container when the save directory is absent", () => {
    const fs = new FakeFileSystem();
    expect(unpackSaves(collectSavesFrom(fs, "/saves"))).toEqual([]);
  });
});

describe("ScummVmSession", () => {
  const options = { target: "sky", bounds: { width: 320, height: 200 } };

  it("launches with the built argv and the default save path", async () => {
    const fs = new FakeFileSystem();
    let seenConfig: Record<string, unknown> | null = null;
    const session = await ScummVmSession.start(
      async (config) => {
        seenConfig = config;
        return fakeModule(fs);
      },
      new RecordingSink(),
      options,
    );
    expect((seenConfig!.arguments as string[]).at(-1)).toBe("sky");
    expect((seenConfig!.arguments as string[])).toContain(`--savepath=${DEFAULT_SAVE_PATH}`);
    expect(fs.dirs.has(DEFAULT_SAVE_PATH)).toBe(true);
    session.dispose();
  });

  it("restores prior saves into the engine filesystem on start", async () => {
    const fs = new FakeFileSystem();
    const restoreBlob = packSaves([{ name: "sky.000", data: new Uint8Array([42]) }]);
    await ScummVmSession.start(async () => fakeModule(fs), new RecordingSink(), { ...options, restoreBlob });
    expect(fs.readFile(`${DEFAULT_SAVE_PATH}/sky.000`)).toEqual(new Uint8Array([42]));
  });

  it("clicks the left mouse button at the cursor's current position", async () => {
    const fs = new FakeFileSystem();
    const sink = new RecordingSink();
    const session = await ScummVmSession.start(async () => fakeModule(fs), sink, options);

    // Slide the cursor right, then press A.
    session.handleControl("right", true);
    session.tickCursor(0.5);
    session.handleControl("right", false);
    session.handleControl("a", true);

    const press = sink.buttons.find((event) => event.down);
    expect(press?.button).toBe(MOUSE_LEFT);
    expect(press?.at.x).toBeGreaterThan(160); // moved right of centre before the click
    session.dispose();
  });

  it("emits a pointer move only while a direction is held", async () => {
    const fs = new FakeFileSystem();
    const sink = new RecordingSink();
    const session = await ScummVmSession.start(async () => fakeModule(fs), sink, options);

    session.tickCursor(0.5); // nothing held
    expect(sink.moves).toHaveLength(0);

    session.handleControl("down", true);
    session.tickCursor(0.1);
    expect(sink.moves.length).toBeGreaterThan(0);
    session.dispose();
  });

  it("sends a key for the skip-dialogue button rather than a click", async () => {
    const fs = new FakeFileSystem();
    const sink = new RecordingSink();
    const session = await ScummVmSession.start(async () => fakeModule(fs), sink, options);
    session.handleControl("x", true);
    session.handleControl("x", false);
    expect(sink.keys).toEqual([
      { code: "Period", down: true },
      { code: "Period", down: false },
    ]);
    expect(sink.buttons).toHaveLength(0);
    session.dispose();
  });

  it("collects saves the running engine produced", async () => {
    const fs = new FakeFileSystem();
    const session = await ScummVmSession.start(async () => fakeModule(fs), new RecordingSink(), options);
    // The engine writes a save mid-session.
    fs.writeFile(`${DEFAULT_SAVE_PATH}/sky.000`, new Uint8Array([1, 2, 3]));
    const files = unpackSaves(session.collectSaves());
    expect(files).toEqual([{ name: "sky.000", data: new Uint8Array([1, 2, 3]) }]);
    session.dispose();
  });

  it("ignores input after disposal", async () => {
    const fs = new FakeFileSystem();
    const sink = new RecordingSink();
    const session = await ScummVmSession.start(async () => fakeModule(fs), sink, options);
    session.dispose();
    session.handleControl("a", true);
    session.tickCursor(1);
    expect(sink.buttons).toHaveLength(0);
    expect(sink.moves).toHaveLength(0);
  });

  it("rejects non-positive screen bounds", async () => {
    const fs = new FakeFileSystem();
    await expect(
      ScummVmSession.start(async () => fakeModule(fs), new RecordingSink(), {
        target: "sky",
        bounds: { width: 0, height: 200 },
      }),
    ).rejects.toThrow(RangeError);
  });

  it("uses the documented default cursor speed when none is given", () => {
    expect(DEFAULT_CURSOR_SPEED).toBeGreaterThan(0);
  });
});
