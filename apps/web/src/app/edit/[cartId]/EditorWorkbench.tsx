"use client";

/**
 * The editor shell. It loads the TIC-80 WASM engine, loads the cart's stored
 * .tic into it (falling back to the demo seed), and backs every editor with that
 * one cartridge in WASM memory. Each editor is a view onto it (SpriteSheet,
 * TileMap, CodeDocument), so edits carry across tabs and serialise back to a
 * real .tic on Save/Publish. If the engine can't load, an in-memory stub keeps
 * the UI working. This chrome is custom Cartbox UI — the TIC-80 editor is not
 * shown.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { defaultPostFxSettings, type PostFxSettings } from "@cartbox/player";
import {
  BANK_COUNT,
  CartEngine,
  CodeDocument,
  CONSOLE_MODELS,
  MaterialMap,
  MusicTracker,
  NormalMap,
  SoundBank,
  SpriteSheet,
  StubCartEngine,
  TileMap,
  WasmCartEngine,
  applyStarter,
  emptySpriteRig,
  loadWasmCartEngine,
  type ConsoleModelId,
  type SpriteRig,
} from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { isStaticExport } from "@/lib/staticSite";
import { saveCartDraft } from "@/lib/localCartStore";
import type { WireRig } from "@/lib/rig";
import styles from "./editor.module.css";
import { SpriteEditor } from "./SpriteEditor";
import { MapEditor } from "./MapEditor";
import { CodeEditor } from "./CodeEditor";
import { SfxEditor } from "./SfxEditor";
import { MusicEditor } from "./MusicEditor";
import { RunOverlay } from "./RunOverlay";
import { ShaderEditor } from "./ShaderEditor";

const TABS = ["Code", "Sprites", "Map", "FX", "SFX", "Music"] as const;
type Tab = (typeof TABS)[number];
const LIVE_TABS: ReadonlySet<Tab> = new Set<Tab>(["Code", "Sprites", "Map", "FX", "SFX", "Music"]);

type EngineMode = "wasm" | "stub";
type SaveState = "idle" | "saving" | "saved" | "error";

interface EditorWorkbenchProps {
  cartId: string;
  cartName: string;
  cartUrl: string | null;
  modelId: ConsoleModelId;
  /** Starter to seed a brand-new cart with; ignored once stored bytes load. */
  starterId: string;
  /** Persisted character rig loaded with the cart, or null when none. */
  initialRig: WireRig | null;
  /** Persisted post-processing stack loaded with the cart, or null when none. */
  initialFx: PostFxSettings | null;
}

export function EditorWorkbench({
  cartId,
  cartName,
  cartUrl,
  modelId,
  starterId,
  initialRig,
  initialFx,
}: EditorWorkbenchProps) {
  const [engine, setEngine] = useState<CartEngine | null>(null);
  const [mode, setMode] = useState<EngineMode>("wasm");

  // The model selects both the WASM core to load and the geometry every editor
  // surface reads (palette size, canvas, sound channels). Both come from modelId.
  const model = CONSOLE_MODELS[modelId];
  const engineUrl = ENGINE_URL_BY_MODEL[modelId];

  useEffect(() => {
    let active = true;

    const boot = async () => {
      const loaded = await loadWasmCartEngine(engineUrl, model);
      if (cartUrl) {
        try {
          const response = await fetch(cartUrl);
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > 0) loaded.loadTic(bytes);
          }
        } catch {
          // Keep the demo seed if the stored cart can't be fetched.
        }
      } else {
        // Brand-new cart (no stored bytes): open on the chosen starter.
        applyStarter(loaded, starterId);
      }
      return loaded;
    };

    boot()
      .then((loaded) => {
        if (active) {
          setEngine(loaded);
          setMode("wasm");
        } else {
          loaded.dispose();
        }
      })
      .catch((error: unknown) => {
        console.error("Editor engine failed to load; using in-memory stub.", error);
        if (active) {
          const stub = new StubCartEngine();
          if (!cartUrl) applyStarter(stub, starterId);
          setEngine(stub);
          setMode("stub");
        }
      });

    return () => {
      active = false;
    };
  }, [cartUrl, engineUrl, model, starterId]);

  if (!engine) {
    return (
      <div className={styles.workbench}>
        <header className={styles.topbar}>
          <Link href="/" className={styles.wordmark} title="Back to the Cartbox home page">
            Cartbox
          </Link>
          <span className={styles.cartName}>{cartName}</span>
        </header>
        <div className={styles.loading}>Loading {model.label} engine…</div>
      </div>
    );
  }

  return (
    <WorkbenchBody
      engine={engine}
      cartId={cartId}
      cartName={cartName}
      mode={mode}
      modelId={modelId}
      engineUrl={engineUrl}
      initialRig={initialRig}
      initialFx={initialFx}
    />
  );
}

