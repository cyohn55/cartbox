/**
 * Deterministic replays.
 *
 * A fantasy console is deterministic — fixed timestep, a host-controlled clock,
 * and a per-frame gamepad bitmask. So a full session is captured by recording
 * the input stream plus enough to reproduce initial state (cart identity + RNG
 * seed). Replaying feeds the same inputs back into a fresh console.
 *
 * Input rarely changes every frame, so the stream is run-length encoded: an
 * entry is stored only when the mask changes. This module is pure (no DOM, no
 * engine), so the recorder/playback machinery is fully unit-testable and can run
 * server-side for score verification.
 *
 * NOTE: bit-exact *engine* reproduction additionally requires the cart's RNG to
 * be seeded from `seed`. The host-side machinery here is complete; wiring the
 * seed into the engine shim (a `cbx_seed`) is the remaining determinism step.
 */

import type { ModelId } from "./models.js";

/** Bumped when the serialized shape changes incompatibly. */
export const REPLAY_VERSION = 1;

/** Default RNG seed. */
export const DEFAULT_SEED = 0;

/** A fresh non-negative 31-bit seed for a new recording. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** A change in the gamepad bitmask, effective from `frame` onward. */
export interface InputChange {
  frame: number;
  mask: number;
}

/** A recorded session. */
export interface Replay {
  version: number;
  modelId: ModelId;
  /** Identity of the cart this was recorded against (see {@link hashCart}). */
  cartHash: string;
  seed: number;
  frameCount: number;
  /** Run-length input stream: one entry per mask change. */
  inputs: InputChange[];
}

/** Metadata needed to start a recording. */
export interface ReplayMeta {
  modelId: ModelId;
  cartHash: string;
  seed?: number;
}

/** Raised when a serialized replay cannot be parsed or is the wrong version. */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/**
 * Records the per-frame input stream as run-length input changes. Call
 * {@link record} exactly once per ticked frame with that frame's gamepad mask.
 */
export class ReplayRecorder {
  private readonly inputs: InputChange[] = [];
  private frame = 0;
  private lastMask = -1; // sentinel: guarantees frame 0 is always recorded

  constructor(private readonly meta: ReplayMeta) {}

  record(mask: number): void {
    if (mask !== this.lastMask) {
      this.inputs.push({ frame: this.frame, mask });
      this.lastMask = mask;
    }
    this.frame++;
  }

  get frameCount(): number {
    return this.frame;
  }

  /** Produces the immutable replay captured so far. */
  finish(): Replay {
    return {
      version: REPLAY_VERSION,
      modelId: this.meta.modelId,
      cartHash: this.meta.cartHash,
      seed: this.meta.seed ?? DEFAULT_SEED,
      frameCount: this.frame,
      inputs: this.inputs.map((change) => ({ ...change })),
    };
  }
}

/**
 * Reconstructs the per-frame mask from a recorded input stream. Designed for
 * linear playback (frames queried in order); querying an earlier frame rewinds
 * and re-scans, so seeking still works, just not in constant time.
 */
export class ReplaySource {
  private cursor = 0;
  private currentMask = 0;
  private lastFrame = -1;

  constructor(private readonly inputs: InputChange[]) {}

  /** The gamepad mask effective at the given frame. */
  maskForFrame(frame: number): number {
    if (frame < this.lastFrame) {
      this.cursor = 0;
      this.currentMask = 0;
    }
    this.lastFrame = frame;

    while (this.cursor < this.inputs.length) {
      const change = this.inputs[this.cursor];
      if (!change || change.frame > frame) {
        break;
      }
      this.currentMask = change.mask;
      this.cursor++;
    }
    return this.currentMask;
  }
}

/**
 * Stable, non-cryptographic identity hash of cart bytes (FNV-1a, 32-bit). Used
 * to confirm a replay is being applied to the same cartridge it was recorded on.
 */
export function hashCart(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Serializes a replay to a compact JSON string. */
export function serializeReplay(replay: Replay): string {
  return JSON.stringify(replay);
}

/** Parses and validates a serialized replay. */
export function parseReplay(json: string): Replay {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new ReplayError("Replay is not valid JSON");
  }

  if (typeof value !== "object" || value === null) {
    throw new ReplayError("Replay must be an object");
  }
  const candidate = value as Record<string, unknown>;

  if (candidate.version !== REPLAY_VERSION) {
    throw new ReplayError(`Unsupported replay version: ${String(candidate.version)}`);
  }
  if (typeof candidate.cartHash !== "string" || !Array.isArray(candidate.inputs)) {
    throw new ReplayError("Replay is missing required fields");
  }

  return candidate as unknown as Replay;
}
