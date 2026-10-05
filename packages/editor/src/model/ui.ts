/**
 * The UI system (ENGINE_PARITY_ROADMAP.md EP13): menus and HUDs authored as
 * documents of widgets — panels, text, buttons, bars, sliders, lists, images —
 * instead of hand-placed rectangles, laid out by anchors so they fit any
 * console's screen, navigated with a controller's d-pad, and driven from Lua.
 *
 * A widget sits at an **anchor** on its parent (0..1 across and down: 0.5, 0
 * is the top middle), placed by its own **pivot** (the point of the widget
 * that goes on the anchor), nudged by an **offset** and sized in pixels. What
 * it shows comes from **bindings** the cart sets with cartbox.ui.set: text
 * with `{key}` placeholders, a bar's fill, a list's items, whether it's
 * visible at all, a colour.
 *
 * The documents are laid out here, once, for the console's screen; focus
 * moves between the buttons, sliders and lists by where they sit (the nearest
 * one in the direction pressed). The generated Lua draws with the console's
 * own primitives (rect, print, spr), so the UI is pixel-exact in the cart's
 * frame — over the 3D scene in HUD mode. Pure and DOM-free.
 */

export type UiKind = "panel" | "text" | "button" | "bar" | "slider" | "list" | "image";

export interface UiWidget {
  readonly id: string;
  readonly kind: UiKind;
  /** The point on the parent the widget hangs from, 0..1 across and down. */
  readonly anchor: readonly [number, number];
  /** The point of the widget that sits on the anchor, 0..1 of its own size. */
  readonly pivot: readonly [number, number];
  /** Pixels from the anchor. */
  readonly offset: readonly [number, number];
  /** Pixels. */
  readonly size: readonly [number, number];
  /** Text (text, button), with `{key}` placeholders filled from the bindings. */
  readonly text?: string;
  /** Text or fill colour (palette index). */
  readonly color?: number;
  /** Background (palette index; absent = none). */
  readonly fill?: number;
  /** Outline (palette index; absent = none). */
  readonly border?: number;
  /** Background and text colour when focused (or a list's selected row). */
  readonly focusFill?: number;
  readonly focusColor?: number;
  /** Text size, 1..4. */
  readonly scale?: number;
  /** The console's small font. */
  readonly small?: boolean;
  readonly align?: "left" | "center" | "right";
  /** Binding: a bar's or slider's fill (0..1), a list's items (a table of strings, or { text, color }). */
  readonly value?: string;
  /** Binding: drawn only while it's truthy. */
  readonly visible?: string;
  /** Binding: overrides `color` while it's a number. */
  readonly tint?: string;
  /** A list's row height in pixels. */
  readonly row?: number;
  /** An image's sprite (index) and size in 8-pixel tiles. */
  readonly sprite?: number;
  readonly tiles?: readonly [number, number];
  readonly children?: readonly UiWidget[];
}

export interface UiDocument {
  readonly name: string;
  readonly widgets: readonly UiWidget[];
}

export const UI_KINDS: readonly UiKind[] = ["panel", "text", "button", "bar", "slider", "list", "image"];
/** The kinds focus can land on. */
export const FOCUSABLE: ReadonlySet<UiKind> = new Set(["button", "slider", "list"]);
export const MAX_UI_DOCUMENTS = 16;
export const MAX_UI_WIDGETS = 200;

/** A text's width in pixels as the console draws it (6 a character, 4 in the small font, × scale). */
export function uiTextWidth(text: string, scale = 1, small = false): number {
  return text.length * (small ? 4 : 6) * scale;
}

/** One widget placed: its absolute box, how deep it sits, and how many widgets under it to skip when it's hidden. */
export interface UiPlaced {
  readonly widget: UiWidget;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly depth: number;
  /** Descendants that follow it in the list. */
  readonly descendants: number;
}

/** Lay a document out on a `width × height` screen: every widget's box, parents before children (draw order). */
export function layoutUi(doc: UiDocument, width: number, height: number): UiPlaced[] {
  const out: UiPlaced[] = [];
  const place = (widgets: readonly UiWidget[], px: number, py: number, pw: number, ph: number, depth: number) => {
    for (const w of widgets) {
      if (out.length >= MAX_UI_WIDGETS) return;
      const [sw, sh] = w.size;
      const x = Math.round(px + pw * w.anchor[0] + w.offset[0] - sw * w.pivot[0]);
      const y = Math.round(py + ph * w.anchor[1] + w.offset[1] - sh * w.pivot[1]);
      const index = out.length;
      out.push({ widget: w, x, y, w: sw, h: sh, depth, descendants: 0 });
      if (w.children?.length) place(w.children, x, y, sw, sh, depth + 1);
      out[index] = { ...out[index]!, descendants: out.length - index - 1 };
    }
  };
  place(doc.widgets, 0, 0, width, height, 0);
  return out;
}

/**
 * Where focus goes from each focusable widget, pressing up, down, left or
 * right: the nearest focusable whose centre lies that way (within a 60° cone,
 * nearer the axis preferred), or -1. Indices into the laid-out list.
 */
