"use client";

/**
 * The editor shell. It loads the TIC-80 WASM engine, loads the cart's stored
 * .tic into it (falling back to the demo seed), and backs every editor with that
 * one cartridge in WASM memory. Each editor is a view onto it (SpriteSheet,
 * TileMap, CodeDocument), so edits carry across tabs and serialise back to a
 * real .tic on Save/Publish. If the engine can't load, an in-memory stub keeps
 * the UI working. This chrome is custom Cartbox UI — the TIC-80 editor is not
 * shown.
 *
 * The shell also owns the three things a creator's trust rests on:
 *
 * - **Their work is not lost.** Every committed edit writes a crash-recovery
 *   draft to this browser; the Save button tells the truth about whether the
 *   current state has reached the server; and closing a dirty tab warns first.
 * - **A save is one write.** The sidecars go up as one bundle rather than
 *   eleven racing requests that could each half-fail.
 * - **A failure says why.** The server's own message is shown, and a 401 offers
 *   sign-in instead of an eternal "Retry save".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { defaultPostFxSettings, parseMeshScene, parseWorldScene, type AnimSpec, type MeshScene, type ParticleSpec, type PostFxSettings, type SceneSpec, type WorldScene } from "@cartbox/player";
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
  defaultMaterialSwatches,
  emptySpriteRig,
  loadWasmCartEngine,
  resolveStarter,
  type CollisionData,
  type ConsoleModelId,
  type FlagData,
  type MaterialSwatches,
  type SpriteRig,
} from "@cartbox/editor";

import { EditorDensityProvider, useDensityPreference } from "./editorDensity";
import type { CartMeta } from "@/lib/cartMeta";
import { DetailsPanel } from "./DetailsPanel";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { isStaticExport } from "@/lib/staticSite";
import { loadCartDraft, draftBytes } from "@/lib/localCartStore";
import { loadPendingVoxelEdit, clearPendingVoxelEdit, type PendingVoxelEdit } from "@/lib/backdropPropsStore";
import { decodeVoxelSidecar, mergeVoxelSidecar } from "@/lib/voxelSidecar";
import { emptySidecars, type Sidecars } from "@/lib/sidecars";
import type { WireMaterials } from "@/lib/materials";
import styles from "./editor.module.css";
import { MapEditor } from "./MapEditor";
import { CodeEditor } from "./CodeEditor";
import { SfxEditor } from "./SfxEditor";
import { MusicEditor } from "./MusicEditor";
import { RunOverlay } from "./RunOverlay";
import { SceneEditor } from "./SceneEditor";
import { AnimEditor } from "./AnimEditor";
import { ParticlesEditor } from "./ParticlesEditor";
import { ShaderEditor } from "./ShaderEditor";
import { AssetsEditor } from "./AssetsEditor";
import { MeshEditor } from "./MeshEditor";
import { WorldEditor } from "./WorldEditor";
import { useEditorHistory, snapshotsEqual, type CartSnapshot } from "./useEditorHistory";
import { saveCartLocally, saveCartToAccount, type SaveOutcome } from "./persistCart";
import { ShortcutHelp } from "./ShortcutHelp";
import { useShortcuts, WORKBENCH_SHORTCUTS, type Shortcut } from "./shortcuts";
import { decodeMeshSidecar, encodeMeshSidecar, addMesh, type MeshSidecar } from "@/lib/meshSidecar";
import type { MeshAsset } from "@cartbox/editor";

const TABS = ["Code", "Assets", "Map", "World", "Scene", "Mesh", "Anim", "Weather", "FX", "SFX", "Music"] as const;
type Tab = (typeof TABS)[number];

// The everyday five sit on the bar; the cinematic/3D set — reached rarely, and
// never before there is art to dress — tucks into a "More" menu so a cart opens
// looking like a fantasy-console editor, not a flight deck. Both draw from the
// same TABS, so the ordering above still governs the slot layout.
const PRIMARY_TABS: readonly Tab[] = ["Code", "Assets", "Map", "SFX", "Music"];
const MORE_TABS: readonly Tab[] = ["World", "Scene", "Mesh", "Anim", "Weather", "FX"];

// Tabs whose stage is a 3D viewport with its own camera controls. They have no
// phone layout — a pinch-zoom orbit camera inside a scrolling page fights the
// page — so on a small screen they say so rather than rendering something
// unusable. See the `smallScreenNotice` block in editor.module.css.
const SPATIAL_TABS: ReadonlySet<Tab> = new Set<Tab>(["World", "Mesh"]);

/** Ctrl+1..9 selects from the bar, then the More menu, in display order. */
const SHORTCUT_TAB_ORDER: readonly Tab[] = [...PRIMARY_TABS, ...MORE_TABS];

