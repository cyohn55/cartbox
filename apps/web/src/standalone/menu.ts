/**
 * The Start menu of an exported game (ENGINE_PARITY_ROADMAP.md EP18): opened by
 * a controller's Start, Esc / Enter / P, or the ≡ button in the corner, it
 * pauses the game and offers resume, full screen, volume, and the player's
 * accessibility settings — text size, colour filter and (when the cart speaks
 * more than one) language — which apply at once and are kept in this browser
 * for every Cartbox game. Plain DOM: an export carries no framework.
 */

import { COLOR_FILTERS, COLOR_FILTER_LABELS, TEXT_SCALES, languageName, type ColorFilter } from "@cartbox/editor";
import type { PlayerHandle } from "@cartbox/player";

import { preferredLanguages, writePlayerPrefs, type PlayerPrefs } from "../lib/accessibilityPrefs";

export const VOLUME_KEY = "cartbox:volume";

export interface GameMenu {
  readonly open: boolean;
  toggle(): void;
  close(): void;
}

function readVolume(storage: Pick<Storage, "getItem"> | null): number {
  try {
    const v = Number(storage?.getItem(VOLUME_KEY));
    return storage?.getItem(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

/** Build the menu (hidden) over `stage`, with its ≡ button. */
export function createGameMenu(options: {
  stage: HTMLElement;
  handle: () => PlayerHandle | null;
  title: string;
  prefs: PlayerPrefs;
  languages: readonly string[];
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}): GameMenu {
  const doc = options.stage.ownerDocument;
  let prefs = options.prefs;
  let volume = readVolume(options.storage);
  let open = false;
  let wasRunning = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const button = el("button", { type: "button", "aria-label": "Menu", "data-menu-button": "" }, "≡");
  button.style.cssText = "position:fixed;top:10px;right:10px;z-index:20;font:600 16px system-ui,sans-serif;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(10,12,20,.6);color:#fff;cursor:pointer";

  const backdrop = el("div", { role: "dialog", "aria-modal": "true", "aria-label": "Paused" });
  // Shown with display (an inline display would override the hidden attribute).
  backdrop.style.cssText = "position:fixed;inset:0;z-index:30;display:none;align-items:center;justify-content:center;background:rgba(6,6,12,.72)";
  const card = el("div");
  card.style.cssText = "min-width:280px;max-width:min(420px,92vw);padding:20px;border-radius:12px;background:#15131f;color:#e2e8f0;font:14px system-ui,sans-serif;display:grid;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,.5)";
  const heading = el("h2", {}, `${options.title} — paused`);
  heading.style.cssText = "margin:0;font-size:18px";
  card.append(heading);

  const row = (label: string, control: HTMLElement) => {
    const wrap = el("label");
    wrap.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px";
    wrap.append(el("span", {}, label), control);
    card.append(wrap);
  };
  const select = (name: string, items: readonly [string, string][], value: string, onChange: (v: string) => void) => {
    const s = el("select", { "aria-label": name });
    s.style.cssText = "font:inherit;padding:4px 8px;border-radius:6px";
    for (const [v, text] of items) {
      const o = el("option", { value: v }, text);
      if (v === value) o.selected = true;
      s.append(o);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  const resume = el("button", { type: "button" }, "Resume");
  resume.style.cssText = "font:600 15px system-ui,sans-serif;padding:8px;border-radius:8px;border:none;background:#8b93ff;color:#0c0a14;cursor:pointer";
  resume.addEventListener("click", () => close());
  card.append(resume);

  const fullscreen = el("button", { type: "button" }, "Full screen");
  fullscreen.style.cssText = "font:inherit;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:none;color:inherit;cursor:pointer";
  fullscreen.addEventListener("click", () => {
    if (doc.fullscreenElement) void doc.exitFullscreen?.();
    else void doc.documentElement.requestFullscreen?.().catch(() => {});
  });
  card.append(fullscreen);

  const vol = el("input", { type: "range", min: "0", max: "1", step: "0.05", "aria-label": "Volume" }) as HTMLInputElement;
  vol.value = String(volume);
  vol.addEventListener("input", () => {
    volume = Number(vol.value);
    options.handle()?.setVolume(volume);
    try {
      options.storage?.setItem(VOLUME_KEY, String(volume));
    } catch {
      // This visit only.
    }
  });
  row("Volume", vol);

  const apply = (next: PlayerPrefs) => {
    prefs = next;
    writePlayerPrefs(options.storage, next);
    options.handle()?.setAccessibility(next);
    options.handle()?.setLanguages(preferredLanguages(next));
  };
  row(
    "Text size",
    select("Text size", TEXT_SCALES.map((s) => [String(s), s === 1 ? "Normal" : `×${s}`]), String(prefs.textScale), (v) => apply({ ...prefs, textScale: Number(v) })),
  );
  row(
    "Colours",
    select("Colour filter", COLOR_FILTERS.map((f) => [f, COLOR_FILTER_LABELS[f]]), prefs.colorFilter, (v) => apply({ ...prefs, colorFilter: v as ColorFilter })),
  );
  if (options.languages.length > 1) {
    row(
      "Language",
      select("Language", [["", "Browser's"], ...options.languages.map((l) => [l, languageName(l)] as [string, string])], prefs.language ?? "", (v) =>
        apply({ ...prefs, language: v || null }),
      ),
    );
  }
  const hint = el("p", {}, "Start, Esc or P opens and closes this menu.");
  hint.style.cssText = "margin:0;font-size:12px;opacity:.6";
  card.append(hint);
  backdrop.append(card);
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  options.stage.ownerDocument.body.append(button, backdrop);
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  function show(): void {
    const handle = options.handle();
    wasRunning = handle?.running ?? false;
    handle?.pause();
    open = true;
    backdrop.style.display = "flex";
    resume.focus();
  }
  function close(): void {
    if (!open) return;
    open = false;
    backdrop.style.display = "none";
    if (wasRunning) options.handle()?.resume();
  }
  function toggle(): void {
    if (open) close();
    else show();
  }
  options.handle()?.setVolume(volume);
  return {
    get open() {
      return open;
    },
    toggle,
    close,
  };
}
