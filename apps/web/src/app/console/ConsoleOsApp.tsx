"use client";

/**
 * The console operating system — everything rendered inside the handheld's
 * screen. Runs the boot flow (boot loader → title → sign-in → homescreen) via
 * the pure consoleOsReducer, hosts the tab screens, and owns the full-screen
 * game session launched from Browse/Library.
 *
 * Shell-button conventions while on the homescreen:
 *   SELECT cycles tabs · A activates · SELECT exits a running game.
 */

import { useEffect, useReducer, useState } from "react";

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
import { BootScreen } from "./BootScreen";
import { TitleScreen } from "./TitleScreen";
import { AuthScreen } from "./AuthScreen";
import { GameScreen } from "./GameScreen";
import { HomeFeed } from "./HomeFeed";
import { BrowseScreen } from "./BrowseScreen";
import { LibraryScreen } from "./LibraryScreen";
import { ProfileScreen } from "./ProfileScreen";

const TAB_LABELS: Record<ConsoleTab, { icon: string; label: string }> = {
  feed: { icon: "▶", label: "FEED" },
  browse: { icon: "◆", label: "BROWSE" },
  library: { icon: "▤", label: "LIBRARY" },
  profile: { icon: "●", label: "PROFILE" },
};

export function ConsoleOS() {
  const [state, dispatch] = useReducer(consoleOsReducer, INITIAL_CONSOLE_STATE);
  const [signedIn, setSignedIn] = useState(false);
  const bus = useConsoleInputBus();

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

  useConsoleInput((event) => {
    if (event.phase !== "press" || state.stage !== "shell") {
      return;
    }
    if (state.playing) {
      if (event.control === "select") {
        dispatch({ type: "EXIT_GAME" });
      }
      return;
    }
    // An in-feed game owns the buttons while it's mounted (bus is forwarding).
    if (event.control === "select" && !bus.isForwardingToGame) {
      dispatch({ type: "NEXT_TAB" });
    }
  });

  const playCart = (cart: PlayingCart) => dispatch({ type: "PLAY_CART", cart });

  if (state.stage === "boot") {
    return <BootScreen onComplete={() => dispatch({ type: "BOOT_COMPLETE" })} />;
  }

  if (state.stage === "title") {
    return <TitleScreen onContinue={() => dispatch({ type: "TITLE_CONTINUE", signedIn })} />;
  }

  if (state.stage === "auth") {
    return (
      <AuthScreen
        onSignedIn={() => {
          setSignedIn(true);
          dispatch({ type: "AUTH_SUCCESS" });
        }}
        onGuest={() => dispatch({ type: "AUTH_GUEST" })}
      />
    );
  }

  if (state.playing) {
    return <GameScreen cart={state.playing} onExit={() => dispatch({ type: "EXIT_GAME" })} />;
  }

  return (
    <div className="os-stage os-shell" data-testid="console-shell">
      <div className="os-screen-body">
        {state.tab === "feed" && <HomeFeed guest={!signedIn} onPlayCart={playCart} />}
        {state.tab === "browse" && <BrowseScreen onPlayCart={playCart} />}
        {state.tab === "library" && (
          <LibraryScreen guest={!signedIn} onPlayCart={playCart} />
        )}
        {state.tab === "profile" && <ProfileScreen guest={!signedIn} />}
      </div>
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
