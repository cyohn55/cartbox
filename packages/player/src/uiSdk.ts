/**
 * The UI system's Lua (ENGINE_PARITY_ROADMAP.md EP13): the cart's UI
 * documents, laid out for this console's screen, and `cartbox.ui` to drive
 * them — show and hide documents, set the bindings their text, bars and lists
 * read, move focus with the d-pad and press with A, and draw them with the
 * console's own primitives (so in HUD mode they sit over the 3D scene, and
 * where index 0 is the see-through key, a widget simply leaves it unpainted).
 *
 *   cartbox.ui.show(name) / hide(name) / shown(name)   put a document up, take it down
 *   cartbox.ui.set(key, value) / get(key)               a binding ({key} in text, a bar's
 *                                                       fill 0..1, a list's items, visible,
 *                                                       a colour)
 *   cartbox.ui.update() -> id, value                    d-pad moves focus in the topmost
 *                                                       document that has any (a list moves
 *                                                       its selection, a slider its value);
 *                                                       A presses: returns what was pressed
 *                                                       (a list's selected row as its value)
 *   cartbox.ui.on(id, function(value) ... end)          or have it called instead
 *   cartbox.ui.focus(name, id) / focused(name)          set or read where focus is
 *   cartbox.ui.select(id, row) / selected(id)           a list's selected row (1-based)
 *   cartbox.ui.draw()                                   draw every shown document, in the
 *                                                       order they were shown
 */

import { FOCUSABLE, layoutUi, parseUiDocuments, uiNavigation, type UiDocument } from "@cartbox/editor";

const lua = (s: string) => JSON.stringify(s);

/** A stored scene sidecar's UI documents (EP13): what the host hands the player as its `ui` option. */
export function readSidecarUi(raw: string | null | undefined): UiDocument[] {
  if (!raw) return [];
  try {
    return parseUiDocuments((JSON.parse(raw) as { ui?: unknown }).ui);
  } catch {
    return [];
  }
}