function WorkbenchBody({
  engine,
  cartId,
  cartName,
  mode,
  modelId,
  engineUrl,
  initialRig,
  initialFx,
}: {
  engine: CartEngine;
  cartId: string;
  cartName: string;
  mode: EngineMode;
  modelId: ConsoleModelId;
  engineUrl: string;
  initialRig: WireRig | null;
  initialFx: PostFxSettings | null;
}) {
  // requestedModel is what the URL/DB asked for; activeModel is what the loaded
  // engine actually provides (every editor surface reads geometry from this one).
  // They diverge when the requested core fails to load and we fall back to the
  // classic stub — surfaced in the badge so a silent downgrade is visible.
  const requestedModel = CONSOLE_MODELS[modelId];
  const activeModel = engine.model();
  const modelDowngraded = requestedModel.id !== activeModel.id;
  const sheet = useMemo(() => new SpriteSheet(engine), [engine]);
  const map = useMemo(() => new TileMap(engine), [engine]);
  const doc = useMemo(() => new CodeDocument(engine), [engine]);
  const soundBank = useMemo(() => new SoundBank(engine), [engine]);
  const tracker = useMemo(() => new MusicTracker(engine), [engine]);
  const normals = useMemo(() => new NormalMap(engine), [engine]);
  const heightMap = useMemo(() => new MaterialMap(engine, "height"), [engine]);
  const specularMap = useMemo(() => new MaterialMap(engine, "specular"), [engine]);
  const roughnessMap = useMemo(() => new MaterialMap(engine, "roughness"), [engine]);
  const emissiveMap = useMemo(() => new MaterialMap(engine, "emissive"), [engine]);
  const [activeTab, setActiveTab] = useState<Tab>("Sprites");
  const [bank, setBank] = useState(0);
  const [runBytes, setRunBytes] = useState<Uint8Array | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // The character rig is editor-only metadata, held cart-wide here so it
  // survives tab/bank switches and persists alongside the cart on Save.
  const [rig, setRig] = useState<SpriteRig>(() => initialRig ?? emptySpriteRig());
  // The FX stack is cart-wide too: authored in the FX tab, applied by the
  // player on Run and on the public play page, persisted alongside the cart.
  const [fx, setFx] = useState<PostFxSettings>(() => initialFx ?? defaultPostFxSettings());

  // Bank is a cart-wide "which set of assets am I editing". Switching repoints
  // the engine and remounts the active editor (via key) so it reads the new bank.
  const selectBank = (next: number) => {
    engine.setBank(next);
    setBank(next);
  };

  // Run/Save need real .tic bytes, which only the WASM engine can serialise.
  const runnable = engine instanceof WasmCartEngine ? engine : null;

  const persist = async (publish: boolean) => {
    if (!runnable) return;
    setSaveState("saving");
    try {
      const bytes = runnable.saveTic();
      // The static demo build has no API — Save lands in this browser's
      // localStorage instead (same payload the server would persist).
      if (isStaticExport) {
        const stored = saveCartDraft(cartId, { model: modelId, bytes, rig, fx });
        setSaveState(stored ? "saved" : "error");
        return;
      }
      // Tag the save with the model so the cart row persists console_model
      // (the URL param that opened a new Pro cart becomes durable on first save).
      const query = new URLSearchParams({ model: modelId });
      if (publish) query.set("publish", "1");
      const response = await fetch(`/api/carts/${cartId}?${query.toString()}`, {
        method: "PUT",
        headers: await authHeaders({ "Content-Type": "application/octet-stream" }),
        body: bytes.buffer as ArrayBuffer,
      });
      // The .tic must land before the sidecars, since their endpoints require
      // the cart row to exist. Only report success if everything wrote.
      let ok = response.ok;
      if (ok) {
        const headers = await authHeaders({ "Content-Type": "application/json" });
        const [rigResponse, fxResponse] = await Promise.all([
          fetch(`/api/carts/${cartId}/rig`, { method: "PUT", headers, body: JSON.stringify(rig) }),
          fetch(`/api/carts/${cartId}/fx`, { method: "PUT", headers, body: JSON.stringify(fx) }),
        ]);
        ok = rigResponse.ok && fxResponse.ok;
      }
      setSaveState(ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  };

  const saveLabel =
    saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : saveState === "error" ? "Retry save" : "Save";

  return (
    <div className={styles.workbench}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.wordmark} title="Back to the Cartbox home page">
          Cartbox
        </Link>
        <span className={styles.cartName}>{cartName}</span>
        <span className={styles.engineBadge} data-mode={mode}>
          {activeModel.label} · {mode === "wasm" ? "engine" : "offline stub"}
        </span>
        {modelDowngraded && (
          <span
            style={{ color: "#ff8a8a", fontSize: 12 }}
            title={`The ${requestedModel.label} engine failed to load; falling back to ${activeModel.label}.`}
          >
            ⚠ {requestedModel.label} unavailable — using {activeModel.label}
          </span>
        )}

        <div className={styles.bankStepper}>
          <span className={styles.bankLabel}>Bank</span>
          <button
            type="button"
            className={styles.bankArrow}
            onClick={() => selectBank(bank - 1)}
            disabled={bank === 0}
            aria-label="Previous bank"
          >
            ◂
          </button>
          <span className={`${styles.bankValue} data`}>{bank}</span>
          <button
            type="button"
            className={styles.bankArrow}
            onClick={() => selectBank(bank + 1)}
            disabled={bank === BANK_COUNT - 1}
            aria-label="Next bank"
          >
            ▸
          </button>
        </div>

        <nav className={styles.tabs} aria-label="Editors">
          {TABS.map((tab) => {
            const live = LIVE_TABS.has(tab);
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                className={`${styles.tab} ${active ? styles.tabActive : ""}`}
                aria-current={active ? "page" : undefined}
                disabled={!live}
                onClick={() => live && setActiveTab(tab)}
                title={live ? undefined : `${tab} editor — coming soon`}
              >
                {tab}
              </button>
            );
          })}
        </nav>

        <div className={styles.actions}>
          <button
            type="button"
            className="cbx-btn"
            onClick={() => runnable && setRunBytes(runnable.saveTic())}
            disabled={!runnable}
            title={runnable ? "Run this cartridge" : "Run needs the TIC-80 engine"}
          >
            Run
          </button>
          <button
            type="button"
            className="cbx-btn"
            onClick={() => void persist(false)}
            disabled={!runnable || saveState === "saving"}
            title={runnable ? "Save to your account" : "Save needs the TIC-80 engine"}
          >
            {saveLabel}
          </button>
          <button
            type="button"
            className="cbx-btn cbx-btn-accent"
            onClick={() => void persist(true)}
            disabled={!runnable || saveState === "saving"}
            title="Save and list in the marketplace"
          >
            Publish
          </button>
        </div>
      </header>

      {activeTab === "Code" && <CodeEditor doc={doc} />}
      {activeTab === "Sprites" && (
        <SpriteEditor
          key={bank}
          sheet={sheet}
          normals={normals}
          height={heightMap}
          specular={specularMap}
          roughness={roughnessMap}
          emissive={emissiveMap}
          rig={rig}
          onRigChange={setRig}
        />
      )}
      {activeTab === "Map" && <MapEditor key={bank} sheet={sheet} map={map} />}
      {activeTab === "FX" && <ShaderEditor key={bank} sheet={sheet} map={map} settings={fx} onSettingsChange={setFx} />}
      {activeTab === "SFX" && <SfxEditor key={bank} bank={soundBank} />}
      {activeTab === "Music" && <MusicEditor key={bank} tracker={tracker} />}

      {runBytes && (
        <RunOverlay
          bytes={runBytes}
          engineUrl={engineUrl}
          cartName={cartName}
          postFx={fx}
          onClose={() => setRunBytes(null)}
        />
      )}
    </div>
  );
}
