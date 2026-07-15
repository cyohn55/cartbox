"use client";

/**
 * Console settings — opened with START (or the bezel gear). Personalizes the
 * physical shell: theme, control layout, face-button colors, and which
 * mini-game lives behind the buttons. Fully cursor-navigable; changes apply
 * and persist immediately.
 */

import { HANDHELD_PRESETS, HANDHELD_REGIONS } from "@cartbox/editor";

import { useConsoleSettings } from "./ConsoleSettingsContext";
import { useHandheldSkin } from "./HandheldSkinContext";
import {
  BUTTON_STYLES,
  CONSOLE_THEMES,
  CONTROL_LAYOUTS,
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
  const { handheld, recolorRegion, applyPreset, reset: resetHandheld } = useHandheldSkin();
  const featured = miniGameForMonth(new Date());

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
          <label key={key} className="os-color-field">
            <input
              type="color"
              className="os-color"
              aria-label={`${key.toUpperCase()} button color`}
              value={settings.faceColors?.[key] ?? CUSTOM_FACE_DEFAULTS[key]}
              onChange={(event) =>
                update({
                  faceColors: {
                    ...(settings.faceColors ?? CUSTOM_FACE_DEFAULTS),
                    [key]: event.target.value,
                  },
                })
              }
            />
            {key.toUpperCase()}
          </label>
        ))}
        <label className="os-color-field">
          <input
            type="color"
            className="os-color"
            aria-label="D-pad color"
            value={settings.dpadColor ?? CUSTOM_DPAD_DEFAULT}
            onChange={(event) => update({ dpadColor: event.target.value })}
          />
          D-PAD
        </label>
        <label className="os-color-field">
          <input
            type="color"
            className="os-color"
            aria-label="Joystick color"
            value={settings.joystickColor ?? CUSTOM_JOYSTICK_DEFAULT}
            onChange={(event) => update({ joystickColor: event.target.value })}
          />
          STICK
        </label>
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
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="os-color-row">
        {HANDHELD_REGIONS.map((region) => (
          <label key={region.id} className="os-color-field">
            <input
              type="color"
              className="os-color"
              aria-label={`${region.label} colour`}
              value={handheld.scheme[region.id]}
              onChange={(event) => recolorRegion(region.id, event.target.value)}
            />
            {region.label.toUpperCase()}
          </label>
        ))}
      </div>
      <div className="os-option-row">
        <button type="button" className="os-kind-option" onClick={resetHandheld}>
          RESET HANDHELD COLORS
        </button>
      </div>

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
