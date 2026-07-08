"use client";

/**
 * The physical handheld: screen bezel plus D-pad, four face buttons (A/B/X/Y),
 * and Start/Select. One DOM structure; CSS grid re-arranges it by orientation
 * (portrait = Game Boy stack, landscape = AYN Thor flanks — see console.css).
 *
 * Every control publishes press/release into the ConsoleInputBus, which the
 * console OS consumes for navigation and forwards to a running cartridge as
 * synthetic key events.
 */

import { useMemo, useState, type PointerEvent, type ReactNode } from "react";

import "./console.css";
import {
  ConsoleInputBus,
  createWindowKeyDispatcher,
  type ConsoleControl,
} from "./consoleInput";
import { ConsoleInputContext } from "./ConsoleInputContext";

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
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </button>
  );
}

export function HandheldConsole({ children }: { children: ReactNode }) {
  // One bus per mounted console. The dispatcher only touches `window` when a
  // button actually fires, so constructing it during SSR is safe.
  const bus = useMemo(() => new ConsoleInputBus(createWindowKeyDispatcher()), []);

  return (
    <ConsoleInputContext.Provider value={bus}>
      <div className="hh-root">
        <div className="hh-shell">
          <div className="hh-screen-bezel">
            <div className="hh-bezel-top">
              <span>CARTBOX</span>
              <span className="hh-power-led" aria-hidden />
            </div>
            <div className="hh-screen">{children}</div>
          </div>

          <div className="hh-left">
            <div className="hh-dpad" role="group" aria-label="Directional pad">
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
          </div>

          <div className="hh-right">
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
          </div>

          <div className="hh-system">
            <ShellButton bus={bus} control="select" className="hh-pill" label="Select">
              SELECT
            </ShellButton>
            <ShellButton bus={bus} control="start" className="hh-pill" label="Start">
              START
            </ShellButton>
          </div>
        </div>
        <div className="hh-speaker" aria-hidden />
      </div>
    </ConsoleInputContext.Provider>
  );
}