/** How long after the last edit the crash-recovery draft is written. */
const LOCAL_AUTOSAVE_MS = 1_500;
/** How long after the last edit an established session pushes to the server. */
const REMOTE_AUTOSAVE_MS = 10_000;

/**
 * Fallbacks for the three sidecars whose editors need a value rather than a
 * null. Module constants, not fresh objects per render, so an editor memoised
 * on its props does not rebuild every time the workbench re-renders.
 */
const DEFAULT_FX: PostFxSettings = defaultPostFxSettings();
const DEFAULT_RIG: SpriteRig = emptySpriteRig();
const DEFAULT_MATERIALS: MaterialSwatches = defaultMaterialSwatches();

type EngineMode = "wasm" | "stub";
type SaveState = "idle" | "saving" | "saved" | "error";

interface EditorWorkbenchProps {
  cartId: string;
  cartName: string;
  cartUrl: string | null;
  modelId: ConsoleModelId;
  /** Starter to seed a brand-new cart with; ignored once stored bytes load. */
  starterId: string;
  /** Every sidecar the cart carries, each null when it has none. */
  initialSidecars: Sidecars;
  /** Persisted marketplace description, or empty when none. */
  initialDescription: string;
  /** Persisted marketplace tags, or empty when none. */
  initialTags: string[];
}