/** The `cartbox.ui` Lua for a cart's documents on a `width × height` screen, or "" when it has none. */
export function uiSdkLua(docs: readonly UiDocument[] | null | undefined, width: number, height: number): string {
  if (!docs || docs.length === 0) return "";
  const tables = docs.map((doc) => {
    const placed = layoutUi(doc, width, height);
    const nav = uiNavigation(placed);
    const first = placed.findIndex((p) => FOCUSABLE.has(p.widget.kind)) + 1;
    const widgets = placed.map((p) => {
      const w = p.widget;
      const f: string[] = [`k=${lua(w.kind)}`, `id=${lua(w.id)}`, `x=${p.x}`, `y=${p.y}`, `w=${p.w}`, `h=${p.h}`, `skip=${p.descendants}`];
      if (w.text !== undefined) f.push(`t=${lua(w.text)}`);
      if (w.color !== undefined) f.push(`c=${w.color}`);
      if (w.fill !== undefined) f.push(`f=${w.fill}`);
      if (w.border !== undefined) f.push(`b=${w.border}`);
      if (w.focusFill !== undefined) f.push(`ff=${w.focusFill}`);
      if (w.focusColor !== undefined) f.push(`fc=${w.focusColor}`);
      f.push(`s=${w.scale ?? 1}`);
      if (w.small) f.push("sm=true");
      f.push(`a=${w.align === "center" ? 1 : w.align === "right" ? 2 : 0}`);
      if (w.value) f.push(`v=${lua(w.value)}`);
      if (w.visible) f.push(`vis=${lua(w.visible)}`);
      if (w.tint) f.push(`tn=${lua(w.tint)}`);
      if (w.row !== undefined) f.push(`row=${w.row}`);
      if (w.sprite !== undefined) f.push(`sp=${w.sprite}`, `tw=${w.tiles?.[0] ?? 1}`, `th=${w.tiles?.[1] ?? 1}`);
      return `{${f.join(",")}}`;
    });
    const links = placed.map((_, i) => {
      const n = nav.get(i);
      return n ? `[${i + 1}]={${n.map((j) => j + 1).join(",")}}` : "";
    }).filter(Boolean);
    return `[${lua(doc.name)}]={w={${widgets.join(",\n")}},nav={${links.join(",")}},first=${first}}`;
  });
  return `do
local U = {}
local DOCS = {${tables.join(",\n")}}
local B, shown, focus, sel, on = {}, {}, {}, {}, {}
local function fill(s)
  return (string.gsub(s, "{(%w+)}", function(k) local v = B[k]; if v == nil then return "" end; return tostring(v) end))
end
local function isshown(n) for _, m in ipairs(shown) do if m == n then return true end end return false end
U.set = function(k, v) B[k] = v end
U.get = function(k) return B[k] end
U.show = function(n)
  if DOCS[n] and not isshown(n) then shown[#shown + 1] = n; if focus[n] == nil then focus[n] = DOCS[n].first end end
end
U.hide = function(n) for i = #shown, 1, -1 do if shown[i] == n then table.remove(shown, i) end end end
U.shown = function(n) return isshown(n) end
U.focus = function(n, id)
  local d = DOCS[n]
  if not d then return end
  for i, w in ipairs(d.w) do if w.id == id then focus[n] = i end end
end
U.focused = function(n) local d, f = DOCS[n], focus[n]; if d and f and f > 0 then return d.w[f].id end; return nil end
U.select = function(id, row) sel[id] = row end
U.selected = function(id) return sel[id] or 1 end
U.on = function(id, fn) on[id] = fn end
U.update = function()
  local n
  for i = #shown, 1, -1 do if DOCS[shown[i]].first > 0 then n = shown[i]; break end end
  if not n then return nil end
  local d, f = DOCS[n], focus[n] or 0
  if f == 0 then return nil end
  local w = d.w[f]
  if w.k == "list" then
    local count, s = #(B[w.v] or {}), sel[w.id] or 1
    if btnp(0) and s > 1 then sel[w.id] = s - 1; return nil end
    if btnp(1) and s < count then sel[w.id] = s + 1; return nil end
  elseif w.k == "slider" then
    local v = B[w.v] or 0
    if btnp(2) then B[w.v] = math.max(0, v - 0.1); return nil end
    if btnp(3) then B[w.v] = math.min(1, v + 0.1); return nil end
  end
  local links = d.nav[f]
  if links then for dir = 0, 3 do if btnp(dir) and links[dir + 1] > 0 then focus[n] = links[dir + 1]; return nil end end end
  if btnp(4) then
    local value = w.k == "list" and (sel[w.id] or 1) or (w.v and B[w.v])
    if on[w.id] then on[w.id](value) end
    return w.id, value
  end
  return nil
end
local function text(s, x, y, w, h, c, scale, small, align)
  local tw = print(s, 0, -64, 0, false, scale, small)
  local tx = x
  if align == 1 then tx = x + (w - tw) // 2 elseif align == 2 then tx = x + w - tw end
  local ty = h > 0 and y + (h - 6 * scale) // 2 or y
  print(s, tx, ty, c, false, scale, small)
end
local function drawdoc(n)
  local d = DOCS[n]
  local i, count = 1, #d.w
  while i <= count do
    local w = d.w[i]
    if w.vis and not B[w.vis] then
      i = i + w.skip + 1 -- it and everything under it
    else
      local focused = focus[n] == i
      local c = (w.tn and type(B[w.tn]) == "number") and B[w.tn] or (w.c or 12)
      local k = w.k
      if k == "panel" or k == "button" then
        local bg = (focused and k == "button" and w.ff) or w.f
        if bg then rect(w.x, w.y, w.w, w.h, bg) end
        if w.b then rectb(w.x, w.y, w.w, w.h, w.b) end
        if k == "button" and w.t then text(fill(w.t), w.x, w.y, w.w, w.h, (focused and w.fc) or c, w.s, w.sm, w.a) end
      elseif k == "text" then
        if w.f then rect(w.x, w.y, w.w, w.h, w.f) end
        if w.t then text(fill(w.t), w.x, w.y, w.w, w.h, c, w.s, w.sm, w.a) end
      elseif k == "bar" then
        if w.f then rect(w.x, w.y, w.w, w.h, w.f) end
        local v = math.max(0, math.min(1, tonumber(B[w.v]) or 0))
        local fw = math.floor((w.w - 4) * v)
        if fw > 0 then rect(w.x + 2, w.y + 2, fw, w.h - 4, c) end
        if w.b then rectb(w.x, w.y, w.w, w.h, w.b) end
      elseif k == "slider" then
        rect(w.x, w.y + w.h // 2 - 1, w.w, 2, w.f or 13)
        local v = math.max(0, math.min(1, tonumber(B[w.v]) or 0))
        rect(w.x + math.floor((w.w - 8) * v), w.y, 8, w.h, (focused and w.fc) or c)
      elseif k == "list" then
        if w.f then rect(w.x, w.y, w.w, w.h, w.f) end
        local items, row = B[w.v] or {}, w.row or 12
        local rows = math.max(1, w.h // row)
        local s = sel[w.id] or 1
        local top = math.max(1, s - rows + 1)
        for r = top, math.min(#items, top + rows - 1) do
          local item = items[r]
          local label, ic = item, c
          if type(item) == "table" then label, ic = item.text or "", item.color or c end
          local y = w.y + (r - top) * row
          if r == s and w.ff then rect(w.x, y, w.w, row - 2, w.ff) end
          text(tostring(label), w.x + 8, y, w.w - 16, row - 2, (r == s and w.fc) or ic, w.s, w.sm, w.a)
        end
      elseif k == "image" then
        local scale = math.max(1, w.w // (8 * w.tw))
        spr(w.sp, w.x, w.y, 0, scale, 0, 0, w.tw, w.th)
      end
      i = i + 1
    end
  end
end
U.draw = function() for _, n in ipairs(shown) do drawdoc(n) end end
cartbox.ui = U
end`;
}
