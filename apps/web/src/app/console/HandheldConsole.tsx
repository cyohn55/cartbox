"use client";

/**
 * The physical handheld: screen bezel plus controls — D-pad and/or virtual
 * joystick per the player's settings, four face buttons (A/B/X/Y), and
 * Start/Select. One DOM structure; CSS grid re-arranges it by orientation
 * (portrait = Game Boy stack, landscape = AYN Thor flanks — see console.css).
 *
 * Personalization lives here too: the selected theme/button colors apply as
 * data- attributes the stylesheet keys on, and the arcade theme docks a
 * mini-game behind the controls. Entering the Konami code (↑↑↓↓←→←→BA) hands
 * the controls to that game; SELECT hands them back.
 */

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

import "./console.css";
import {
  ConsoleInputBus,
  createWindowKeyDispatcher,
  type ConsoleControl,
} from "./consoleInput";
import { ConsoleInputContext, useConsoleInput } from "./ConsoleInputContext";
import { ConsoleSettingsProvider, useConsoleSettings } from "./ConsoleSettingsContext";
import { customColorStyle } from "./consoleSettings";
import { KonamiDetector } from "./consoleNavigation";
import { resolveMiniGame } from "./minigames/registry";
import { Joystick } from "./Joystick";
import { MiniGameDock } from "./MiniGameDock";

interface ShellButtonProps {
  bus: ConsoleInputBus;
  control: ConsoleControl;
  className: string;
  label: string;
  children?: ReactNode;
}

/**
 * A physical button. Pointer events (not click) so holds register the way a
 * real D-pad does; pointer capture keeps the release even when the thumb
 * slides off the button.
 */
function ShellButton({ bus, control, className, label, children }: ShellButtonProps) {
  const [pressed, setPressed] = useState(false);

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Programmatic pointer events carry no active pointer; capture is a
      // nicety for slid-off thumbs, never a reason to drop the press.
    }
    setPressed(true);
    bus.press(control);
  };

  const release = () => {
    if (!pressed) {
      return;
    }
    setPressed(false);
    bus.release(control);
  };

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      data-pressed={pressed || undefined}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      // Physical buttons must never steal the UI cursor's DOM focus.
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </button>
  );
}

