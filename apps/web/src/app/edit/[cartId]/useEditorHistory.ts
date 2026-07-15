"use client";

/**
 * useEditorHistory — one undo/redo timeline shared by every editor tab.
 *
 * All six tabs (Code, Sprites, Map, FX, SFX, Music) edit the same cartridge, so
 * a single history is the honest model: undo means "step the whole cart back one
 * edit", regardless of which tab made it. The cart's engine-backed memory
 * (sprites, map, code, SFX, music) is snapshotted as serialised .tic bytes; the
 * editor-only sidecars (post-FX stack, character rig) travel in the same
 * snapshot so they undo in lockstep.
 *
 * Rather than have each tab report its edits, the engine is wrapped by
 * `observeEngine`, which signals on every mutating call. Those signals are
 * coalesced on an idle timer so a gesture — a paint stroke, a burst of typing —
 * becomes a single undo step instead of hundreds. Restoring a snapshot bumps
 * `revision`, which callers fold into each editor's React key so the tab
 * remounts and re-reads the reverted cart.
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
  type MaterialSwatches,
  type SpriteRig,
} from "@cartbox/editor";
import type { PostFxSettings } from "@cartbox/player";

/** Idle gap after the last edit before a snapshot is committed as one undo step. */
const COALESCE_MS = 400;
/** Snapshots retained on the timeline, including the baseline. */
const HISTORY_LIMIT = 60;

/** One point on the timeline: the whole cart plus its editor-only sidecars. */
interface CartSnapshot {
  bytes: Uint8Array;
  bank: number;
  fx: PostFxSettings;
  rig: SpriteRig;
  materials: MaterialSwatches;
}

export interface EditorHistory {
  /** Observed engine to hand to the SpriteSheet/TileMap/etc. views. */
  engine: CartEngine;
  /** Bumps on every undo/redo; fold into editor keys to force a re-read. */
  revision: number;
  bank: number;
  setBank: (bank: number) => void;
  fx: PostFxSettings;
  setFx: (fx: PostFxSettings) => void;
  rig: SpriteRig;
  setRig: (rig: SpriteRig) => void;
  materials: MaterialSwatches;
  setMaterials: (materials: MaterialSwatches) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

interface UseEditorHistoryArgs {
  engine: CartEngine;
  /** The serialisable engine, or null when running on the offline stub. */
  runnable: WasmCartEngine | null;
  initialFx: PostFxSettings;
  initialRig: SpriteRig;
  initialMaterials: MaterialSwatches;
  initialBank: number;
}

/** Two cart snapshots are equal when bytes, bank, FX, rig and materials match. */
function snapshotsEqual(a: CartSnapshot, b: CartSnapshot): boolean {
  if (a.bank !== b.bank) return false;
  if (!bytesEqual(a.bytes, b.bytes)) return false;
  // FX, rig and materials are small plain-data objects produced by the same code
  // paths, so a structural string compare is a sound and cheap equality here.
  if (JSON.stringify(a.fx) !== JSON.stringify(b.fx)) return false;
  if (JSON.stringify(a.rig) !== JSON.stringify(b.rig)) return false;
  return JSON.stringify(a.materials) === JSON.stringify(b.materials);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function useEditorHistory({
  engine,
  runnable,
  initialFx,
  initialRig,
  initialMaterials,
  initialBank,
}: UseEditorHistoryArgs): EditorHistory {
  const [bank, setBankState] = useState(initialBank);
  const [fx, setFxState] = useState<PostFxSettings>(initialFx);
  const [rig, setRigState] = useState<SpriteRig>(initialRig);
  const [materials, setMaterialsState] = useState<MaterialSwatches>(initialMaterials);
  const [revision, setRevision] = useState(0);
  // A monotonic version so canUndo/canRedo re-evaluate when the timeline moves.
  const [, setHistoryVersion] = useState(0);

  // Latest-value refs let the coalescing callbacks stay identity-stable (so the
  // observed engine proxy never has to be rebuilt) while reading fresh state.
  const bankRef = useRef(bank);
  const fxRef = useRef(fx);
  const rigRef = useRef(rig);
  const materialsRef = useRef(materials);
  const runnableRef = useRef(runnable);
  const applyingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<EditHistory<CartSnapshot> | null>(null);
  bankRef.current = bank;
  runnableRef.current = runnable;

  const capture = useCallback((): CartSnapshot | null => {
    const serialisable = runnableRef.current;
    if (!serialisable) return null;
    return {
      bytes: serialisable.saveTic(),
      bank: bankRef.current,
      fx: fxRef.current,
      rig: rigRef.current,
      materials: materialsRef.current,
    };
  }, []);

  const commit = useCallback(() => {
    timerRef.current = null;
    const history = historyRef.current;
    const snapshot = capture();
    if (!history || !snapshot) return;
    if (history.record(snapshot)) setHistoryVersion((version) => version + 1);
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
      fxRef.current = snapshot.fx;
      setFxState(snapshot.fx);
      rigRef.current = snapshot.rig;
      setRigState(snapshot.rig);
      materialsRef.current = snapshot.materials;
      setMaterialsState(snapshot.materials);
    } finally {
      applyingRef.current = false;
    }
    // Force every tab to re-read the reverted cart from the engine.
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

  const setFx = useCallback((next: PostFxSettings) => {
    fxRef.current = next;
    setFxState(next);
    notify();
  }, [notify]);

  const setRig = useCallback((next: SpriteRig) => {
    rigRef.current = next;
    setRigState(next);
    notify();
  }, [notify]);

  const setMaterials = useCallback((next: MaterialSwatches) => {
    materialsRef.current = next;
    setMaterialsState(next);
    notify();
  }, [notify]);

  const history = historyRef.current;
  const canUndo = history?.canUndo() ?? false;
  const canRedo = history?.canRedo() ?? false;

  return {
    engine: observed,
    revision,
    bank,
    setBank,
    fx,
    setFx,
    rig,
    setRig,
    materials,
    setMaterials,
    canUndo,
    canRedo,
    undo,
    redo,
  };
}
