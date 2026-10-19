"use client";

/**
 * Lockout: the lobby, and the game full screen.
 *
 * Play opens the game's title screen — the game types against bots, and
 * Matchmaking, which asks this page (cartbox.request) to find people online:
 * the page's Matchmaker joins or opens a public room and moves the running
 * game's netplay session into it. A private room (create / join a code) works
 * as before. Start — a controller's Start (or Back / Guide), the touch pad's
 * Start button, the ≡ Menu button, or Esc / Enter / P — opens the Start menu
 * (controls, button mapping, audio, display); offline it pauses the game,
 * online the match keeps going underneath.
 *
 * `?assets=<cart id>` plays a Lockout cart saved in the editor in this browser
 * with its own Spartans, viewmodels and pickups (L13; see lockoutAssets.ts).
 *
 * `?map=<id>` picks the map (BEAVER_CREEK_ROADMAP.md B2; see arenaMaps.ts).
 * Only that map's sidecar loads. The title menu's map choice asks this page
 * (REQ_MAP) to load another, and so does a guest whose host plays another:
 * the game is mounted again on the new map, in the same netplay session.
 *
 * `?map=cart:<cart id>` plays an arena map marked up in the editor and saved
 * in this browser (EDITOR_PRO_ROADMAP.md P7; see savedArena.ts), against bots.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  mount,
  NetSession,
  SwitchableTransport,
  parseMeshScene,
  readSidecarUi, readSidecarActions,
  parsePostFxSettings,
  type MailboxEvent,
  type NetRoomStatus,
  type PlayerHandle,
} from "@cartbox/player";
import { ARENA_MAPS, LOCKOUT_INPUT_ACTIONS, LOCKOUT_STRINGS, arenaMap, arenaMapCartridge, lockoutCartridge } from "@cartbox/editor";
import { preferredLanguages, readPlayerPrefs, writePlayerPrefs, type PlayerPrefs } from "@/lib/accessibilityPrefs";

import { DIRECT_CORE_URL, ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { newRoomCode, onlineRoomsAvailable, parseRoomCode, roomTransport } from "@/lib/netplayTransport";
import { MM_FAILED, MM_SEARCHING, createMatchmaker, type Matchmaker } from "@/lib/matchmaking";
import { LOCKOUT_ACTIONS, loadGameSettings, saveGameSettings, type GameSettings } from "@/lib/gameSettings";
import { StartMenu, type Tab as MenuTab } from "./StartMenu";
import { browserStorage, readLocalSave, saveKey, writeLocalSave } from "@/lib/saveData";
import { basePath } from "@/lib/staticSite";
import { fetchStandaloneParts, standaloneHtml, standaloneZip, type StandaloneGame } from "@/lib/standaloneExport";
import { loadCartDraft } from "@/lib/localCartStore";
import { lockoutSidecarWithAssets, type LockoutAssetOverlay } from "@/lib/lockoutAssets";
import { perfLine } from "@/lib/perfReadout";
import { playableArena } from "@/lib/savedArena";
import { loadKtx2Decoder } from "@/lib/ktx2Decoder";

/** Where Lockout keeps its career record (it has no cart row, so it stays in this browser). */
const LOCKOUT_SAVE_KEY = saveKey("lockout");

/** cartbox.request kinds the Lockout cart sends. */
const REQ_MATCHMAKE = 1;
const REQ_CANCEL = 2;
const REQ_MAP = 3;

/** A saved arena's map id (`cart:<cart id>`, P7), or null for one of the shipped maps. */
function savedCartId(mapId: string): string | null {
  const m = /^cart:([\w-]{1,64})$/.exec(mapId);
  return m ? m[1]! : null;
}

const savedGames = new Map<string, { json: string; cart: (boot: string) => Uint8Array; name: string }>();

