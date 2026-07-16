"use client";

/**
 * Console settings — opened with START (or the bezel gear). Personalizes the
 * physical shell: theme, control layout, face-button colors, and which
 * mini-game lives behind the buttons. Fully cursor-navigable; changes apply
 * and persist immediately.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import {
  HANDHELD_PRESETS,
  HANDHELD_REGIONS,
  type HandheldBackground,
  type HandheldScheme,
  type HandheldTemplate,
} from "@cartbox/editor";

import { loadHandheldTemplate } from "@/lib/handheldTemplate";
import { ANIMATED_PRESETS, renderAnimatedArt, type AnimatedPresetView } from "@/lib/handheldAnimated";
import { decodeBackgroundSource, readImageBackground, renderBackgroundArt } from "@/lib/handheldBackground";
import { ConsoleColorPicker } from "./ConsoleColorPicker";
import { useConsoleSettings } from "./ConsoleSettingsContext";
import { useHandheldSkin } from "./HandheldSkinContext";
import {
  BUTTON_STYLES,
  CONSOLE_THEMES,
  CONTROL_LAYOUTS,
  OS_PHOSPHORS,
  OS_STYLES,
  type ConsoleSettings,
  type FaceButtonColors,
} from "./consoleSettings";
import { MINI_GAMES, miniGameForMonth } from "./minigames/registry";

/** Starting palette when the player first opens the custom pickers. */
const CUSTOM_FACE_DEFAULTS: FaceButtonColors = { x: "#8f86c6", y: "#6fdfa8", a: "#ffca66", b: "#ff8fae" };
const CUSTOM_DPAD_DEFAULT = "#322a4e";
const CUSTOM_JOYSTICK_DEFAULT = "#322a4e";

