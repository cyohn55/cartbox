"use client";

/**
 * The console operating system — everything rendered inside the handheld's
 * screen. Runs the boot flow (boot loader → title → sign-in → homescreen) via
 * the pure consoleOsReducer, hosts the tab screens, and owns the full-screen
 * game session launched from Browse/Library.
 *
 * Shell-button conventions:
 *   D-pad moves the cursor · A activates · B backs out · L1/R1 (or SELECT)
 *   cycle tabs (SELECT ejects a running game) · START opens console settings.
 *   The tab bar is deliberately NOT a cursor region: pressing down at the
 *   bottom of a grid must stay in the grid, not wander onto the tabs.
 */

import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";

import { supabaseBrowser } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import {
  CONSOLE_TABS,
  INITIAL_CONSOLE_STATE,
  consoleOsReducer,
  type ConsoleTab,
  type PlayingCart,
} from "./consoleOs";
import { useConsoleInput, useConsoleInputBus } from "./ConsoleInputContext";
import { useConsoleSettings } from "./ConsoleSettingsContext";
import { useConsoleCursor } from "./useConsoleCursor";
import { BootScreen } from "./BootScreen";
import { TitleScreen } from "./TitleScreen";
import { AuthScreen } from "./AuthScreen";
import { GameScreen } from "./GameScreen";
import { PortedGameScreen } from "./PortedGameScreen";
import { ScummVmPlayer } from "./ScummVmPlayer";
import { SuperTuxPlayer } from "./SuperTuxPlayer";
import { DosPlayer } from "./DosPlayer";
import { QuakePlayer } from "./QuakePlayer";
import { Cube2Player } from "./Cube2Player";
import { HomeFeed } from "./HomeFeed";
import { BrowseScreen } from "./BrowseScreen";
import { LibraryScreen } from "./LibraryScreen";
import { ProfileScreen } from "./ProfileScreen";
import { SettingsScreen } from "./SettingsScreen";
import { CreateScreen } from "./CreateScreen";

const TAB_LABELS: Record<ConsoleTab, { icon: string; label: string }> = {
  feed: { icon: "▶", label: "FEED" },
  browse: { icon: "◆", label: "BROWSE" },
  create: { icon: "✎", label: "CREATE" },
  library: { icon: "▤", label: "LIBRARY" },
  profile: { icon: "●", label: "PROFILE" },
};

