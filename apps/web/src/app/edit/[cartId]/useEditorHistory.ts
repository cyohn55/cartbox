"use client";

/**
 * useEditorHistory — one undo/redo timeline shared by every editor tab.
 *
 * Every tab edits the same cartridge, so a single history is the honest model:
 * undo means "step the whole cart back one edit", regardless of which tab made
 * it. The cart's engine-backed memory (sprites, map, code, SFX, music) is
 * snapshotted as serialised .tic bytes; the sidecars that ride beside it (FX,
 * rig, materials, sculpt, meshes, world, backdrop, animation, weather,
 * collision, flags) travel in the same snapshot so they undo in lockstep.
 *
 * The sidecars arrive as one bundle from the registry rather than as a field
 * per payload. That is what makes `mesh` and `world` undoable: they were never
 * outside the timeline for a reason, they were outside it because adding a
 * sidecar meant remembering seven separate places in this file.
 *
 * Rather than have each tab report its edits, the engine is wrapped by
 * `observeEngine`, which signals on every mutating call. Those signals are
 * coalesced on an idle timer so a gesture — a paint stroke, a burst of typing —
 * becomes a single undo step instead of hundreds. Restoring a snapshot bumps
 * `revision`, which every view watches so it re-reads the reverted cart.
 *
 * History requires the WASM engine (only it can serialise/restore .tic bytes);
 * with the offline stub it stays inert, matching Run/Save which are also
 * unavailable there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EditHistory,
  WasmCartEngine,
  observeEngine,
  type CartEngine,
} from "@cartbox/editor";

import { SIDECAR_KEYS, sidecarsEqual, type SidecarKey, type SidecarValue, type Sidecars } from "@/lib/sidecars";

/** Idle gap after the last edit before a snapshot is committed as one undo step. */
const COALESCE_MS = 400;
/** Snapshots retained on the timeline, including the baseline. */
const HISTORY_LIMIT = 60;

/** One point on the timeline: the whole cart plus its sidecars. */
export interface CartSnapshot {
  bytes: Uint8Array;
  bank: number;
  sidecars: Sidecars;
  /**
   * FNV-1a hash of `bytes`, computed once when the snapshot is captured.
   *
   * Equality used to byte-compare two whole cartridges on every coalesced
   * commit — several hundred KB of comparison per gesture on a well-used
   * eight-bank cart. Hashing at capture makes the common "nothing actually
   * changed" check a single integer compare, and the bytes are still compared
   * on the rare collision so the timeline never silently drops a real edit.
   */
  hash: number;
}

