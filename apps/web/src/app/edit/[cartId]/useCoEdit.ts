"use client";

/**
 * Co-editing in the editor (AAA_PRODUCTION_ROADMAP.md W2): while it's on, the
 * cart's sidecars (the scene object by object, and every other layer) travel
 * between everyone editing this cart, and their edits land here as they make
 * them, on the undo timeline like any other change.
 *
 * The session is the engine's (`CoEditSession`, coEdit.ts); this hook feeds it
 * every local change, applies what it merges, and says who else is here.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CoEditSession, type Presence } from "@/lib/coEdit";
import { coEditReach, coEditTransport } from "@/lib/coEditRealtime";
import { SIDECAR_KEYS, type SidecarKey, type SidecarValue, type Sidecars } from "@/lib/sidecars";

export type CoEditStatus = "off" | "connecting" | "on" | "error";

/** Every sidecar empty: what a register that isn't there reads as. */
const EMPTY = Object.fromEntries(SIDECAR_KEYS.map((key) => [key, null])) as unknown as Sidecars;

/** How often presence is said (and others' looked at). */
const ANNOUNCE_MS = 3000;

/**
 * The sidecar keys `merged` changes from `current`, compared as JSON (a scene
 * rebuilt from its objects may order its fields differently but reads the same
 * once parsed, so the mesh is compared parsed).
 */
export function changedSidecarKeys(current: Sidecars, merged: Sidecars): SidecarKey[] {
  const norm = (key: SidecarKey, v: unknown) => {
    if (key === "mesh" && typeof v === "string") {
      try {
        return JSON.stringify(sortKeys(JSON.parse(v)));
      } catch {
        return v;
      }
    }
    return JSON.stringify(v ?? null);
  };
  return SIDECAR_KEYS.filter((key) => norm(key, current[key]) !== norm(key, merged[key]));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export interface CoEdit {
  readonly status: CoEditStatus;
  /** The others editing now. */
  readonly others: readonly Presence[];
  /** Other devices (the hosted channel) or this browser's tabs. */
  readonly reach: "online" | "tabs";
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  readonly name: string;
  setName(name: string): void;
}

const NAME_KEY = "cartbox.coeditName";

function storedName(): string {
  try {
    return globalThis.localStorage?.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function useCoEdit({
  cartId,
  sidecars,
  setSidecar,
  selection = [],
}: {
  cartId: string;
  sidecars: Sidecars;
  setSidecar: <K extends SidecarKey>(key: K, value: SidecarValue<K> | null) => void;
  /** What this editor has selected (object ids), for the others to see. */
  selection?: readonly string[];
}): CoEdit {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<CoEditStatus>("off");
  const [others, setOthers] = useState<readonly Presence[]>([]);
  const [name, setNameState] = useState(() => storedName());
  const session = useRef<CoEditSession | null>(null);
  const latest = useRef(sidecars);
  latest.current = sidecars;
  const set = useRef(setSidecar);
  set.current = setSidecar;
  const said = useRef({ name, selection });
  said.current = { name, selection };
  const peer = useRef(`e-${Math.random().toString(36).slice(2, 10)}`);

  const setName = useCallback((next: string) => {
    const trimmed = next.slice(0, 40);
    setNameState(trimmed);
    try {
      globalThis.localStorage?.setItem(NAME_KEY, trimmed);
    } catch {
      // Not kept: it's asked again next time.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let transport: { close(): void } | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    setStatus("connecting");
    void coEditTransport(cartId).then(
      (t) => {
        if (cancelled) {
          t.close();
          return;
        }
        transport = t;
        const s = new CoEditSession(peer.current, t, latest.current, EMPTY, (merged) => {
          // Someone else's edit: each changed layer set once, so they coalesce into one undo step.
          for (const key of changedSidecarKeys(latest.current, merged)) set.current(key, merged[key] as never);
        });
        session.current = s;
        setStatus("on");
        const tick = () => {
          s.announce(said.current.name || "Someone", said.current.selection);
          setOthers(s.others());
        };
        tick();
        timer = setInterval(tick, ANNOUNCE_MS);
      },
      () => {
        if (!cancelled) setStatus("error");
      },
    );
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
      session.current = null;
      transport?.close();
      setOthers([]);
      setStatus("off");
    };
  }, [enabled, cartId]);

  // Every local change goes out (a merged one comes back as no change: the session already has it).
  useEffect(() => {
    session.current?.edit(sidecars);
  }, [sidecars]);

  // A new selection is said at once rather than at the next tick.
  const selectionKey = selection.join("\u0000");
  useEffect(() => {
    session.current?.announce(said.current.name || "Someone", said.current.selection);
  }, [selectionKey, name]);

  return { status, others, reach: coEditReach(), enabled, setEnabled, name, setName };
}