/** A saved arena, made playable once per load (its navmesh bakes); throws, with why, when it can't be. */
function savedGame(cartId: string): { json: string; cart: (boot: string) => Uint8Array; name: string } {
  const known = savedGames.get(cartId);
  if (known) return known;
  const made = playableArena(loadCartDraft(cartId)?.sidecars.mesh);
  if ("problem" in made) throw new Error(made.problem);
  const scene = parseMeshScene(made.json);
  if (!scene) throw new Error("That arena's scene doesn't load.");
  const code = made.code(scene.bounds.center);
  const game = { json: made.json, cart: (boot: string) => lockoutCartridge(boot ? `${code}\n${boot}` : code), name: made.map.name };
  savedGames.set(cartId, game);
  return game;
}

/** A map's cartridge, with `boot` appended (a shipped map's, or a saved arena's). */
function mapCartridge(mapId: string, boot: string): Uint8Array {
  const saved = savedCartId(mapId);
  return saved ? savedGame(saved).cart(boot) : arenaMapCartridge(mapId, boot);
}

/** A map as a standalone export (EP18): plays against bots with no server. */
function lockoutStandalone(mapId: string): StandaloneGame {
  const saved = savedCartId(mapId);
  if (saved) {
    const game = savedGame(saved);
    return { title: `Lockout: ${game.name}`, cartId: `lockout-${saved}`, modelId: "xbox360", cart: game.cart(""), postFx: ARENA_MAPS[0]!.fx, mesh: game.json };
  }
  const map = arenaMap(mapId);
  const title = map.id === "lockout" ? "Lockout" : `Lockout: ${map.name}`;
  return { title, cartId: map.id === "lockout" ? "lockout" : `lockout-${map.id}`, modelId: "xbox360", cart: arenaMapCartridge(map.id), postFx: map.fx, mesh: map.sidecar() };
}

/** The map `?map=` names (Lockout when none, or one it doesn't know; a saved arena as `cart:<id>`). */
function urlMapId(): string {
  const raw = new URLSearchParams(window.location.search).get("map");
  if (raw && savedCartId(raw)) return raw;
  return arenaMap(raw).id;
}

type Phase = { kind: "lobby" } | { kind: "playing" } | { kind: "error"; message: string };

/** The cart named by `?assets=`, whose saved assets the demo plays (null for the demo's own). */
function assetsCartId(): string | null {
  const id = new URLSearchParams(window.location.search).get("assets");
  return id && /^[\w-]{1,64}$/.test(id) ? id : null;
}

/** A map's scene, with the `?assets=` cart's saved Spartans, viewmodels and pickups laid in. */
function lockoutScene(mapId: string): { json: string; overlay: LockoutAssetOverlay | null } {
  const saved = savedCartId(mapId);
  if (saved) return { json: savedGame(saved).json, overlay: null };
  const id = assetsCartId();
  return lockoutSidecarWithAssets(arenaMap(mapId).sidecar(), id ? (loadCartDraft(id)?.sidecars.mesh ?? null) : null);
}