export interface EditorHistory {
  /** Observed engine to hand to the SpriteSheet/TileMap/etc. views. */
  engine: CartEngine;
  /** Bumps on every undo/redo; views subscribe to it to re-read the cart. */
  revision: number;
  bank: number;
  setBank: (bank: number) => void;
  /** Every sidecar the cart carries. */
  sidecars: Sidecars;
  /** Replace one sidecar, recording it on the timeline. */
  setSidecar: <K extends SidecarKey>(key: K, value: SidecarValue<K> | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** The snapshot currently applied, for callers tracking what has been saved. */
  current: () => CartSnapshot | null;
}

interface UseEditorHistoryArgs {
  engine: CartEngine;
  /** The serialisable engine, or null when running on the offline stub. */
  runnable: WasmCartEngine | null;
  initialSidecars: Sidecars;
  initialBank: number;
  /** Called after every committed edit, with the new present. */
  onCommit?: (snapshot: CartSnapshot) => void;
}

/** FNV-1a over the cart bytes. Cheap, well-spread, and stable across runs. */
export function hashBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Two snapshots are the same timeline state when bank, cart bytes and every
 * sidecar match. The hash short-circuits the byte comparison, which is what
 * makes this cheap enough to run on every coalesced commit.
 */
export function snapshotsEqual(a: CartSnapshot, b: CartSnapshot): boolean {
  if (a.bank !== b.bank) return false;
  if (a.hash !== b.hash) return false;
  if (!sidecarsEqual(a.sidecars, b.sidecars)) return false;
  return bytesEqual(a.bytes, b.bytes);
}

export function useEditorHistory({
  engine,
  runnable,
  initialSidecars,
  initialBank,
  onCommit,
}: UseEditorHistoryArgs): EditorHistory {
  const [bank, setBankState] = useState(initialBank);
  const [sidecars, setSidecarsState] = useState<Sidecars>(initialSidecars);
  const [revision, setRevision] = useState(0);
  // A monotonic version so canUndo/canRedo re-evaluate when the timeline moves.
  const [, setHistoryVersion] = useState(0);

  // Latest-value refs let the coalescing callbacks stay identity-stable (so the
  // observed engine proxy never has to be rebuilt) while reading fresh state.
  const bankRef = useRef(bank);
  const sidecarsRef = useRef(sidecars);
  const runnableRef = useRef(runnable);
  const onCommitRef = useRef(onCommit);
  const applyingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<EditHistory<CartSnapshot> | null>(null);
  bankRef.current = bank;
  runnableRef.current = runnable;
  onCommitRef.current = onCommit;

  const capture = useCallback((): CartSnapshot | null => {
    const serialisable = runnableRef.current;
    if (!serialisable) return null;
    const bytes = serialisable.saveTic();
    return { bytes, bank: bankRef.current, sidecars: sidecarsRef.current, hash: hashBytes(bytes) };
  }, []);

  const commit = useCallback(() => {
    timerRef.current = null;
    const history = historyRef.current;
    const snapshot = capture();
    if (!history || !snapshot) return;
    if (history.record(snapshot)) {
      setHistoryVersion((version) => version + 1);
      onCommitRef.current?.(snapshot);
    }
  }, [capture]);

  const notify = useCallback(() => {
    if (applyingRef.current || !runnableRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(commit, COALESCE_MS);
  }, [commit]);

  // The proxy is stable per engine: `notify` never changes identity, so the
  // SpriteSheet/TileMap/etc. built on this survive re-renders.
  const observed = useMemo(() => observeEngine(engine, notify), [engine, notify]);

  // Seed the baseline snapshot once the serialisable engine is ready.
  useEffect(() => {
    const baseline = capture();
    if (baseline) {
      historyRef.current = new EditHistory(baseline, { limit: HISTORY_LIMIT, equals: snapshotsEqual });
      setHistoryVersion((version) => version + 1);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [capture, engine]);

  const apply = useCallback((snapshot: CartSnapshot) => {
    const serialisable = runnableRef.current;
    if (!serialisable) return;
    applyingRef.current = true;
    try {
      serialisable.loadTic(snapshot.bytes);
      serialisable.setBank(snapshot.bank);
      bankRef.current = snapshot.bank;
      setBankState(snapshot.bank);
      sidecarsRef.current = snapshot.sidecars;
      setSidecarsState(snapshot.sidecars);
    } finally {
      applyingRef.current = false;
    }
    // Tell every view to re-read the reverted cart from the engine.
    setRevision((value) => value + 1);
  }, []);

  // A pending coalesced edit is committed before time travel so undo targets the
  // in-progress gesture rather than the state before it.
  const flushPending = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    commit();
  }, [commit]);

  const undo = useCallback(() => {
    flushPending();
    const previous = historyRef.current?.undo();
    if (previous) {
      apply(previous);
      setHistoryVersion((version) => version + 1);
    }
  }, [apply, flushPending]);

  const redo = useCallback(() => {
    flushPending();
    const next = historyRef.current?.redo();
    if (next) {
      apply(next);
      setHistoryVersion((version) => version + 1);
    }
  }, [apply, flushPending]);

  const setBank = useCallback((next: number) => {
    engine.setBank(next);
    bankRef.current = next;
    setBankState(next);
  }, [engine]);

  const setSidecar = useCallback(
    <K extends SidecarKey>(key: K, value: SidecarValue<K> | null) => {
      const next = { ...sidecarsRef.current, [key]: value } as Sidecars;
      sidecarsRef.current = next;
      setSidecarsState(next);
      notify();
    },
    [notify],
  );

  const current = useCallback(() => historyRef.current?.current() ?? null, []);

  const history = historyRef.current;
  const canUndo = history?.canUndo() ?? false;
  const canRedo = history?.canRedo() ?? false;

  return {
    engine: observed,
    revision,
    bank,
    setBank,
    sidecars,
    setSidecar,
    canUndo,
    canRedo,
    undo,
    redo,
    current,
  };
}

/** Re-exported so callers can iterate the timeline's sidecars without a second import. */
export { SIDECAR_KEYS };
