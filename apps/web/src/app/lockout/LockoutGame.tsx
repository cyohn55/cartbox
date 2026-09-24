"use client";

/**
 * The Lockout lobby and game. Solo mounts the cart offline (you + 7 bots). A
 * room joins a netplay session first — everyone in the room runs their own copy
 * of the cart, and the session relays each player's state and hits between
 * them — then mounts the cart with it: the first player in is the host, picks
 * the game type from the cart's own menu and simulates the bots; everyone else
 * joins the host's match automatically.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  mount,
  NetSession,
  parseMeshScene,
  parsePostFxSettings,
  type NetRoomStatus,
  type PlayerHandle,
} from "@cartbox/player";
import { LOCKOUT_FX, lockoutCartridge, lockoutMeshSidecar } from "@cartbox/editor";

import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { newRoomCode, onlineRoomsAvailable, parseRoomCode, roomTransport } from "@/lib/netplayTransport";

type Phase =
  | { kind: "lobby" }
  | { kind: "connecting"; room: string }
  | { kind: "playing"; room: string | null }
  | { kind: "error"; message: string };

export function LockoutGame() {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const sessionRef = useRef<NetSession | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "lobby" });
  const [room, setRoom] = useState<NetRoomStatus | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const online = onlineRoomsAvailable();

  // A shared link (?room=CODE) pre-fills the join box.
  useEffect(() => {
    const linked = parseRoomCode(new URLSearchParams(window.location.search).get("room"));
    if (linked) setJoinCode(linked);
  }, []);

  const teardown = useCallback(() => {
    handleRef.current?.destroy();
    handleRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    setRoom(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(
    async (roomCode: string | null) => {
      teardown();
      let session: NetSession | null = null;
      try {
        if (roomCode) {
          setPhase({ kind: "connecting", room: roomCode });
          session = new NetSession(await roomTransport("lockout", roomCode));
          sessionRef.current = session;
          session.onStatus(setRoom);
          await session.connect();
          const url = new URL(window.location.href);
          url.searchParams.set("room", roomCode);
          window.history.replaceState(null, "", url);
        }
        // Show the stage before mounting, so the player sizes to it.
        setPhase({ kind: "playing", room: roomCode });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const bytes = lockoutCartridge();
        const stage = stageRef.current;
        if (!stage) return;
        const cartUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
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
          netplay: session ?? undefined,
          onReady: () => URL.revokeObjectURL(cartUrl),
          onError: (error) => {
            teardown();
            setPhase({ kind: "error", message: error.message });
          },
        });
      } catch (error) {
        teardown();
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [teardown],
  );

  const leave = () => {
    teardown();
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
    setPhase({ kind: "lobby" });
  };

  const shareLink = phase.kind === "playing" && phase.room ? roomLink(phase.room) : null;
  const copyLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const joinable = parseRoomCode(joinCode);
  const inGame = phase.kind === "playing" || phase.kind === "connecting";

  return (
    <section>
      {!inGame && (
        <div className="cbx-panel" style={{ padding: 16, display: "grid", gap: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={() => void start(null)}>
              Play solo
            </button>
            <button type="button" className="cbx-btn" onClick={() => void start(newRoomCode())}>
              Create a room
            </button>
          </div>
          <form
            style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}
            onSubmit={(event) => {
              event.preventDefault();
              if (joinable) void start(joinable);
            }}
          >
            <label htmlFor="lockout-room" style={{ color: "var(--muted)" }}>
              Join a room
            </label>
            <input
              id="lockout-room"
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
          <p style={{ margin: 0, color: "var(--faint)", fontSize: 13 }}>
            {online
              ? "Rooms are online: share the link and anyone can join from their own browser. The first one in hosts and picks the game type."
              : "This build has no online relay, so a room connects the tabs of this browser only — open the link in another tab to try it."}
          </p>
          {phase.kind === "error" && (
            <p role="alert" style={{ margin: 0, color: "var(--live)" }}>
              {phase.message}
            </p>
          )}
        </div>
      )}

      {inGame && (
        <div
          className="cbx-panel"
          style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12 }}
        >
          {phase.room ? (
            <>
              <span>
                Room <strong style={{ fontFamily: "var(--font-data)", letterSpacing: 2 }}>{phase.room}</strong>
              </span>
              <span style={{ color: "var(--muted)" }}>{roomSummary(phase.kind === "connecting", room)}</span>
              {shareLink && (
                <button type="button" className="cbx-btn" onClick={() => void copyLink()}>
                  {copied ? "Link copied" : "Copy invite link"}
                </button>
              )}
            </>
          ) : (
            <span style={{ color: "var(--muted)" }}>Solo — you + 7 bots</span>
          )}
          <button type="button" className="cbx-btn" onClick={leave} style={{ marginLeft: "auto" }}>
            Leave
          </button>
        </div>
      )}

      <div
        ref={stageRef}
        style={{
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#000",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          display: inGame ? "block" : "none",
        }}
      />
      {inGame && (
        <p style={{ color: "var(--faint)", fontSize: 13 }}>
          Keyboard: Up/Down move · Left/Right turn · hold A to strafe · Z fire · X jump · S swap weapons · double-tap A
          to throw a grenade. Touch: left stick moves and strafes · right stick turns · A fire · B jump · X zoom (double-tap:
          grenade) · Y swap
        </p>
      )}
    </section>
  );
}

function roomLink(room: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", room);
  return url.toString();
}

function roomSummary(connecting: boolean, room: NetRoomStatus | null): string {
  if (connecting || !room?.connected) return "joining…";
  const people = room.peers.length;
  if (room.mySlot < 0) return "the room is full (8 players)";
  const role = room.isHost ? "you host" : `you are Player ${room.mySlot + 1}`;
  return `${people} ${people === 1 ? "person" : "people"} · ${role} · bots fill ${Math.max(0, 8 - people)} slot${8 - people === 1 ? "" : "s"}`;
}
