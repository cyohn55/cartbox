"use client";

/**
 * Console settings — opened with START (or the bezel gear). Personalizes the
 * physical shell: theme, control layout, face-button colors, and which
 * mini-game lives behind the buttons. Fully cursor-navigable; changes apply
 * and persist immediately.
 */

import { useConsoleSettings } from "./ConsoleSettingsContext";
import {
  BUTTON_STYLES,
  CONSOLE_THEMES,
  CONTROL_LAYOUTS,
  type ConsoleSettings,
} from "./consoleSettings";
import { MINI_GAMES, miniGameForMonth } from "./minigames/registry";

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

      <OptionRow
        label="BUTTON COLORS"
        options={BUTTON_STYLES}
        value={settings.buttons}
        onPick={(buttons) => update({ buttons })}
      />

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