export function EditorWorkbench({
  cartId,
  cartName,
  cartUrl,
  modelId,
  starterId,
  initialSidecars,
  initialDescription,
  initialTags,
}: EditorWorkbenchProps) {
  const [engine, setEngine] = useState<CartEngine | null>(null);
  const [mode, setMode] = useState<EngineMode>("wasm");

  // The model selects both the WASM core to load and the geometry every editor
  // surface reads (palette size, canvas, sound channels). Both come from modelId.
  const model = CONSOLE_MODELS[modelId];
  const engineUrl = ENGINE_URL_BY_MODEL[modelId];

  useEffect(() => {
    let active = true;
    // The engine that actually reached state, so unmount can free it. Without
    // this the cartridge — eight banks of tiles, sprites, map, SFX and music
    // plus a 512 KB code buffer — was orphaned in the WASM heap on every visit
    // to the editor, and WASM heaps never shrink.
    let live: CartEngine | null = null;

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
          live = loaded;
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
          live = stub;
          setEngine(stub);
          setMode("stub");
        }
      });

    return () => {
      active = false;
      live?.dispose();
      live = null;
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

  // A brand-new cart (no stored bytes) opened on a starter that ships a collision
  // layer — the Platformer — gets that layer as its initial collision, so its
  // cartbox.solid physics works the moment it opens. A saved cart keeps its own
  // (which is null here for a starter that authors none).
  const starterCollision = cartUrl ? null : resolveStarter(starterId).collision ?? null;
  const seeded: Sidecars = {
    ...initialSidecars,
    collision: initialSidecars.collision ?? starterCollision,
  };

  return (
    <WorkbenchBody
      engine={engine}
      cartId={cartId}
      cartName={cartName}
      mode={mode}
      modelId={modelId}
      engineUrl={engineUrl}
      initialSidecars={seeded}
      initialDescription={initialDescription}
      initialTags={initialTags}
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
  initialSidecars,
  initialDescription,
  initialTags,
}: {
  engine: CartEngine;
  cartId: string;
  cartName: string;
  mode: EngineMode;
  modelId: ConsoleModelId;
  engineUrl: string;
  initialSidecars: Sidecars;
  initialDescription: string;
  initialTags: string[];
}) {
  // requestedModel is what the URL/DB asked for; activeModel is what the loaded
  // engine actually provides (every editor surface reads geometry from this one).
  // They diverge when the requested core fails to load and we fall back to the
  // classic stub — surfaced in the badge so a silent downgrade is visible.
  const requestedModel = CONSOLE_MODELS[modelId];
  const activeModel = engine.model();
  const modelDowngraded = requestedModel.id !== activeModel.id;

  // Run/Save need real .tic bytes, which only the WASM engine can serialise.
  const runnable = engine instanceof WasmCartEngine ? engine : null;

  // The cart's marketplace details (title, description, tags). Held here so the
  // Details panel can edit them and Save/Publish can persist them; the title also
  // drives the header name and the .tic's first-save row.
  const [details, setDetails] = useState<CartMeta>({
    title: cartName,
    description: initialDescription,
    tags: initialTags,
  });

  // What the server (or, in the demo build, this browser) last accepted. Dirty
  // state is the difference between this and the live timeline, which is what
  // makes "Saved ✓" honest: it used to stick forever after one successful save,
  // no matter how much was edited afterwards.
  const savedSnapshotRef = useRef<CartSnapshot | null>(null);
  const savedMetaRef = useRef<CartMeta | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<{ message: string; canSignIn: boolean } | null>(null);
  const [skippedLayers, setSkippedLayers] = useState<string[]>([]);
  // True once a save to the account has succeeded, which proves the creator is
  // signed in and owns this cart. Only then does autosave push to the server —
  // otherwise a signed-out creator would generate a 401 every ten seconds.
  const remoteSaveProvenRef = useRef(false);

  const metaEqual = (a: CartMeta | null, b: CartMeta): boolean =>
    a !== null &&
    a.title === b.title &&
    a.description === b.description &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index]);

  // One undo/redo timeline for every tab, carrying the cart bytes and every
  // sidecar. `editEngine` is the same live cart memory as `engine`, wrapped so
  // edits feed the history.
  const historyRef = useRef<{ current: () => CartSnapshot | null } | null>(null);
  const detailsRef = useRef(details);
  detailsRef.current = details;

  const evaluateDirty = useCallback(() => {
    const now = historyRef.current?.current() ?? null;
    const saved = savedSnapshotRef.current;
    const clean = now !== null && saved !== null && snapshotsEqual(now, saved) && metaEqual(savedMetaRef.current, detailsRef.current);
    setDirty(!clean);
    // A save label that says "Saved ✓" over unsaved work is a lie; the moment
    // the timeline moves away from what was saved, the button says Save again.
    if (!clean) setSaveState((state) => (state === "saved" ? "idle" : state));
  }, []);

  const history = useEditorHistory({
    engine,
    runnable,
    initialSidecars,
    initialBank: 0,
    onCommit: evaluateDirty,
  });
  historyRef.current = history;

  const {
    engine: editEngine,
    revision,
    bank,
    setBank: selectBank,
    sidecars,
    setSidecar,
    canUndo,
    canRedo,
    undo,
    redo,
  } = history;

  // Undo and redo move the timeline without committing, so dirty state has to be
  // re-derived from the new present.
  useEffect(() => {
    evaluateDirty();
  }, [revision, details, evaluateDirty]);

  // Named views onto the sidecar bundle, so each editor keeps the prop it had.
  const fx = sidecars.fx ?? DEFAULT_FX;
  const rig = (sidecars.rig as SpriteRig | null) ?? DEFAULT_RIG;
  const materials = (sidecars.materials as MaterialSwatches | null) ?? DEFAULT_MATERIALS;
  const { voxel, scene, anim, particles, collision, flags } = sidecars;

  const setFx = useCallback((next: PostFxSettings) => setSidecar("fx", next), [setSidecar]);
  const setRig = useCallback((next: SpriteRig) => setSidecar("rig", next as never), [setSidecar]);
  const setMaterials = useCallback((next: MaterialSwatches) => setSidecar("materials", next as never), [setSidecar]);
  const setVoxel = useCallback((next: string) => setSidecar("voxel", next), [setSidecar]);
  const setScene = useCallback((next: SceneSpec | null) => setSidecar("scene", next), [setSidecar]);
  const setAnim = useCallback((next: AnimSpec | null) => setSidecar("anim", next), [setSidecar]);
  const setParticles = useCallback((next: ParticleSpec | null) => setSidecar("particles", next), [setSidecar]);
  const setCollision = useCallback((next: CollisionData | null) => setSidecar("collision", next), [setSidecar]);
  const setFlags = useCallback((next: FlagData | null) => setSidecar("flags", next), [setSidecar]);

  // Meshes and the HD-2D world are stored as opaque strings and authored as
  // decoded objects. Decoding is memoised on the string — geometry is not free
  // — and both now ride the undo timeline like every other sidecar, so deleting
  // a mesh or flattening terrain is recoverable.
  const mesh = useMemo<MeshSidecar>(() => decodeMeshSidecar(sidecars.mesh), [sidecars.mesh]);
  const setMesh = useCallback(
    (update: MeshSidecar | ((current: MeshSidecar) => MeshSidecar)) => {
      const next = typeof update === "function" ? update(decodeMeshSidecar(sidecars.mesh)) : update;
      setSidecar("mesh", encodeMeshSidecar(next));
    },
    [sidecars.mesh, setSidecar],
  );
  const meshScene = useMemo<MeshScene | null>(() => parseMeshScene(sidecars.mesh), [sidecars.mesh]);
  const world = useMemo<WorldScene | null>(() => parseWorldScene(sidecars.world), [sidecars.world]);
  const setWorld = useCallback(
    (next: WorldScene | null) => setSidecar("world", next ? JSON.stringify(next) : null),
    [setSidecar],
  );
  const [worldBrushHeight, setWorldBrushHeight] = useState(1);

  /**
   * "The cart in engine memory was replaced": an undo, a redo, or a bank
   * switch. Every tab that caches something read from the engine watches this
   * and re-reads.
   *
   * It used to be a React `key`, which remounted the whole tab — so undoing one
   * pencil stroke also threw away the map camera, the open SFX sample, the code
   * editor's scroll position and every tool selection. A tab that re-reads keeps
   * the creator where they were.
   */
  const resyncKey = `${bank}:${revision}`;

  const sheet = useMemo(() => new SpriteSheet(editEngine), [editEngine]);
  const map = useMemo(() => new TileMap(editEngine), [editEngine]);
  const doc = useMemo(() => new CodeDocument(editEngine), [editEngine]);
  const soundBank = useMemo(() => new SoundBank(editEngine), [editEngine]);
  const tracker = useMemo(() => new MusicTracker(editEngine), [editEngine]);
  const normals = useMemo(() => new NormalMap(editEngine), [editEngine]);
  const heightMap = useMemo(() => new MaterialMap(editEngine, "height"), [editEngine]);
  const specularMap = useMemo(() => new MaterialMap(editEngine, "specular"), [editEngine]);
  const roughnessMap = useMemo(() => new MaterialMap(editEngine, "roughness"), [editEngine]);
  const emissiveMap = useMemo(() => new MaterialMap(editEngine, "emissive"), [editEngine]);
  // The Map tab's voxel/hexel columns ride in the same payload as the Voxel
  // tab's sculpt (see voxelSidecar). Composing the two here — rather than in
  // either editor — is what keeps one tab's save from dropping the other's work.
  const mapColumns = useMemo(() => decodeVoxelSidecar(voxel).mapLayer, [voxel]);
  const setMapColumns = useCallback(
    (serialized: string) => setVoxel(mergeVoxelSidecar(voxel, { mapLayer: serialized })),
    [voxel, setVoxel],
  );

  // A voxel prop handed over from the backdrop manager to re-sculpt: open on the
  // Voxel tab, seed it with that model, and consume the hand-off once.
  const [pendingVoxel] = useState<PendingVoxelEdit | null>(() =>
    typeof window !== "undefined" ? loadPendingVoxelEdit() : null,
  );
  const [activeTab, setActiveTab] = useState<Tab>("Assets");
  useEffect(() => {
    if (pendingVoxel) clearPendingVoxelEdit();
  }, [pendingVoxel]);

  // Turn the current voxel sculpt into a placed mesh: add it to the sidecar and
  // jump to the Mesh tab so the creator sees (and can transform) the result.
  const exportVoxelMesh = useCallback(
    (asset: MeshAsset, name: string) => {
      setMesh((current) => addMesh(current, asset, name).sidecar);
      setActiveTab("Mesh");
    },
    [setMesh],
  );

  const [runBytes, setRunBytes] = useState<Uint8Array | null>(null);
  // The line a Lua runtime error blamed, carried from the playtest to the Code
  // tab so "it crashed" and "here is where" are one click apart.
  const [runtimeErrorLine, setRuntimeErrorLine] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Collapse either side panel to give the stage more width. Workbench-level
  // flags (via data attributes) so one chevron each hides whichever tab's rail /
  // inspector is showing, without threading a prop to every editor.
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [railHidden, setRailHidden] = useState(false);

  // How much of each tab's controls show at rest, persisted across sessions, and
  // whether the "More" tab menu is open. Both are chrome state, not cart content.
  const [density, setDensity] = useDensityPreference();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_TABS.includes(activeTab);

  // ---- saving -------------------------------------------------------------

  const buildRequest = useCallback(
    (publish: boolean) => {
      if (!runnable) return null;
      return {
        cartId,
        modelId,
        bytes: runnable.saveTic(),
        sidecars,
        meta: details,
        publish,
      };
    },
    [cartId, details, modelId, runnable, sidecars],
  );

  const markSaved = useCallback(() => {
    savedSnapshotRef.current = historyRef.current?.current() ?? null;
    savedMetaRef.current = detailsRef.current;
    setDirty(false);
  }, []);

  const applyOutcome = useCallback(
    (outcome: SaveOutcome) => {
      if (outcome.ok) {
        markSaved();
        setSaveState("saved");
        setSaveError(null);
        setSkippedLayers(outcome.skipped);
        return true;
      }
      setSaveState("error");
      setSaveError({ message: outcome.message, canSignIn: outcome.reason === "auth" });
      return false;
    },
    [markSaved],
  );

  const persist = useCallback(
    async (publish: boolean) => {
      const request = buildRequest(publish);
      if (!request) return;
      setSaveState("saving");
      // The static demo build has no API — Save lands in this browser's
      // localStorage instead (the same payload the server would persist).
      if (isStaticExport) {
        applyOutcome(saveCartLocally({ ...request, saved: true }));
        return;
      }
      const outcome = await saveCartToAccount(request);
      if (applyOutcome(outcome)) remoteSaveProvenRef.current = true;
      // Whatever the server said, keep a local copy so a failed save is not a
      // lost afternoon.
      saveCartLocally({ ...request, saved: outcome.ok });
    },
    [applyOutcome, buildRequest],
  );

  // Seed the saved mark once, from the cart as it opened: a freshly loaded cart
  // is by definition not dirty.
  useEffect(() => {
    if (savedSnapshotRef.current === null && savedMetaRef.current === null) {
      const opening = historyRef.current?.current() ?? null;
      if (opening) {
        savedSnapshotRef.current = opening;
        savedMetaRef.current = detailsRef.current;
      }
    }
  }, [revision]);

  // Autosave. The local draft is written soon after every edit — it costs no
  // network and it is what makes a crashed tab survivable. The server copy
  // follows more slowly, and only once a manual save has proved the session can
  // write this cart.
  useEffect(() => {
    if (!dirty || !runnable) return undefined;
    const localTimer = window.setTimeout(() => {
      const request = buildRequest(false);
      if (request) saveCartLocally({ ...request, saved: false });
    }, LOCAL_AUTOSAVE_MS);

    let remoteTimer: number | undefined;
    if (!isStaticExport && remoteSaveProvenRef.current) {
      remoteTimer = window.setTimeout(() => {
        void (async () => {
          const request = buildRequest(false);
          if (!request) return;
          setSaveState("saving");
          applyOutcome(await saveCartToAccount(request));
        })();
      }, REMOTE_AUTOSAVE_MS);
    }

    return () => {
      window.clearTimeout(localTimer);
      if (remoteTimer !== undefined) window.clearTimeout(remoteTimer);
    };
  }, [applyOutcome, buildRequest, dirty, runnable]);

  // Closing the tab on unsaved work asks first. The browser shows its own
  // wording; returnValue is what makes the prompt appear at all.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // An unsaved draft left behind by a crashed tab or an expired session. Offered
  // rather than applied: a creator who abandoned that draft should not have it
  // resurrected under them.
  const [recovery, setRecovery] = useState<{ savedAt: string } | null>(null);
  useEffect(() => {
    if (isStaticExport || !runnable) return;
    const draft = loadCartDraft(cartId);
    if (draft && !draft.saved) setRecovery({ savedAt: draft.savedAt });
  }, [cartId, runnable]);

  const restoreDraft = useCallback(() => {
    const draft = loadCartDraft(cartId);
    if (!draft || !runnable) return;
    runnable.loadTic(draftBytes(draft));
    for (const [key, value] of Object.entries(draft.sidecars)) {
      setSidecar(key as keyof Sidecars, value as never);
    }
    setDetails(draft.meta.title ? draft.meta : detailsRef.current);
    setRecovery(null);
  }, [cartId, runnable, setSidecar]);

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Retry save"
        : saveState === "saved" && !dirty
          ? "Saved ✓"
          : dirty
            ? "Save •"
            : "Save";

  // Export the exact in-memory cartridge as a .tic file the creator can back up,
  // share, or open in real TIC-80. Named from the cart title so downloads are
  // legible rather than a raw uuid.
  const downloadCart = useCallback(() => {
    if (!runnable) return;
    const bytes = runnable.saveTic();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const safeName =
      (details.title || "cartridge").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      "cartridge";
    anchor.download = `${safeName}.tic`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [details.title, runnable]);

  const runCart = useCallback(() => {
    if (runnable) setRunBytes(runnable.saveTic());
  }, [runnable]);

  // ---- shortcuts ----------------------------------------------------------

  const bindings = useMemo<ReadonlyArray<readonly [Shortcut, () => void]>>(() => {
    const tabBindings = SHORTCUT_TAB_ORDER.slice(0, 9).map(
      (tab, index) =>
        [
          { key: String(index + 1), mod: true, label: `${tab} tab`, group: "Navigation" } as Shortcut,
          () => setActiveTab(tab),
        ] as const,
    );
    return [
      [WORKBENCH_SHORTCUTS.save, () => void persist(false)],
      [WORKBENCH_SHORTCUTS.run, runCart],
      [WORKBENCH_SHORTCUTS.download, downloadCart],
      [WORKBENCH_SHORTCUTS.redo, redo],
      [WORKBENCH_SHORTCUTS.redoAlt, redo],
      [WORKBENCH_SHORTCUTS.undo, undo],
      [WORKBENCH_SHORTCUTS.details, () => setShowDetails(true)],
      [WORKBENCH_SHORTCUTS.help, () => setShowHelp((open) => !open)],
      ...tabBindings,
    ];
  }, [downloadCart, persist, redo, runCart, undo]);

  // The playtest overlay takes the keyboard while it is open — the cart itself
  // is reading those keys.
  useShortcuts(bindings, runBytes === null);

  // ---- the "More" menu ----------------------------------------------------

  // The menu is positioned with fixed viewport coordinates because the tab strip
  // scrolls horizontally, which makes it an overflow-clipping box that would
  // clip an absolutely-positioned dropdown away. Fixed escapes that clip — but
  // then nothing moves the menu when the page does, so it is re-measured on
  // scroll and resize rather than positioned once and stranded.
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [moreMenuPos, setMoreMenuPos] = useState<{ top: number; left: number } | null>(null);

  const measureMore = useCallback(() => {
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) setMoreMenuPos({ top: rect.bottom + 4, left: rect.left });
  }, []);

  useEffect(() => {
    if (!moreOpen) return undefined;
    measureMore();
    const onScroll = () => measureMore();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [measureMore, moreOpen]);

  return (
    <EditorDensityProvider value={density}>
    <div
      className={styles.workbench}
      data-inspector={inspectorHidden ? "hidden" : undefined}
      data-rail={railHidden ? "hidden" : undefined}
      data-spatial={SPATIAL_TABS.has(activeTab) ? "true" : undefined}
    >
      <header className={styles.topbar}>
        <Link href="/" className={styles.wordmark} title="Back to the Cartbox home page">
          Cartbox
        </Link>
        <button
          type="button"
          className={styles.cartNameButton}
          onClick={() => setShowDetails(true)}
          title="Edit this cartridge's title, description and tags"
        >
          <span className={styles.cartName}>{details.title || "Untitled cartridge"}</span>
          <span className={styles.cartNameEdit} aria-hidden>
            ✎
          </span>
        </button>
        <span className={styles.engineBadge} data-mode={mode}>
          {activeModel.label} · {mode === "wasm" ? "engine" : "offline stub"}
        </span>
        {modelDowngraded && (
          <span
            className={styles.downgradeBadge}
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
          {PRIMARY_TABS.map((tab) => {
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                className={`${styles.tab} ${active ? styles.tabActive : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            );
          })}

          {/* The cinematic/3D tabs behind one menu. It names the active one when
              the creator is inside it, so "which tab am I on" survives the fold. */}
          <div className={styles.moreTab}>
            <button
              ref={moreButtonRef}
              type="button"
              className={`${styles.tab} ${moreActive ? styles.tabActive : ""}`}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
              onBlur={() => setMoreOpen(false)}
            >
              {moreActive ? `More · ${activeTab}` : "More"} ▾
            </button>
            {moreOpen && moreMenuPos && (
              <div
                className={styles.moreMenu}
                role="menu"
                style={{ top: moreMenuPos.top, left: moreMenuPos.left }}
              >
                {MORE_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="menuitem"
                    className={`${styles.moreMenuItem} ${tab === activeTab ? styles.moreMenuItemActive : ""}`}
                    // onMouseDown, not onClick: the button's onBlur closes the
                    // menu first otherwise, and the click never lands.
                    onMouseDown={() => {
                      setActiveTab(tab);
                      setMoreOpen(false);
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className={styles.actions}>
          {/* One lever over every tab's advanced controls: Simple folds them to a
              heading each, Full opens them. Persists across sessions. */}
          <button
            type="button"
            className="cbx-btn"
            onClick={() => setDensity(density === "simple" ? "full" : "simple")}
            aria-pressed={density === "full"}
            title={
              density === "simple"
                ? "Simple: advanced controls are folded away. Switch to Full to show them all."
                : "Full: every control is shown. Switch to Simple to fold the advanced ones away."
            }
          >
            {density === "simple" ? "Simple" : "Full"}
          </button>
          <div className={styles.historyGroup}>
            <button
              type="button"
              className="cbx-btn"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              ↶
            </button>
            <button
              type="button"
              className="cbx-btn"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              ↷
            </button>
          </div>
          <button
            type="button"
            className="cbx-btn"
            onClick={() => setShowHelp(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          <button
            type="button"
            className="cbx-btn"
            onClick={() => setShowDetails(true)}
            title="Edit title, description and tags (Ctrl+I)"
          >
            Details
          </button>
          <button
            type="button"
            className="cbx-btn"
            onClick={runCart}
            disabled={!runnable}
            title={runnable ? "Run this cartridge (Ctrl+Enter)" : "Run needs the TIC-80 engine"}
          >
            Run
          </button>
          <button
            type="button"
            className="cbx-btn"
            onClick={downloadCart}
            disabled={!runnable}
            title={runnable ? "Download this cartridge as a .tic file" : "Download needs the TIC-80 engine"}
          >
            Download
          </button>
          <button
            type="button"
            className="cbx-btn"
            data-dirty={dirty ? "true" : undefined}
            onClick={() => void persist(false)}
            disabled={!runnable || saveState === "saving"}
            title={runnable ? "Save to your account (Ctrl+S)" : "Save needs the TIC-80 engine"}
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

      {/* A failed save says what went wrong, in the server's own words, and
          offers the one action that can fix the common case. */}
      {saveError && (
        <div className={styles.saveBanner} data-tone="error" role="alert">
          <span>{saveError.message}</span>
          {saveError.canSignIn && (
            <Link href="/login" className="cbx-btn">
              Sign in
            </Link>
          )}
          <button type="button" className={styles.bannerDismiss} onClick={() => setSaveError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* A save that landed everywhere except a column this deployment has not
          migrated yet. Silence here would let a creator believe work was stored
          that was not. */}
      {skippedLayers.length > 0 && (
        <div className={styles.saveBanner} data-tone="warn" role="status">
          <span>Saved, but this server cannot store {skippedLayers.join(" and ")} yet — that work stays in this browser.</span>
          <button type="button" className={styles.bannerDismiss} onClick={() => setSkippedLayers([])}>
            Dismiss
          </button>
        </div>
      )}

      {recovery && (
        <div className={styles.saveBanner} data-tone="info" role="status">
          <span>Unsaved changes from {new Date(recovery.savedAt).toLocaleString()} are stored in this browser.</span>
          <button type="button" className="cbx-btn" onClick={restoreDraft}>
            Restore them
          </button>
          <button type="button" className={styles.bannerDismiss} onClick={() => setRecovery(null)}>
            Discard
          </button>
        </div>
      )}

      {/* Chevron tabs on each side panel's inner edge, centred over the body.
          They live at the workbench level — not inside the panels — so they stay
          reachable to reopen a panel after it is hidden. */}
      <button
        type="button"
        className={styles.railToggle}
        onClick={() => setRailHidden((hidden) => !hidden)}
        aria-pressed={railHidden}
        aria-label={railHidden ? "Show the left panel" : "Hide the left panel"}
        title={railHidden ? "Show the left panel" : "Hide the left panel"}
      >
        <span aria-hidden>{railHidden ? "›" : "‹"}</span>
      </button>
      <button
        type="button"
        className={styles.inspectorToggle}
        onClick={() => setInspectorHidden((hidden) => !hidden)}
        aria-pressed={inspectorHidden}
        aria-label={inspectorHidden ? "Show the inspector" : "Hide the inspector"}
        title={inspectorHidden ? "Show the inspector" : "Hide the inspector"}
      >
        <span aria-hidden>{inspectorHidden ? "‹" : "›"}</span>
      </button>

      {SPATIAL_TABS.has(activeTab) && (
        <p className={styles.smallScreenNotice}>
          The {activeTab} tab is a 3D viewport with its own orbit camera — it needs a larger screen than this
          one. Everything else in the cartridge edits fine here.
        </p>
      )}

      {activeTab === "Code" && <CodeEditor doc={doc} revision={revision} errorLine={runtimeErrorLine} />}
      {activeTab === "Assets" && (
        <AssetsEditor
          sheet={sheet}
          normals={normals}
          height={heightMap}
          specular={specularMap}
          roughness={roughnessMap}
          emissive={emissiveMap}
          swatches={materials}
          onSwatchesChange={setMaterials}
          rig={rig}
          onRigChange={setRig}
          voxel={voxel}
          onVoxelChange={setVoxel}
          bank={bank}
          revision={revision}
          pendingVoxel={pendingVoxel}
          onExportVoxelMesh={exportVoxelMesh}
        />
      )}
      {activeTab === "Map" && (
        <MapEditor
          resyncKey={resyncKey}
          sheet={sheet}
          map={map}
          columnPayload={mapColumns}
          onColumnsChange={setMapColumns}
          collision={collision}
          onCollisionChange={setCollision}
          flags={flags}
          onFlagsChange={setFlags}
          normals={normals}
          height={heightMap}
          specular={specularMap}
          roughness={roughnessMap}
          emissive={emissiveMap}
          swatches={materials}
        />
      )}
      {activeTab === "Scene" && (
        <SceneEditor
          sheet={sheet}
          width={activeModel.width}
          height={activeModel.height}
          scene={scene}
          onSceneChange={setScene}
          revision={revision}
        />
      )}
      {activeTab === "Mesh" && <MeshEditor key="mesh" sidecar={mesh} onSidecarChange={setMesh} />}
      {activeTab === "World" && (
        <WorldEditor
          key="world"
          world={world}
          onChange={setWorld}
          brushHeight={worldBrushHeight}
          onBrushHeightChange={setWorldBrushHeight}
        />
      )}
      {activeTab === "Anim" && (
        <AnimEditor
          sheet={sheet}
          width={activeModel.width}
          height={activeModel.height}
          scene={scene}
          anim={anim}
          onAnimChange={setAnim}
          revision={revision}
        />
      )}
      {activeTab === "Weather" && (
        <ParticlesEditor
          width={activeModel.width}
          height={activeModel.height}
          particles={particles}
          onParticlesChange={setParticles}
        />
      )}
      {activeTab === "FX" && (
        <ShaderEditor
          resyncKey={resyncKey}
          sheet={sheet}
          map={map}
          columnPayload={mapColumns}
          settings={fx}
          onSettingsChange={setFx}
        />
      )}
      {activeTab === "SFX" && <SfxEditor bank={soundBank} revision={resyncKey} />}
      {activeTab === "Music" && <MusicEditor tracker={tracker} bank={soundBank} revision={resyncKey} />}

      {showDetails && (
        <DetailsPanel details={details} onChange={setDetails} onClose={() => setShowDetails(false)} />
      )}

      {showHelp && <ShortcutHelp tabs={SHORTCUT_TAB_ORDER.slice(0, 9)} onClose={() => setShowHelp(false)} />}

      {runBytes && (
        <RunOverlay
          bytes={runBytes}
          engineUrl={engineUrl}
          cartName={details.title || cartName}
          postFx={fx}
          scene={scene ?? undefined}
          anim={anim ?? undefined}
          particles={particles ?? undefined}
          collision={collision ?? undefined}
          flags={flags ?? undefined}
          mesh={meshScene ?? undefined}
          world={world ?? undefined}
          onGoToLine={(line) => {
            setRuntimeErrorLine(line);
            setRunBytes(null);
            setActiveTab("Code");
          }}
          onClose={() => setRunBytes(null)}
        />
      )}
    </div>
    </EditorDensityProvider>
  );
}
