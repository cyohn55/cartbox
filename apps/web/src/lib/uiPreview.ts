/**
 * Drawing a UI document in the editor (EP13): the same layout the cart's Lua
 * uses, painted onto a canvas with the cart's palette so the UI tab shows what
 * the game will. Text is an approximation of the console's font (its 6-pixel
 * advance, 4 in the small font, × scale); the game measures it exactly.
 */

import { FOCUSABLE, fillUiText, layoutUi, uiTextWidth, type UiDocument, type UiPlaced } from "@cartbox/editor";

type Rgb = readonly [number, number, number] | { readonly r: number; readonly g: number; readonly b: number };

export interface UiPreviewOptions {
  readonly width: number;
  readonly height: number;
  readonly palette: readonly Rgb[];
  readonly bindings: Readonly<Record<string, unknown>>;
  /** The focused widget's id, if any. */
  readonly focus?: string | null;
  /** The selected widget's id (outlined), if any. */
  readonly selected?: string | null;
}

const css = (palette: readonly Rgb[], index: number): string => {
  const c = palette[index];
  if (!c) return "#ff00ff";
  const [r, g, b] = Array.isArray(c) ? c : [(c as { r: number }).r, (c as { g: number }).g, (c as { b: number }).b];
  return `rgb(${r},${g},${b})`;
};

/**
 * Sample bindings so an unbound document still shows something: a text's
 * placeholders as themselves (`{score}`), bars two-thirds full, lists three
 * rows, everything visible.
 */
export function sampleBindings(doc: UiDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (widgets: UiDocument["widgets"]) => {
    for (const w of widgets) {
      for (const m of (w.text ?? "").matchAll(/\{(\w+)\}/g)) out[m[1]!] ??= `{${m[1]}}`;
      if (w.value && (w.kind === "bar" || w.kind === "slider")) out[w.value] ??= 0.66;
      if (w.value && w.kind === "list") out[w.value] ??= ["First", "Second", "Third"];
      if (w.visible) out[w.visible] ??= true;
      if (w.children) visit(w.children);
    }
  };
  visit(doc.widgets);
  return out;
}

/** Paint a document; returns its laid-out widgets (for hit-testing clicks). */
export function drawUiPreview(ctx: CanvasRenderingContext2D, doc: UiDocument, o: UiPreviewOptions): UiPlaced[] {
  const placed = layoutUi(doc, o.width, o.height);
  const text = (s: string, p: UiPlaced, color: number, scale: number, small: boolean, align: string | undefined, x0 = p.x, w0 = p.w, y0 = p.y, h0 = p.h) => {
    const tw = uiTextWidth(s, scale, small);
    const x = align === "center" ? x0 + Math.floor((w0 - tw) / 2) : align === "right" ? x0 + w0 - tw : x0;
    const y = h0 > 0 ? y0 + Math.floor((h0 - 6 * scale) / 2) : y0;
    ctx.fillStyle = css(o.palette, color);
    ctx.font = `bold ${Math.round((small ? 5.2 : 7.6) * scale)}px monospace`;
    ctx.textBaseline = "top";
    // Squeeze the canvas font onto the console's advance, so widths match the game.
    const measured = ctx.measureText(s).width || 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(tw / measured, 1);
    ctx.fillText(s, 0, 0);
    ctx.restore();
  };
  for (let i = 0; i < placed.length; i += 1) {
    const p = placed[i]!;
    const w = p.widget;
    if (w.visible && !o.bindings[w.visible]) {
      i += p.descendants;
      continue;
    }
    const focused = o.focus === w.id && FOCUSABLE.has(w.kind);
    const tint = w.tint && typeof o.bindings[w.tint] === "number" ? (o.bindings[w.tint] as number) : undefined;
    const color = tint ?? w.color ?? 12;
    const scale = w.scale ?? 1;
    const rect = (x: number, y: number, rw: number, rh: number, c: number) => {
      ctx.fillStyle = css(o.palette, c);
      ctx.fillRect(x, y, rw, rh);
    };
    const outline = (c: number) => {
      ctx.strokeStyle = css(o.palette, c);
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    };
    switch (w.kind) {
      case "panel":
      case "button": {
        const bg = focused && w.kind === "button" && w.focusFill !== undefined ? w.focusFill : w.fill;
        if (bg !== undefined) rect(p.x, p.y, p.w, p.h, bg);
        if (w.border !== undefined) outline(w.border);
        if (w.kind === "button" && w.text) text(fillUiText(w.text, o.bindings), p, focused && w.focusColor !== undefined ? w.focusColor : color, scale, Boolean(w.small), w.align);
        break;
      }
      case "text":
        if (w.fill !== undefined) rect(p.x, p.y, p.w, p.h, w.fill);
        if (w.text) text(fillUiText(w.text, o.bindings), p, color, scale, Boolean(w.small), w.align);
        break;
      case "bar": {
        if (w.fill !== undefined) rect(p.x, p.y, p.w, p.h, w.fill);
        const v = Math.max(0, Math.min(1, Number(o.bindings[w.value ?? ""]) || 0));
        rect(p.x + 2, p.y + 2, Math.floor((p.w - 4) * v), p.h - 4, color);
        if (w.border !== undefined) outline(w.border);
        break;
      }
      case "slider": {
        rect(p.x, p.y + Math.floor(p.h / 2) - 1, p.w, 2, w.fill ?? 13);
        const v = Math.max(0, Math.min(1, Number(o.bindings[w.value ?? ""]) || 0));
        rect(p.x + Math.floor((p.w - 8) * v), p.y, 8, p.h, focused && w.focusColor !== undefined ? w.focusColor : color);
        break;
      }
      case "list": {
        if (w.fill !== undefined) rect(p.x, p.y, p.w, p.h, w.fill);
        const items = Array.isArray(o.bindings[w.value ?? ""]) ? (o.bindings[w.value ?? ""] as unknown[]) : [];
        const row = w.row ?? 12;
        const rows = Math.max(1, Math.floor(p.h / row));
        items.slice(0, rows).forEach((item, r) => {
          const y = p.y + r * row;
          if (r === 0 && w.focusFill !== undefined) rect(p.x, y, p.w, row - 2, w.focusFill);
          const label = typeof item === "object" && item ? String((item as { text?: unknown }).text ?? "") : String(item);
          text(label, p, r === 0 && w.focusColor !== undefined ? w.focusColor : color, scale, Boolean(w.small), w.align, p.x + 8, p.w - 16, y, row - 2);
        });
        break;
      }
      case "image":
        // Sprites live in the cart's sheet; the preview marks where one goes.
        ctx.strokeStyle = css(o.palette, 13);
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
        ctx.setLineDash([]);
        break;
    }
    if (o.selected === w.id) {
      ctx.strokeStyle = "#7db8fc";
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2);
    }
  }
  return placed;
}

/** The topmost widget under a point (drawn last wins), or null. */
export function widgetAt(placed: readonly UiPlaced[], x: number, y: number): string | null {
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    const p = placed[i]!;
    if (x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) return p.widget.id;
  }
  return null;
}

/**
 * Preview bindings typed as `key=value` pairs separated by `;` — a number, a
 * comma list (a list's items), `true`/`false`, or text.
 */
export function parsePreviewBindings(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!/^\w+$/.test(key)) continue;
    if (raw === "true" || raw === "false") out[key] = raw === "true";
    else if (raw !== "" && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else if (raw.includes(",")) out[key] = raw.split(",").map((s) => s.trim());
    else out[key] = raw;
  }
  return out;
}