export function uiNavigation(placed: readonly UiPlaced[]): Map<number, [number, number, number, number]> {
  const focusable = placed.map((p, i) => [p, i] as const).filter(([p]) => FOCUSABLE.has(p.widget.kind));
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const nav = new Map<number, [number, number, number, number]>();
  for (const [from, i] of focusable) {
    const fx = from.x + from.w / 2, fy = from.y + from.h / 2;
    const links = dirs.map(([dx, dy]) => {
      let best = -1, bestScore = Infinity;
      for (const [to, j] of focusable) {
        if (j === i) continue;
        const vx = to.x + to.w / 2 - fx, vy = to.y + to.h / 2 - fy;
        const along = vx * dx + vy * dy;
        const across = Math.abs(vx * dy - vy * dx);
        if (along <= 0 || across > along * Math.tan(Math.PI / 3)) continue;
        const score = along + across * 2;
        if (score < bestScore) {
          bestScore = score;
          best = j;
        }
      }
      return best;
    }) as [number, number, number, number];
    nav.set(i, links);
  }
  return nav;
}

/** Fill `{key}` placeholders from bindings (a missing key is empty). */
export function fillUiText(text: string, bindings: Readonly<Record<string, unknown>>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = bindings[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

// --- Reading ---------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pair = (v: unknown, fallback: [number, number]): [number, number] => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : fallback);
const colour = (v: unknown): number | undefined => (finite(v) ? clamp(Math.round(v), 0, 15) : undefined);
const key = (v: unknown): string | undefined => (typeof v === "string" && /^\w{1,32}$/.test(v) ? v : undefined);

function readWidget(value: unknown, ids: Set<string>, count: { n: number }): UiWidget | null {
  if (!value || typeof value !== "object" || count.n >= MAX_UI_WIDGETS) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.kind !== "string" || !UI_KINDS.includes(r.kind as UiKind)) return null;
  let id = typeof r.id === "string" && /^[\w-]{1,32}$/.test(r.id) ? r.id : `${r.kind}${count.n + 1}`;
  while (ids.has(id)) id = `${id}_`;
  ids.add(id);
  count.n += 1;
  const children = Array.isArray(r.children) ? r.children.map((c) => readWidget(c, ids, count)).filter((c): c is UiWidget => c !== null) : [];
  const size = pair(r.size, [100, 20]);
  const out: Record<string, unknown> = {
    id,
    kind: r.kind,
    anchor: pair(r.anchor, [0, 0]).map((v) => clamp(v, 0, 1)),
    pivot: pair(r.pivot, [0, 0]).map((v) => clamp(v, 0, 1)),
    offset: pair(r.offset, [0, 0]).map((v) => clamp(Math.round(v), -4096, 4096)),
    size: size.map((v) => clamp(Math.round(v), 0, 4096)),
  };
  if (typeof r.text === "string") out.text = r.text.slice(0, 200);
  for (const k of ["color", "fill", "border", "focusFill", "focusColor"] as const) if (colour(r[k]) !== undefined) out[k] = colour(r[k]);
  if (finite(r.scale)) out.scale = clamp(Math.round(r.scale), 1, 4);
  if (r.small === true) out.small = true;
  if (r.align === "left" || r.align === "center" || r.align === "right") out.align = r.align;
  for (const k of ["value", "visible", "tint"] as const) if (key(r[k])) out[k] = key(r[k]);
  if (finite(r.row)) out.row = clamp(Math.round(r.row), 4, 200);
  if (finite(r.sprite)) out.sprite = clamp(Math.round(r.sprite), 0, 511);
  if (Array.isArray(r.tiles)) out.tiles = pair(r.tiles, [1, 1]).map((v) => clamp(Math.round(v), 1, 8));
  if (children.length > 0) out.children = children;
  return out as unknown as UiWidget;
}

/** Read stored UI documents defensively: malformed widgets dropped, ids made unique, names unique. */
export function parseUiDocuments(value: unknown): UiDocument[] {
  if (!Array.isArray(value)) return [];
  const docs: UiDocument[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (docs.length >= MAX_UI_DOCUMENTS) break;
    const d = raw as Record<string, unknown> | null;
    if (!d || typeof d.name !== "string" || !/^\w{1,32}$/.test(d.name) || names.has(d.name)) continue;
    names.add(d.name);
    const ids = new Set<string>();
    const count = { n: 0 };
    const widgets = Array.isArray(d.widgets) ? d.widgets.map((w) => readWidget(w, ids, count)).filter((w): w is UiWidget => w !== null) : [];
    docs.push({ name: d.name, widgets });
  }
  return docs;
}

/** A new widget of a kind, with sensible defaults, centred on its parent. */
export function newUiWidget(kind: UiKind, id: string): UiWidget {
  const base = { id, kind, anchor: [0.5, 0.5] as [number, number], pivot: [0.5, 0.5] as [number, number], offset: [0, 0] as [number, number] };
  switch (kind) {
    case "panel":
      return { ...base, size: [240, 120], fill: 1, border: 13 };
    case "text":
      return { ...base, size: [240, 16], text: "Text", color: 12, scale: 2, align: "center" };
    case "button":
      return { ...base, size: [200, 32], text: "Button", color: 13, fill: 5, focusFill: 1, focusColor: 12, scale: 2, align: "center" };
    case "bar":
      return { ...base, size: [200, 14], color: 9, fill: 5, value: "value" };
    case "slider":
      return { ...base, size: [200, 16], color: 12, fill: 5, focusColor: 9, value: "value" };
    case "list":
      return { ...base, size: [320, 160], color: 13, focusFill: 1, focusColor: 12, scale: 2, row: 36, value: "items" };
    case "image":
      return { ...base, size: [16, 16], sprite: 0, tiles: [1, 1] };
  }
}