function Shell({ bus, children }: { bus: ConsoleInputBus; children: ReactNode }) {
  const { settings, setPanelOpen } = useConsoleSettings();
  const konamiRef = useRef(new KonamiDetector());
  const [miniGameLive, setMiniGameLive] = useState(false);

  const miniGame = useMemo(() => resolveMiniGame(settings.miniGame, new Date()), [settings.miniGame]);
  const colorStyle = useMemo(() => customColorStyle(settings) as CSSProperties, [settings]);
  const showDpad = settings.controls === "dpad" || settings.controls === "both";
  const showJoystick = settings.controls === "joystick" || settings.controls === "both";
  // The dock idles (attract mode) on the arcade shell; the Konami code
  // summons it on any theme.
  const dockVisible = settings.theme === "arcade" || miniGameLive;

  useConsoleInput((event) => {
    if (event.phase === "press" && bus.owner === "ui" && konamiRef.current.feed(event.control)) {
      setMiniGameLive(true);
    }
  });

  const dpad = (compact = false) => (
    <div
      className={compact ? "hh-dpad hh-dpad-compact" : "hh-dpad"}
      role="group"
      aria-label="Directional pad"
    >
      <ShellButton bus={bus} control="up" className="hh-dpad-btn hh-dpad-up" label="Up">
        ▲
      </ShellButton>
      <ShellButton bus={bus} control="left" className="hh-dpad-btn hh-dpad-left" label="Left">
        ◀
      </ShellButton>
      <div className="hh-dpad-btn hh-dpad-center" aria-hidden />
      <ShellButton bus={bus} control="right" className="hh-dpad-btn hh-dpad-right" label="Right">
        ▶
      </ShellButton>
      <ShellButton bus={bus} control="down" className="hh-dpad-btn hh-dpad-down" label="Down">
        ▼
      </ShellButton>
    </div>
  );

  const faceButtons = (
    <div className="hh-face" role="group" aria-label="Action buttons">
      <ShellButton bus={bus} control="x" className="hh-face-btn hh-face-x" label="X button">
        X
      </ShellButton>
      <ShellButton bus={bus} control="y" className="hh-face-btn hh-face-y" label="Y button">
        Y
      </ShellButton>
      <ShellButton bus={bus} control="a" className="hh-face-btn hh-face-a" label="A button">
        A
      </ShellButton>
      <ShellButton bus={bus} control="b" className="hh-face-btn hh-face-b" label="B button">
        B
      </ShellButton>
    </div>
  );

  // Which directional control anchors a side cluster:
  //  - "Both": one on the side, the other compact in the system row; the swap
  //    setting exchanges them.
  //  - Single control: the swap setting flips handedness (directional right,
  //    face buttons left).
  const mainDirectional =
    showDpad && showJoystick
      ? settings.swapControls
        ? <Joystick bus={bus} />
        : dpad()
      : showDpad
        ? dpad()
        : <Joystick bus={bus} />;
  const systemDirectional =
    showDpad && showJoystick ? (settings.swapControls ? dpad(true) : <Joystick bus={bus} />) : null;
  const handednessSwapped = !(showDpad && showJoystick) && settings.swapControls;

  return (
    <div
      className="hh-root"
      data-theme={settings.theme}
      data-buttons={settings.buttons}
      style={colorStyle}
      // Long-press anywhere must never open a context menu / iOS callout.
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="hh-shell">
        <div className="hh-screen-bezel">
          <div className="hh-bezel-top">
            <span>CARTBOX</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="hh-gear"
                aria-label="Console settings"
                onClick={() => setPanelOpen(true)}
                onMouseDown={(event) => event.preventDefault()}
              >
                ⚙
              </button>
              <span className="hh-power-led" aria-hidden />
            </span>
          </div>
          <div className="hh-screen">{children}</div>
        </div>

        {dockVisible && (
          <MiniGameDock
            bus={bus}
            game={miniGame}
            active={miniGameLive}
            onExit={() => setMiniGameLive(false)}
          />
        )}

        <div className="hh-left">
          <div className="hh-shoulders">
            <ShellButton bus={bus} control="l1" className="hh-shoulder" label="L1">
              L1
            </ShellButton>
            <ShellButton bus={bus} control="l2" className="hh-shoulder" label="L2">
              L2
            </ShellButton>
          </div>
          {handednessSwapped ? faceButtons : mainDirectional}
        </div>

        <div className="hh-right">
          <div className="hh-shoulders">
            <ShellButton bus={bus} control="r2" className="hh-shoulder" label="R2">
              R2
            </ShellButton>
            <ShellButton bus={bus} control="r1" className="hh-shoulder" label="R1">
              R1
            </ShellButton>
          </div>
          {handednessSwapped ? mainDirectional : faceButtons}
        </div>

        <div className="hh-system">
          <ShellButton bus={bus} control="select" className="hh-pill" label="Select">
            SELECT
          </ShellButton>
          {systemDirectional}
          <ShellButton bus={bus} control="start" className="hh-pill" label="Start">
            START
          </ShellButton>
        </div>
      </div>
      <div className="hh-speaker" aria-hidden />
    </div>
  );
}

export function HandheldConsole({ children }: { children: ReactNode }) {
  // One bus per mounted console. The dispatcher only touches `window` when a
  // button actually fires, so constructing it during SSR is safe.
  const bus = useMemo(() => new ConsoleInputBus(createWindowKeyDispatcher()), []);

  return (
    <ConsoleInputContext.Provider value={bus}>
      <ConsoleSettingsProvider>
        <Shell bus={bus}>{children}</Shell>
      </ConsoleSettingsProvider>
    </ConsoleInputContext.Provider>
  );
}