export function ConsoleOS() {
  const [state, dispatch] = useReducer(consoleOsReducer, INITIAL_CONSOLE_STATE);
  const [signedIn, setSignedIn] = useState(false);
  const bus = useConsoleInputBus();
  const { settings, panelOpen, setPanelOpen } = useConsoleSettings();
  const rootRef = useRef<HTMLDivElement>(null);

  // D-pad cursor across every screen that opts in via data-console-nav.
  useConsoleCursor(rootRef);

  // Resolve the existing session once so the title screen can skip sign-in.
  useEffect(() => {
    if (isStaticExport) {
      return;
    }
    let cancelled = false;
    supabaseBrowser()
      .auth.getSession()
      .then(({ data }) => {
        if (!cancelled) {
          setSignedIn(data.session !== null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // While a full-screen game runs, shell buttons drive the cartridge.
  useEffect(() => {
    bus.setGameForwarding(state.playing !== null);
    return () => bus.setGameForwarding(false);
  }, [bus, state.playing]);

  // Shoulder page-flip scrolls the active tab's content by most of a page. The
  // tab content owns its overflow, so scroll the first scrollable element within
  // the screen body, falling back to the body itself.
  const screenBodyRef = useRef<HTMLDivElement>(null);
  const pageActiveContent = (direction: -1 | 1) => {
    const root = screenBodyRef.current;
    if (!root) return;
    const scroller =
      root.scrollHeight > root.clientHeight + 4
        ? root
        : Array.from(root.querySelectorAll<HTMLElement>("*")).find((el) => el.scrollHeight > el.clientHeight + 4) ?? root;
    scroller.scrollBy({ top: direction * scroller.clientHeight * 0.85, behavior: "smooth" });
  };

  useConsoleInput((event) => {
    if (event.phase !== "press") {
      return;
    }

    // START toggles the settings panel wherever the UI owns the buttons
    // (boot/title keep their own start handling).
    if (event.control === "start" && bus.owner === "ui" && state.stage !== "boot" && state.stage !== "title") {
      setPanelOpen(!panelOpen);
      return;
    }

    if (state.stage !== "shell" || panelOpen) {
      return;
    }
    if (state.playing) {
      if (event.control === "select") {
        dispatch({ type: "EXIT_GAME" });
      }
      return;
    }
    // An in-feed game or the mini-game owns the buttons while active.
    if (bus.owner !== "ui") {
      return;
    }
    // The scroll wheel steps the tab bar; the shoulders page the active screen.
    if (event.control === "wheelDown") {
      dispatch({ type: "NEXT_TAB" });
    } else if (event.control === "wheelUp") {
      dispatch({ type: "PREVIOUS_TAB" });
    } else if (event.control === "r1" || event.control === "r2") {
      pageActiveContent(1);
    } else if (event.control === "l1" || event.control === "l2") {
      pageActiveContent(-1);
    }
  });

  const playCart = (cart: PlayingCart) => dispatch({ type: "PLAY_CART", cart });

  let stage: React.ReactNode;
  if (state.stage === "boot") {
    stage = <BootScreen onComplete={() => dispatch({ type: "BOOT_COMPLETE" })} />;
  } else if (state.stage === "title") {
    stage = <TitleScreen onContinue={() => dispatch({ type: "TITLE_CONTINUE", signedIn })} />;
  } else if (state.stage === "auth") {
    stage = (
      <AuthScreen
        onSignedIn={() => {
          setSignedIn(true);
          dispatch({ type: "AUTH_SUCCESS" });
        }}
        onGuest={() => dispatch({ type: "AUTH_GUEST" })}
      />
    );
  } else if (state.playing) {
    // Seven player kinds behind one launch/eject path: a ScummVM, SuperTux, DOS,
    // Quake or Cube 2 title in its own iframe, a Game ABI title on the wasm
    // runtime, or a .tic cartridge.
    const game = state.playing.game;
    if (game?.runtime === "scummvm") {
      stage = <ScummVmPlayer cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    } else if (game?.runtime === "supertux") {
      stage = <SuperTuxPlayer cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    } else if (game?.runtime === "dos") {
      stage = <DosPlayer cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    } else if (game?.runtime === "quake") {
      stage = <QuakePlayer cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    } else if (game?.runtime === "cube2") {
      stage = <Cube2Player cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    } else if (game) {
      stage = <PortedGameScreen cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    } else {
      stage = <GameScreen cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
    }
  } else {
    stage = (
      <div className="os-stage os-shell" data-testid="console-shell">
        <div className="os-screen-body" ref={screenBodyRef}>
          {state.tab === "feed" && <HomeFeed guest={!signedIn} onPlayCart={playCart} />}
          {state.tab === "browse" && <BrowseScreen onPlayCart={playCart} />}
          {state.tab === "create" && <CreateScreen />}
          {state.tab === "library" && <LibraryScreen guest={!signedIn} onPlayCart={playCart} />}
          {state.tab === "profile" && <ProfileScreen guest={!signedIn} />}
        </div>
        {/* Tabs stay tappable by touch but are stepped with the scroll wheel on
            the shell — no data-console-nav, so the D-pad cursor can never land
            here. */}
        <nav className="os-tabbar" aria-label="Console tabs">
          {CONSOLE_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className="os-tab"
              data-active={state.tab === tab}
              onClick={() => dispatch({ type: "SET_TAB", tab })}
            >
              <span className="os-tab-icon" aria-hidden>
                {TAB_LABELS[tab].icon}
              </span>
              {TAB_LABELS[tab].label}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  // The OS skin is a separate axis from the device shell theme. The phosphor
  // filter lives on `.os-content` so it monochrome-tints every screen (including
  // photographic feed content) uniformly; the CRT overlay is a sibling of that
  // wrapper so its scanlines and vignette are NOT re-tinted by the same filter.
  const pipboy = settings.osStyle === "pipboy";
  return (
    <div
      className="os-root"
      ref={rootRef}
      data-os-style={settings.osStyle}
      data-os-phosphor={settings.osPhosphor}
      data-os-scanlines={settings.osScanlines ? "on" : "off"}
      // A custom phosphor colour overrides the preset tint via the CSS variable
      // the preset rules also set, so the whole terminal glows in the chosen hue.
      style={settings.osPhosphorColor ? ({ "--os-phosphor": settings.osPhosphorColor } as CSSProperties) : undefined}
    >
      <div className="os-content">
        {stage}
        {panelOpen && <SettingsScreen onClose={() => setPanelOpen(false)} />}
      </div>
      {pipboy && <div className="os-crt" aria-hidden />}
    </div>
  );
}
