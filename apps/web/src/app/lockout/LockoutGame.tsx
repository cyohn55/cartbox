"use client";

/**
 * Lockout: the lobby, and the game full screen.
 *
 * Play opens the game's title screen — the game types against bots, and
 * Matchmaking, which asks this page (cartbox.request) to find people online:
 * the page's Matchmaker joins or opens a public room and moves the running
 * game's netplay session into it. A private room (create / join a code) works
 * as before. Start — a controller's Start, the touch pad's Start button, or
 * Enter / P — opens the Start menu (controls, button mapping, audio, display);
 * offline it pauses the game, online the match keeps going underneath.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  mount,
  NetSession,
  SwitchableTransport,
  parseMeshScene,
  parsePostFxSettings,
  type MailboxEvent,
  type NetRoomStatus,
  type PlayerHandle,
} from "@cartbox/player";
import { LOCKOUT_FX, lockoutCartridge, lockoutMeshSidecar } from "@cartbox/editor";

import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { newRoomCode, onlineRoomsAvailable, parseRoomCode, roomTransport } from "@/lib/netplayTransport";
import { MM_FAILED, MM_SEARCHING, createMatchmaker, type Matchmaker } from "@/lib/matchmaking";
import { LOCKOUT_ACTIONS, loadGameSettings, saveGameSettings, type GameSettings } from "@/lib/gameSettings";
import { StartMenu } from "./StartMenu";

/** cartbox.request kinds the Lockout cart sends. */
const REQ_MATCHMAKE = 1;
const REQ_CANCEL = 2;

type Phase = { kind: "lobby" } | { kind: "playing" } | { kind: "error"; message: string };

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
  const [settings, setSettings] = useState<GameSettings>(() => loadGameSettings("lockout", null));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [fps, setFps] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const online = onlineRoomsAvailable();

  // Stored settings (after hydration), and a shared link (?room=CODE) pre-filling the join box.
  useEffect(() => {
    setSettings(loadGameSettings("lockout"));
    const linked = parseRoomCode(new URLSearchParams(window.location.search).get("room"));
    if (linked) setJoinCode(linked);
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

  // Frame-rate readout.
  useEffect(() => {
    if (!settings.showFps || phase.kind !== "playing") {
      setFps(null);
      return;
    }
    const timer = window.setInterval(() => {
      setFps(framesRef.current);
      framesRef.current = 0;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [settings.showFps, phase.kind]);

  const openMenu = useCallback((open: boolean) => {
    const handle = handleRef.current;
    setMenuOpen(open);
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
  };

  const onCartRequest = useCallback((event: MailboxEvent) => {
    if (event.kind !== "request") return;
    const matchmaker = matchmakerRef.current;
    if (!matchmaker) return;
    if (event.id === REQ_MATCHMAKE) void matchmaker.search(event.value === 0 ? "any" : event.value - 1);
    if (event.id === REQ_CANCEL) void matchmaker.cancel();
  }, []);

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
        const stage = stageRef.current;
        if (!stage) return;
        const bytes = lockoutCartridge();
        const cartUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
        const current = settingsRef.current;
        handleRef.current = mount(stage, {
          cartUrl,
          engineUrl: ENGINE_URL_BY_MODEL.xbox360,
          modelId: "xbox360",
          autostart: true,
          record: false,
          controls: "auto",
          scale: "fit",
          // No 2D relight: the arena's 3D rig lights it (and its objectives glow
          // through cartbox.light3d), and skipping the 2D lighting layer spares
          // every frame a material capture and a full-screen relight pass.
          postFx: parsePostFxSettings(LOCKOUT_FX) ?? undefined,
          mesh: parseMeshScene(lockoutMeshSidecar()) ?? undefined,
          netplay: session,
          controlSettings: current.controls,
          volume: current.muted ? 0 : current.volume,
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
      } catch (error) {
        teardown();
        void exitFullscreen();
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [teardown, openMenu, onCartRequest],
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
          <p style={{ margin: 0, color: "var(--faint)", fontSize: 13 }}>
            Plays full screen. Xbox 360 / Xbox controllers work (left stick moves, right stick aims, Start for the menu), as
            do touch and the keyboard (Enter or P for the menu).{" "}
            {online
              ? "Matchmaking and rooms are online."
              : "This build has no online relay, so matchmaking and rooms connect the tabs of this browser only."}
          </p>
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
            <button type="button" aria-label="Menu" style={{ ...chip, cursor: "pointer", marginLeft: "auto", pointerEvents: "auto" }} onClick={() => openMenu(true)}>
              ≡ Menu
            </button>
          </div>
        )}
        {playing && menuOpen && (
          <StartMenu
            settings={settings}
            onChange={applySettings}
            actions={LOCKOUT_ACTIONS}
            online={inRoom()}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => void (isFullscreen ? exitFullscreen() : enterFullscreen(wrapperRef.current))}
            onClose={() => openMenu(false)}
            onLeave={() => void leaveRoom()}
            onQuit={quit}
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
    // Landscape where the platform allows locking it (Android, in full screen).
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {});
  } catch {
    // Not allowed (no gesture, iPhone Safari): the game still fills the window.
  }
}

async function exitFullscreen(): Promise<void> {
  const doc = document as FullscreenDocument;
  if (!fullscreenElement()) return;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    // Already out.
  }
}
