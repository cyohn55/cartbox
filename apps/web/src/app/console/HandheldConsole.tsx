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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

import "./console.css";
import {
  ConsoleInputBus,
  createWindowKeyDispatcher,
  type ConsoleControl,
} from "./consoleInput";
import { renderHandheld, type HandheldScheme, type HandheldTemplate } from "@cartbox/editor";

import { ConsoleInputContext, useConsoleInput } from "./ConsoleInputContext";
import { ConsoleSettingsProvider, useConsoleSettings } from "./ConsoleSettingsContext";
import { HandheldSkinProvider, useHandheldSkin } from "./HandheldSkinContext";
import { customColorStyle } from "./consoleSettings";
import { loadHandheldTemplateHiRes } from "@/lib/handheldTemplate";
import { handheldAssetUrl } from "@/lib/handheldAssets";
import { sliceSheet } from "@/lib/handheldSheet";
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
  /** Inline positioning, used by the image shell to place transparent hit-areas. */
  style?: CSSProperties;
}

/**
 * A physical button. Pointer events (not click) so holds register the way a
 * real D-pad does; pointer capture keeps the release even when the thumb
 * slides off the button.
 */
function ShellButton({ bus, control, className, label, children, style }: ShellButtonProps) {
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
      style={style}
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

/** A control's placement on the handheld art, as 0..1 fractions of the device. */
interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HandheldLayout {
  aspect: number;
  screen: LayoutRect;
  dpad: LayoutRect;
  buttons: { y: LayoutRect; a: LayoutRect; x: LayoutRect; b: LayoutRect };
  shoulders: { l: LayoutRect; r: LayoutRect };
  system: { select: LayoutRect; start: LayoutRect };
}

const rectStyle = (rect: LayoutRect): CSSProperties => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.w * 100}%`,
  height: `${rect.h * 100}%`,
});

/** Split the D-pad box into four directional hit-zones (centre stays neutral). */
function dpadZones(dpad: LayoutRect): Array<{ control: ConsoleControl; rect: LayoutRect; label: string }> {
  const armLong = 0.42;
  const armShort = 0.4;
  return [
    { control: "up", label: "Up", rect: { x: dpad.x + dpad.w * 0.3, y: dpad.y, w: dpad.w * armShort, h: dpad.h * armLong } },
    { control: "down", label: "Down", rect: { x: dpad.x + dpad.w * 0.3, y: dpad.y + dpad.h * (1 - armLong), w: dpad.w * armShort, h: dpad.h * armLong } },
    { control: "left", label: "Left", rect: { x: dpad.x, y: dpad.y + dpad.h * 0.3, w: dpad.w * armLong, h: dpad.h * armShort } },
    { control: "right", label: "Right", rect: { x: dpad.x + dpad.w * (1 - armLong), y: dpad.y + dpad.h * 0.3, w: dpad.w * armLong, h: dpad.h * armShort } },
  ];
}

/**
 * The image-based console: the player's actual pixel-art handheld, with the live
 * game screen positioned in its window and transparent hit-areas over each drawn
 * control. This is the default device ("My Handheld" theme); the CSS Shell above
 * renders the other themes. Controls share the same input bus, so gameplay is
 * identical to the CSS shell.
 */
function ImageShell({ bus, children }: { bus: ConsoleInputBus; children: ReactNode }) {
  const { setPanelOpen } = useConsoleSettings();
  const { handheld } = useHandheldSkin();
  const [layout, setLayout] = useState<HandheldLayout | null>(null);
  const [template, setTemplate] = useState<HandheldTemplate | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [loadedTemplate, layoutData] = await Promise.all([
          loadHandheldTemplateHiRes(),
          fetch(handheldAssetUrl("/handheld/handheld-layout.json")).then((response) => response.json() as Promise<HandheldLayout>),
        ]);
        if (!alive) return;
        setLayout(layoutData);
        setTemplate(loadedTemplate);
      } catch {
        // Leave the placeholder up; the CSS shell remains reachable via settings.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Prefer the player's free-form pixel art (drawn in the editor) when present;
  // otherwise re-render the region-recoloured skin. The art URL is absolute (an
  // R2 https URL or an inline data URL) and its key is unique per upload, so it
  // needs neither the base path nor a cache-busting query.
  const skinUrl = useMemo(
    () => handheld.art?.url ?? (template ? renderSkinDataUrl(template, handheld.scheme) : null),
    [handheld.art?.url, template, handheld.scheme],
  );

  // Animated skin: slice the sprite sheet into per-frame images and cycle them.
  const art = handheld.art;
  const frameCount = art?.frames ?? 1;
  const durationMs = art?.durationMs ?? 100;
  const [frameUrls, setFrameUrls] = useState<string[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!art || frameCount <= 1) {
      setFrameUrls([]);
      return;
    }
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive) return;
      setFrameUrls(sliceSheet(image, art.w, art.h, frameCount));
      setFrameIndex(0);
    };
    image.src = art.url;
    return () => {
      alive = false;
    };
  }, [art, frameCount]);

  useEffect(() => {
    if (frameUrls.length <= 1) return;
    const id = window.setInterval(() => setFrameIndex((index) => (index + 1) % frameUrls.length), durationMs);
    return () => window.clearInterval(id);
  }, [frameUrls, durationMs]);

  // Show the current animation frame when animated, else the static skin.
  const displayUrl = frameCount > 1 ? frameUrls[frameIndex] ?? null : skinUrl;

  const hits: Array<{ control: ConsoleControl; rect: LayoutRect; label: string }> = layout
    ? [
        ...dpadZones(layout.dpad),
        { control: "y", rect: layout.buttons.y, label: "Y button" },
        { control: "x", rect: layout.buttons.x, label: "X button" },
        { control: "a", rect: layout.buttons.a, label: "A button" },
        { control: "b", rect: layout.buttons.b, label: "B button" },
        { control: "l1", rect: layout.shoulders.l, label: "L shoulder" },
        { control: "r1", rect: layout.shoulders.r, label: "R shoulder" },
        { control: "select", rect: layout.system.select, label: "Select" },
        { control: "start", rect: layout.system.start, label: "Start" },
      ]
    : [];

  return (
    <div className="hh-img-root" onContextMenu={(event) => event.preventDefault()}>
      <div className="hh-img-device" style={{ aspectRatio: layout ? String(layout.aspect) : "0.549" }}>
        {displayUrl && <img className="hh-img-skin" src={displayUrl} alt="" draggable={false} />}
        {layout && (
          <>
            <div className="hh-img-screen" style={rectStyle(layout.screen)}>
              {children}
            </div>
            {hits.map(({ control, rect, label }) => (
              <ShellButton key={control} bus={bus} control={control} className="hh-hit" style={rectStyle(rect)} label={label} />
            ))}
            <button
              type="button"
              className="hh-img-gear"
              aria-label="Console settings"
              onClick={() => setPanelOpen(true)}
              onMouseDown={(event) => event.preventDefault()}
            >
              ⚙
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Render the player's handheld skin (chrome + their colours) to a data URL. */
function renderSkinDataUrl(template: HandheldTemplate, scheme: HandheldScheme): string {
  const rgba = renderHandheld(template, scheme);
  const canvas = document.createElement("canvas");
  canvas.width = template.width;
  canvas.height = template.height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(template.width, template.height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

/** Pick the device shell for the active theme: the player's handheld by default. */
function ShellRouter({ bus, children }: { bus: ConsoleInputBus; children: ReactNode }) {
  const { settings } = useConsoleSettings();
  return settings.theme === "handheld" ? (
    <ImageShell bus={bus}>{children}</ImageShell>
  ) : (
    <Shell bus={bus}>{children}</Shell>
  );
}

export function HandheldConsole({ children }: { children: ReactNode }) {
  // One bus per mounted console. The dispatcher only touches `window` when a
  // button actually fires, so constructing it during SSR is safe.
  const bus = useMemo(() => new ConsoleInputBus(createWindowKeyDispatcher()), []);

  return (
    <ConsoleInputContext.Provider value={bus}>
      <ConsoleSettingsProvider>
        <HandheldSkinProvider>
          <ShellRouter bus={bus}>{children}</ShellRouter>
        </HandheldSkinProvider>
      </ConsoleSettingsProvider>
    </ConsoleInputContext.Provider>
  );
}