function OptionRow<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onPick: (id: T) => void;
}) {
  return (
    <div>
      <div className="os-section-title">{label}</div>
      <div className="os-option-row" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className="os-kind-option"
            data-active={value === option.id}
            onClick={() => onPick(option.id)}
          >
            {option.label.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { settings, update } = useConsoleSettings();
  const {
    handheld,
    recolorRegion,
    applyPreset,
    applyBackground,
    applyAnimation,
    clearArt,
    reset: resetHandheld,
  } = useHandheldSkin();
  const featured = miniGameForMonth(new Date());

  // The chrome + region mask, needed to render the marquee/background live from
  // the current colours. Loaded once; the sections stay disabled until it is in.
  const [template, setTemplate] = useState<HandheldTemplate | null>(null);
  // The decoded background image (from the stored source), kept so recolouring
  // re-composites it synchronously instead of dropping it.
  const [backgroundPixels, setBackgroundPixels] = useState<HandheldBackground | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void loadHandheldTemplate().then((loaded) => alive && setTemplate(loaded));
    return () => {
      alive = false;
    };
  }, []);

  // Keep the decoded background in sync with the stored source: decode when one
  // is present (and not already decoded), drop it when cleared.
  const backgroundSource = handheld.background;
  useEffect(() => {
    if (!backgroundSource) {
      setBackgroundPixels(null);
      return;
    }
    let alive = true;
    void decodeBackgroundSource(backgroundSource)
      .then((pixels) => alive && setBackgroundPixels(pixels))
      .catch(() => alive && setBackgroundPixels(null));
    return () => {
      alive = false;
    };
  }, [backgroundSource]);

  // The marquee currently playing on the chassis (if any), for highlighting.
  const activeMarquee = handheld.animation
    ? ANIMATED_PRESETS.find((view) => view.game === handheld.animation) ?? null
    : null;
  // A static custom skin (uploaded background or hand-drawn art) is showing.
  const hasStaticArt = Boolean(handheld.art) && !handheld.animation;

  /** Render a marquee in a given scheme and apply it (no-op without a template). */
  const playMarquee = (view: AnimatedPresetView, scheme: HandheldScheme) => {
    if (!template) return;
    try {
      applyAnimation(renderAnimatedArt(template, scheme, view), view.game);
    } catch {
      setNote(`Could not render the ${view.label} marquee.`);
    }
  };

  /** Re-composite the active background (if any) in a given scheme. */
  const rerenderBackground = (scheme: HandheldScheme) => {
    if (!template || !backgroundSource || !backgroundPixels) return;
    try {
      applyBackground(backgroundSource, renderBackgroundArt(template, scheme, backgroundPixels));
    } catch {
      setNote("Could not re-apply the background image.");
    }
  };

  // Recolour a region, then re-render whichever live look is active (marquee or
  // background) in the new colours so it recolours with the chassis, mirroring
  // the onboarding picker rather than dropping the art.
  const handleRecolor = (region: (typeof HANDHELD_REGIONS)[number]["id"], color: string) => {
    const nextScheme = { ...handheld.scheme, [region]: color };
    recolorRegion(region, color);
    if (activeMarquee) playMarquee(activeMarquee, nextScheme);
    else rerenderBackground(nextScheme);
  };

  // Apply a premade's colours, keeping any active marquee/background (re-rendered).
  const handlePreset = (presetId: string) => {
    applyPreset(presetId);
    const preset = HANDHELD_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    if (activeMarquee) playMarquee(activeMarquee, preset.scheme);
    else rerenderBackground(preset.scheme);
  };

  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !template) return;
    setNote("Reading image…");
    try {
      const { pixels, source } = await readImageBackground(file);
      setBackgroundPixels(pixels);
      applyBackground(source, renderBackgroundArt(template, handheld.scheme, pixels));
      setNote(`Applied ${file.name} as the chassis background.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not read that image.");
    }
  };

  const miniGameOptions = [
    { id: "monthly", label: `Monthly (${featured.title})` },
    ...MINI_GAMES.map((game) => ({ id: game.id, label: game.title })),
  ];

  return (
    <div className="os-stage os-auth" data-console-nav data-console-modal data-testid="settings-screen">
      <h2>CONSOLE SETTINGS</h2>

      <OptionRow
        label="SHELL THEME"
        options={CONSOLE_THEMES}
        value={settings.theme}
        onPick={(theme) => update({ theme })}
      />
      <p className="os-card-body" style={{ margin: 0 }}>
        {CONSOLE_THEMES.find((theme) => theme.id === settings.theme)?.blurb}
      </p>

      <OptionRow
        label="INTERFACE"
        options={OS_STYLES}
        value={settings.osStyle}
        onPick={(osStyle) => update({ osStyle })}
      />
      <p className="os-card-body" style={{ margin: 0 }}>
        {OS_STYLES.find((style) => style.id === settings.osStyle)?.blurb}
      </p>
      {settings.osStyle === "pipboy" && (
        <>
          <OptionRow
            label="PHOSPHOR"
            options={OS_PHOSPHORS}
            value={settings.osPhosphor}
            onPick={(osPhosphor) => update({ osPhosphor })}
          />
          <div className="os-option-row">
            <button
              type="button"
              className="os-kind-option"
              data-active={settings.osScanlines}
              aria-pressed={settings.osScanlines}
              onClick={() => update({ osScanlines: !settings.osScanlines })}
            >
              {settings.osScanlines ? "▤ SCANLINES ON" : "▤ SCANLINES OFF"}
            </button>
          </div>
        </>
      )}

      <OptionRow
        label="CONTROLS"
        options={CONTROL_LAYOUTS}
        value={settings.controls}
        onPick={(controls) => update({ controls })}
      />
      <div className="os-option-row">
        <button
          type="button"
          className="os-kind-option"
          data-active={settings.swapControls}
          aria-pressed={settings.swapControls}
          onClick={() => update({ swapControls: !settings.swapControls })}
        >
          {settings.swapControls ? "⇄ SWAPPED" : "⇄ SWAP D-PAD / JOYSTICK"}
        </button>
      </div>

      <OptionRow
        label="BUTTON COLORS"
        options={BUTTON_STYLES}
        value={settings.buttons}
        onPick={(buttons) => update({ buttons })}
      />

      <div className="os-section-title">CUSTOM COLORS</div>
      <div className="os-color-row">
        {(["x", "y", "a", "b"] as const).map((key) => (
          <ConsoleColorPicker
            key={key}
            label={`${key.toUpperCase()} button`}
            value={settings.faceColors?.[key] ?? CUSTOM_FACE_DEFAULTS[key]}
            onChange={(color) =>
              update({ faceColors: { ...(settings.faceColors ?? CUSTOM_FACE_DEFAULTS), [key]: color } })
            }
          />
        ))}
        <ConsoleColorPicker
          label="D-pad"
          value={settings.dpadColor ?? CUSTOM_DPAD_DEFAULT}
          onChange={(color) => update({ dpadColor: color })}
        />
        <ConsoleColorPicker
          label="Stick"
          value={settings.joystickColor ?? CUSTOM_JOYSTICK_DEFAULT}
          onChange={(color) => update({ joystickColor: color })}
        />
      </div>
      <div className="os-option-row">
        <button
          type="button"
          className="os-kind-option"
          onClick={() => update({ faceColors: null, dpadColor: null, joystickColor: null })}
        >
          RESET CUSTOM COLORS
        </button>
      </div>

      <div className="os-section-title">HANDHELD COLORS</div>
      <p className="os-card-body" style={{ margin: 0 }}>
        Recolour your pixel-art handheld. Applies live to the default “My Handheld” shell.
      </p>
      <div className="os-option-row" role="radiogroup" aria-label="Handheld preset">
        {HANDHELD_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={handheld.presetId === preset.id}
            className="os-kind-option"
            data-active={handheld.presetId === preset.id}
            onClick={() => handlePreset(preset.id)}
          >
            {preset.label.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="os-color-row">
        {HANDHELD_REGIONS.map((region) => (
          <ConsoleColorPicker
            key={region.id}
            label={region.label}
            value={handheld.scheme[region.id]}
            onChange={(color) => handleRecolor(region.id, color)}
          />
        ))}
      </div>
      <div className="os-option-row">
        <button type="button" className="os-kind-option" onClick={resetHandheld}>
          RESET HANDHELD COLORS
        </button>
      </div>

      <div className="os-section-title">MARQUEE</div>
      <p className="os-card-body" style={{ margin: 0 }}>
        Play an arcade scene on the chassis. It renders in your handheld’s colours.
      </p>
      <div className="os-option-row" role="radiogroup" aria-label="Marquee animation">
        <button
          type="button"
          role="radio"
          aria-checked={!activeMarquee}
          className="os-kind-option"
          data-active={!activeMarquee}
          onClick={clearArt}
        >
          NONE
        </button>
        {ANIMATED_PRESETS.map((view) => (
          <button
            key={view.id}
            type="button"
            role="radio"
            aria-checked={activeMarquee?.id === view.id}
            className="os-kind-option"
            data-active={activeMarquee?.id === view.id}
            disabled={!template}
            onClick={() => playMarquee(view, handheld.scheme)}
          >
            {view.label.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="os-section-title">CHASSIS BACKGROUND</div>
      <p className="os-card-body" style={{ margin: 0 }}>
        Show an image through the chassis. Recolouring or picking a marquee clears it.
      </p>
      <div className="os-option-row">
        <button
          type="button"
          className="os-kind-option"
          disabled={!template}
          onClick={() => backgroundInput.current?.click()}
        >
          UPLOAD IMAGE
        </button>
        {hasStaticArt && (
          <button type="button" className="os-kind-option" onClick={clearArt}>
            REMOVE BACKGROUND
          </button>
        )}
      </div>
      <input ref={backgroundInput} type="file" accept="image/*" onChange={uploadBackground} hidden />
      {note && (
        <p className="os-card-body" style={{ margin: 0 }}>
          {note}
        </p>
      )}

      <OptionRow
        label="MINI-GAME (ARCADE SHELL)"
        options={miniGameOptions}
        value={settings.miniGame as ConsoleSettings["miniGame"]}
        onPick={(miniGame) => update({ miniGame })}
      />
      <p className="os-card-body" style={{ margin: 0 }}>
        The mini-game plays behind the buttons on the Arcade shell. Enter
        ↑↑↓↓←→←→ B A anywhere to take its controls; SELECT gives them back.
        A new cartridge mini-game joins the rotation every month.
      </p>

      <button type="button" className="os-btn" data-console-back onClick={onClose}>
        DONE
      </button>
    </div>
  );
}