export function LockoutGame() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const sessionRef = useRef<NetSession | null>(null);
  const switcherRef = useRef<SwitchableTransport | null>(null);
  const matchmakerRef = useRef<Matchmaker | null>(null);
  const framesRef = useRef(0);
  const [phase, setPhase] = useState<Phase>({ kind: "lobby" });
  const [privateRoom, setPrivateRoom] = useState<string | null>(null);
  const [room, setRoom] = useState<NetRoomStatus | null>(null);
  const [mm, setMm] = useState<{ code: number; room: string | null }>({ code: 0, room: null });
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The Start menu tab to open on next (the Touch tab, back from moving the touch controls). */
  const [menuTab, setMenuTab] = useState<MenuTab | undefined>(undefined);
  const [settings, setSettings] = useState<GameSettings>(() => loadGameSettings("lockout", null));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [fps, setFps] = useState<number | null>(null);
  /** With the frame rate, where each frame's time goes (the player's profiler). */
  const [perf, setPerf] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** How to open the menu, shown for a few seconds when a game starts. */
  const [menuHint, setMenuHint] = useState(false);
  const online = onlineRoomsAvailable();
  /** The `?assets=` cart's assets: what was laid in, and what kept the demo's model (L13). */
  const [assets, setAssets] = useState<{ cart: string; overlay: LockoutAssetOverlay | null } | null>(null);
  /** The map to play (`?map=`, B2): the game is mounted on it, and again on another when the cart asks. */
  const [mapId, setMapId] = useState<string>(ARENA_MAPS[0]!.id);
  const mapRef = useRef(mapId);
  mapRef.current = mapId;

  // Stored settings (after hydration), and a shared link (?room=CODE) pre-filling the join box.
  useEffect(() => {
    setSettings(loadGameSettings("lockout"));
    const linked = parseRoomCode(new URLSearchParams(window.location.search).get("room"));
    if (linked) setJoinCode(linked);
    const assetsCart = assetsCartId();
    const map = urlMapId();
    setMapId(map);
    if (assetsCart && !savedCartId(map)) setAssets({ cart: assetsCart, overlay: lockoutScene(map).overlay });
    const onFs = () => setIsFullscreen(Boolean(fullscreenElement()));
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  const inRoom = () => switcherRef.current?.current != null;

  const teardown = useCallback(() => {
    handleRef.current?.destroy();
    handleRef.current = null;
    matchmakerRef.current?.close();
    matchmakerRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    switcherRef.current = null;
    setRoom(null);
    setPrivateRoom(null);
    setMm({ code: 0, room: null });
    setMenuOpen(false);
  }, []);

  useEffect(() => teardown, [teardown]);

  // While playing, the page doesn't scroll under the full-screen game.
  useEffect(() => {
    if (phase.kind !== "playing") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [phase.kind]);

  useEffect(() => {
    if (phase.kind !== "playing") return;
    setMenuHint(true);
    const timer = window.setTimeout(() => setMenuHint(false), 8000);
    return () => window.clearTimeout(timer);
  }, [phase.kind]);

  // Frame-rate readout, with where each frame's time goes.
  useEffect(() => {
    if (!settings.showFps || phase.kind !== "playing") {
      setFps(null);
      setPerf(null);
      return;
    }
    handleRef.current?.setProfiling(true);
    const timer = window.setInterval(() => {
      setFps(framesRef.current);
      framesRef.current = 0;
      const handle = handleRef.current;
      if (handle) {
        handle.setProfiling(true); // (the player may have been mounted since)
        setPerf(perfLine(handle.profile(), handle.quality()));
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
      handleRef.current?.setProfiling(false);
    };
  }, [settings.showFps, phase.kind]);

  const openMenu = useCallback((open: boolean) => {
    const handle = handleRef.current;
    setMenuOpen(open);
    if (open) setMenuHint(false);
    else setMenuTab(undefined); // the next opening starts on the first tab again
    if (!handle) return;
    if (inRoom()) handle.setInputEnabled(!open);
    else if (open) handle.pause();
    else handle.resume();
  }, []);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;

  const applySettings = (next: GameSettings) => {
    setSettings(next);
    saveGameSettings("lockout", next);
    handleRef.current?.setControlSettings(next.controls);
    handleRef.current?.setVolume(next.muted ? 0 : next.volume);
    handleRef.current?.setQuality(next.quality);
  };

  /**
   * Move and resize the touch pad's controls: the menu steps aside (the game
   * stays paused, or online its input held), the player arranges the pad and
   * saves, and the menu comes back on its Touch tab.
   */
  const editTouchLayout = async () => {
    const handle = handleRef.current;
    if (!handle) return;
    setMenuOpen(false);
    const layout = await handle.editTouchLayout();
    if (layout) applySettings({ ...settingsRef.current, controls: { ...settingsRef.current.controls, touchLayout: layout } });
    setMenuTab("touch");
    setMenuOpen(true);
  };

  /** Mounts the game on another map, in the same netplay session (the cart's REQ_MAP: B2). */
  const switchMapRef = useRef<(id: string) => void>(() => {});
  const onCartRequest = useCallback((event: MailboxEvent) => {
    if (event.kind !== "request") return;
    if (event.id === REQ_MAP) {
      const next = ARENA_MAPS[event.value];
      if (next) switchMapRef.current(next.id);
      return;
    }
    const matchmaker = matchmakerRef.current;
    if (!matchmaker) return;
    if (event.id === REQ_MATCHMAKE) void matchmaker.search(event.value === 0 ? "any" : event.value - 1);
    if (event.id === REQ_CANCEL) void matchmaker.cancel();
  }, []);

  /**
   * Mounts the game on `map` in `session`, into the stage already shown, with
   * `boot` appended to its code for this load.
   */
  const mountGame = useCallback(
    async (session: NetSession, map: string, boot: string) => {
      const stage = stageRef.current;
      if (!stage) return;
      const bytes = mapCartridge(map, boot);
      const scene = lockoutScene(map).json;
      const cartUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
      const current = settingsRef.current;
      handleRef.current = mount(stage, {
        cartUrl,
        engineUrl: ENGINE_URL_BY_MODEL.xbox360,
        // ?core=direct tries Lockout on the dedicated Modern core (EP20b).
        ...(new URLSearchParams(window.location.search).get("core") === "direct" ? { core: "direct" as const, directCoreUrl: DIRECT_CORE_URL } : {}),
        modelId: "xbox360",
        // ?present=gpu presents the frame from the GPU, as the AAA tier does (AAA_FIDELITY_ROADMAP.md F0a);
        // ?hdr=1 shades it in linear light too (F0b).
        ...(new URLSearchParams(window.location.search).get("present") === "gpu" ? { gpuPresent: true } : {}),
        ...(new URLSearchParams(window.location.search).get("hdr") === "1" ? { gpuPresent: true, linearHdr: true, prepass: true, mipmaps: true, nativeResolution: true, dynamicResolution: true } : {}),
        // KTX2: the transcoder loads only if a texture needs it — Beaver Creek's baked images, on a renderer that samples compressed formats (F1a).
        ktx2: loadKtx2Decoder,
        autostart: true,
        record: false,
        controls: "auto",
        scale: "fit",
        // No 2D relight: the arena's 3D rig lights it (and its objectives glow
        // through cartbox.light3d), and skipping the 2D lighting layer spares
        // every frame a material capture and a full-screen relight pass.
        postFx: parsePostFxSettings(savedCartId(map) ? ARENA_MAPS[0]!.fx : arenaMap(map).fx) ?? undefined,
        mesh: parseMeshScene(scene) ?? undefined,
        ui: readSidecarUi(scene),
        actions: readSidecarActions(scene),
        // Its string table in the player's language, and their accessibility settings (EP19b).
        strings: LOCKOUT_STRINGS,
        languages: preferredLanguages(prefsRef.current),
        accessibility: prefsRef.current,
        // The career record (EP15b), kept in this browser.
        saveData: readLocalSave(browserStorage(), LOCKOUT_SAVE_KEY)?.data ?? null,
        onSave: (data) => writeLocalSave(browserStorage(), LOCKOUT_SAVE_KEY, data, new Date().toISOString()),
        netplay: session,
        controlSettings: current.controls,
        volume: current.muted ? 0 : current.volume,
        quality: current.quality,
        onStart: () => openMenu(!menuOpenRef.current),
        onEvent: onCartRequest,
        onFrame: () => {
          framesRef.current += 1;
        },
        onReady: () => URL.revokeObjectURL(cartUrl),
        onError: (error) => {
          teardown();
          setPhase({ kind: "error", message: error.message });
        },
      });
    },
    [teardown, openMenu, onCartRequest],
  );

  // The cart asked for another map (its menu, or a guest following its host):
  // mount the game again on it, keeping the room (B2).
  switchMapRef.current = (id: string) => {
    const session = sessionRef.current;
    if (!session || id === mapRef.current) return;
    handleRef.current?.destroy();
    handleRef.current = null;
    mapRef.current = id;
    setMapId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("map", id);
    window.history.replaceState(null, "", url);
    mountGame(session, id, "MAP_SWITCHED = true").catch((error: unknown) => {
      teardown();
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
  };

  const start = useCallback(
    async (roomCode: string | null) => {
      // Full screen first, while the click still counts as a user gesture.
      if (settingsRef.current.fullscreen) void enterFullscreen(wrapperRef.current);
      teardown();
      try {
        const switcher = new SwitchableTransport();
        const session = new NetSession(switcher);
        switcherRef.current = switcher;
        sessionRef.current = session;
        session.onStatus(setRoom);
        await session.connect();
        matchmakerRef.current = await createMatchmaker("lockout", switcher, session, (status) => setMm(status));
        if (roomCode) {
          await switcher.use(await roomTransport("lockout", roomCode));
          setPrivateRoom(roomCode);
          const url = new URL(window.location.href);
          url.searchParams.set("room", roomCode);
          window.history.replaceState(null, "", url);
        }
        // Show the stage before mounting, so the player sizes to it.
        setPhase({ kind: "playing" });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await mountGame(session, mapRef.current, "");
      } catch (error) {
        teardown();
        void exitFullscreen();
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [teardown, mountGame],
  );

  /** Leave the online room (matchmade or private); the game drops back to its title screen. */
  const leaveRoom = async () => {
    openMenu(false);
    await matchmakerRef.current?.cancel();
    await switcherRef.current?.use(null);
    sessionRef.current?.resetRoom();
    setPrivateRoom(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
  };

  const quit = () => {
    teardown();
    void exitFullscreen();
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
    setPhase({ kind: "lobby" });
  };

  const copyLink = async () => {
    if (!privateRoom) return;
    try {
      await navigator.clipboard.writeText(roomLink(privateRoom));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const joinable = parseRoomCode(joinCode);
  const playing = phase.kind === "playing";
  // Accessibility and language (EP19b): kept for every game; the colour filter applies at once.
  const [prefs, setPrefs] = useState<PlayerPrefs>(() => readPlayerPrefs(null));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => setPrefs(readPlayerPrefs(browserStorage())), []);
  const changePrefs = (next: PlayerPrefs) => {
    setPrefs(next);
    writePlayerPrefs(browserStorage(), next);
    handleRef.current?.setAccessibility(next);
    handleRef.current?.setLanguages(preferredLanguages(next));
  };
  // The offline copy (EP18): one HTML file, or a zip that installs as an app.
  const [exporting, setExporting] = useState<"html" | "zip" | "error" | null>(null);
  const downloadOffline = async (format: "html" | "zip") => {
    setExporting(format);
    try {
      const game = lockoutStandalone(mapRef.current);
      const parts = await fetchStandaloneParts(game, { engineUrl: ENGINE_URL_BY_MODEL.xbox360, basePath });
      const file =
        format === "html"
          ? new Blob([standaloneHtml(game, parts)], { type: "text/html" })
          : new Blob([standaloneZip(game, parts).buffer as ArrayBuffer], { type: "application/zip" });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = format === "html" ? "lockout.html" : "lockout.zip";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExporting(null);
    } catch {
      setExporting("error");
    }
  };

  return (
    <section>
      {!playing && (
        <div className="cbx-panel" style={{ padding: 16, display: "grid", gap: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={() => void start(null)} style={{ fontSize: 18, padding: "10px 22px" }}>
              Play
            </button>
            <span style={{ color: "var(--muted)" }}>Title screen: game types vs bots, and Matchmaking to play people online.</span>
          </div>
          {savedCartId(mapId) && (
            <span style={{ color: "var(--muted)" }}>
              Map: the arena saved in cart {savedCartId(mapId)} in this browser (against bots: online, guests would load their own map).
            </span>
          )}
          {ARENA_MAPS.length > 1 && !savedCartId(mapId) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }} role="radiogroup" aria-label="Map">
              <span style={{ color: "var(--muted)" }}>Map:</span>
              {ARENA_MAPS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === mapId}
                  className={m.id === mapId ? "cbx-btn cbx-btn-accent" : "cbx-btn"}
                  onClick={() => {
                    setMapId(m.id);
                    const url = new URL(window.location.href);
                    url.searchParams.set("map", m.id);
                    window.history.replaceState(null, "", url);
                  }}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span style={{ color: "var(--muted)" }}>Private room:</span>
            <button type="button" className="cbx-btn" onClick={() => void start(newRoomCode())}>
              Create
            </button>
            <form
              style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}
              onSubmit={(event) => {
                event.preventDefault();
                if (joinable) void start(joinable);
              }}
            >
              <input
                aria-label="Room code"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="CODE"
                maxLength={8}
                autoComplete="off"
                spellCheck={false}
                style={{
                  width: 120,
                  font: "inherit",
                  fontFamily: "var(--font-data)",
                  letterSpacing: 2,
                  padding: "6px 10px",
                  background: "var(--well)",
                  color: "var(--text)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                }}
              />
              <button type="submit" className="cbx-btn" disabled={!joinable}>
                Join
              </button>
            </form>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span style={{ color: "var(--muted)" }}>Play offline:</span>
            <button type="button" className="cbx-btn" disabled={exporting === "html" || exporting === "zip"} onClick={() => void downloadOffline("html")}>
              {exporting === "html" ? "Preparing…" : "Download HTML"}
            </button>
            <button type="button" className="cbx-btn" disabled={exporting === "html" || exporting === "zip"} onClick={() => void downloadOffline("zip")}>
              {exporting === "zip" ? "Preparing…" : "Download app (.zip)"}
            </button>
            <span style={{ color: "var(--faint)", fontSize: 13 }}>
              {exporting === "error" ? "The download couldn't be prepared — try again." : "Vs bots, no connection needed. The zip installs as an app from any HTTPS host."}
            </span>
          </div>
          <p style={{ margin: 0, color: "var(--faint)", fontSize: 13 }}>
            Plays full screen. Xbox 360 / Xbox controllers work (left stick moves, right stick aims, Start for the menu), as
            do touch and the keyboard (Esc, Enter or P for the menu).{" "}
            {online
              ? "Matchmaking and rooms are online."
              : "This build has no online relay, so matchmaking and rooms connect the tabs of this browser only."}
          </p>
          {assets && (
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
              {!assets.overlay
                ? `No cart "${assets.cart}" is saved in this browser, so the demo plays its own Spartans and weapons.`
                : assets.overlay.replaced.length === 0
                  ? "The saved cart's Spartans, weapons and pickups are the demo's own."
                  : `Playing your edited assets from the saved cart: ${assets.overlay.replaced.length} object${assets.overlay.replaced.length === 1 ? "" : "s"}.`}
              {assets.overlay?.refused.map((r) => ` ${r.id} keeps the demo's model: ${r.reason}`).join("")}
            </p>
          )}
          {phase.kind === "error" && (
            <p role="alert" style={{ margin: 0, color: "var(--live)" }}>
              {phase.message}
            </p>
          )}
        </div>
      )}

      {/* The game: fixed over the whole window (and full screen when allowed). */}
      <div
        ref={wrapperRef}
        style={
          playing
            ? { position: "fixed", inset: 0, zIndex: 1000, background: "#000" }
            : { display: "none" }
        }
      >
        <div ref={stageRef} style={{ position: "absolute", inset: 0, display: "flex" }} />
        {playing && (
          <div style={chipBar}>
            <span style={chip}>{statusLine(privateRoom, room, mm)}</span>
            {privateRoom && (
              <button type="button" style={{ ...chip, cursor: "pointer" }} onClick={() => void copyLink()}>
                {copied ? "Link copied" : "Copy invite link"}
              </button>
            )}
            {fps !== null && <span style={chip}>{fps} fps</span>}
            {perf !== null && <span style={{ ...chip, fontSize: 11 }}>{perf}</span>}
            {menuHint && !menuOpen && (
              <span role="status" style={{ ...chip, marginLeft: "auto", background: "rgba(10,12,20,0.8)" }}>
                Menu: Start on a controller · Esc or P · or tap ≡ Menu
              </span>
            )}
            <button
              type="button"
              aria-label="Menu"
              style={{ ...chip, cursor: "pointer", marginLeft: menuHint && !menuOpen ? 0 : "auto", pointerEvents: "auto", fontSize: 14, padding: "6px 14px" }}
              onClick={() => openMenu(true)}
            >
              ≡ Menu
            </button>
          </div>
        )}
        {playing && menuOpen && (
          <StartMenu
            settings={settings}
            onChange={applySettings}
            actions={LOCKOUT_ACTIONS}
            inputActions={LOCKOUT_INPUT_ACTIONS}
            lookGain
            online={inRoom()}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => void (isFullscreen ? exitFullscreen() : enterFullscreen(wrapperRef.current))}
            onClose={() => openMenu(false)}
            onLeave={() => void leaveRoom()}
            onQuit={quit}
            quality={handleRef.current?.quality()}
            prefs={prefs}
            onPrefsChange={changePrefs}
            languages={LOCKOUT_STRINGS.languages}
            initialTab={menuTab}
            onEditTouchLayout={handleRef.current?.touchControls ? () => void editTouchLayout() : undefined}
          />
        )}
      </div>
    </section>
  );
}

const chipBar: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  right: 8,
  display: "flex",
  gap: 8,
  alignItems: "center",
  pointerEvents: "none",
  zIndex: 10,
};
const chip: React.CSSProperties = {
  pointerEvents: "auto",
  padding: "4px 10px",
  borderRadius: 999,
  background: "rgba(10,12,20,0.55)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "rgba(255,255,255,0.85)",
  font: "600 12px/1.2 system-ui, sans-serif",
};

function statusLine(privateRoom: string | null, room: NetRoomStatus | null, mm: { code: number; room: string | null }): string {
  if (mm.code === MM_SEARCHING) return "Matchmaking — searching…";
  if (mm.code === MM_FAILED) return "Matchmaking unavailable";
  const people = room?.peers.length ?? 0;
  if (people > 0 && room) {
    const label = privateRoom ? `Room ${privateRoom}` : "Matchmaking";
    const role = room.mySlot < 0 ? "room full" : room.isHost ? "you host" : `Player ${room.mySlot + 1}`;
    return `${label} · ${people} ${people === 1 ? "player" : "players"} · ${role}`;
  }
  return "Offline";
}

function roomLink(room: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", room);
  return url.toString();
}

/** Chrome's Keyboard Lock: in full screen, Escape reaches the page (to open the menu) and exiting takes a long press. */
type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
const keyboardLock = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function enterFullscreen(element: HTMLElement | null): Promise<void> {
  if (!element || fullscreenElement()) return;
  const el = element as FullscreenElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else await el.webkitRequestFullscreen?.();
    await keyboardLock()?.lock?.(["Escape"]).catch(() => {});
    // Landscape where the platform allows locking it (Android, in full screen).
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {});
  } catch {
    // Not allowed (no gesture, iPhone Safari): the game still fills the window.
  }
}

async function exitFullscreen(): Promise<void> {
  const doc = document as FullscreenDocument;
  keyboardLock()?.unlock?.();
  if (!fullscreenElement()) return;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    // Already out.
  }
}
