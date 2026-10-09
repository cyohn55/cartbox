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
 *                                                       (a list's selected row as its value).
 *                                                       The pointer works too (pointer.ts):
 *                                                       pointing focuses a button or a list
 *                                                       row, a click (or tap) presses it, and
 *                                                       a slider follows a click or drag
 *   cartbox.ui.on(id, function(value) ... end)          or have it called instead
 *   cartbox.ui.focus(name, id) / focused(name)          set or read where focus is
 *   cartbox.ui.select(id, row) / selected(id)           a list's selected row (1-based)
 *   cartbox.ui.draw()                                   draw every shown document, in the
 *                                                       order they were shown
 */

import { FOCUSABLE, holoBindingKeys, holoDocuments, layoutUi, parseUiDocuments, uiNavigation, type UiDocument } from "@cartbox/editor";

import { PHYS_OP_UI_LIST, PHYS_OP_UI_NUM, PHYS_OP_UI_SHOW, PHYS_OP_UI_TEXT } from "./physics/protocol.js";
import { POINTER_AT, POINTER_CLICKS, POINTER_FLAGS, POINTER_MAGIC, POINTER_X, POINTER_Y } from "./pointer.js";

/** The longest string a holo binding carries to the host (characters). */
export const HOLO_TEXT_MAX = 240;
/** The most numbers a holo list binding carries. */
export const HOLO_LIST_MAX = 192;

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

/**
 * The `cartbox.ui` Lua for a cart's documents on a `width × height` screen, or
 * "" when it has none. With `debugBlock` (the debug block's address), it reads
 * the pointer the host writes there (pointer.ts).
 */
export function uiSdkLua(docs: readonly UiDocument[] | null | undefined, width: number, height: number, debugBlock?: number | null): string {
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
  const holo = holoDocuments(docs);
  const holoMap = holo.map((d, i) => `[${lua(d.name)}]=${i}`).join(",");
  const keyMap = holoBindingKeys(docs).map((k, i) => `[${lua(k)}]=${i}`).join(",");
  // The same names in order: the flush walks these, never pairs(), so every core sends in one order.
  const holoNames = holo.map((d) => lua(d.name)).join(",");
  const keyNames = holoBindingKeys(docs).map(lua).join(",");
  return `do
local U = {}
local DOCS = {${tables.join(",\n")}}
local B, shown, focus, sel, on = {}, {}, {}, {}, {}
local function fill(s)
  -- "@key": the string table's text for it (EP19b), in the current language.
  if string.sub(s, 1, 1) == "@" then s = cartbox.text(string.sub(s, 2)) end
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
-- The pointer (pointer.ts): where it is, whether it moved, and whether it clicked since the last update.
local _P = ${debugBlock ?? "nil"}
local plast, ptime, px, py, pdown, pclick, pmoved
local function rd16(a) local v = peek(a) | (peek(a + 1) << 8); if v >= 32768 then v = v - 65536 end return v end
local function pointer()
  if not _P or (peek(_P + ${POINTER_AT}) | (peek(_P + ${POINTER_AT + 1}) << 8) | (peek(_P + ${POINTER_AT + 2}) << 16) | (peek(_P + ${POINTER_AT + 3}) << 24)) ~= ${POINTER_MAGIC} then return false end
  local x, y, f, c, now = rd16(_P + ${POINTER_X}), rd16(_P + ${POINTER_Y}), peek(_P + ${POINTER_FLAGS}), peek(_P + ${POINTER_CLICKS}), time()
  -- A click from before this document was being updated (a frame or more ago) isn't for it.
  if plast == nil or ptime == nil or now - ptime > 50 then plast = c end
  pclick, plast, ptime = c ~= plast, c, now
  pmoved = x ~= px or y ~= py
  px, py, pdown = x, y, f & 2 == 2
  return f & 1 == 1
end
-- The focusable widget under (x, y): the last drawn, so the topmost.
local function hit(d, x, y)
  local found, i, count = nil, 1, #d.w
  while i <= count do
    local w = d.w[i]
    if w.vis and not B[w.vis] then i = i + w.skip + 1
    else
      if (w.k == "button" or w.k == "list" or w.k == "slider") and x >= w.x and y >= w.y and x < w.x + w.w and y < w.y + w.h then found = i end
      i = i + 1
    end
  end
  return found
end
local function press(w)
  local value = w.k == "list" and (sel[w.id] or 1) or (w.v and B[w.v])
  if on[w.id] then on[w.id](value) end
  return w.id, value
end
U.update = function()
  local n
  for i = #shown, 1, -1 do if DOCS[shown[i]].first > 0 then n = shown[i]; break end end
  local over = pointer()
  if not n then return nil end
  local d, f = DOCS[n], focus[n] or 0
  if over and (pclick or pmoved or pdown) then
    local i = hit(d, px, py)
    if i then
      local w = d.w[i]
      if pclick or pmoved then focus[n] = i; f = i end
      if w.k == "list" then
        local items, row = B[w.v] or {}, w.row or 12
        local s = sel[w.id] or 1
        local r = math.max(1, s - math.max(1, w.h // row) + 1) + (py - w.y) // row
        if r >= 1 and r <= #items and (pclick or pmoved) then
          sel[w.id] = r
          if pclick then return press(w) end
        end
      elseif w.k == "slider" then
        if pclick or pdown then B[w.v] = math.max(0, math.min(1, (px - w.x) / math.max(1, w.w - 1))) end
      elseif pclick then return press(w) end
      if pclick then return nil end
    end
  end
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
  if btnp(4) then return press(w) end
  return nil
end
local function text(s, x, y, w, h, c, scale, small, align)
  -- The player's text size (EP19b), stepped back down while it would overflow the box.
  local ts = cartbox.textscale()
  if ts ~= 1 then
    local big = math.max(scale, math.floor(scale * ts + 0.5))
    local one = print(s, 0, -64, 0, false, 1, small)
    while big > scale and ((w > 0 and one * big > w) or (h > 0 and 6 * big > h)) do big = big - 1 end
    scale = big
  end
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
-- Holo documents (I12) are drawn by the host, in true colour: it hears which are
-- shown and what their bindings hold, once a frame, as commands (cartbox._cmd,
-- from the runtime). Without the runtime they fall back to the console's drawing.
local HOLO = {${holoMap}}
local HK = {${keyMap}}
local HOLON, HKN = {${holoNames}}, {${keyNames}}
local hsent, sentv, dirty = {}, {}, {}
for _, k in ipairs(HKN) do dirty[k] = true end
local function sig(v)
  if type(v) == "table" then
    local parts = {}
    for i, item in ipairs(v) do parts[i] = type(item) == "table" and tostring(item.text) or tostring(item) end
    return "t" .. table.concat(parts, "\\1")
  end
  return type(v) .. tostring(v)
end
local function sendtext(cmd, key, s)
  s = string.sub(s, 1, ${HOLO_TEXT_MAX})
  local codes = {}
  for i = 1, #s, 2 do codes[#codes + 1] = string.byte(s, i) * 256 + (string.byte(s, i + 1) or 0) end
  local ok = cmd(${PHYS_OP_UI_TEXT}, key, #s, codes[1], codes[2], codes[3], codes[4], codes[5])
  local chunk, at = 1, 6
  while ok and at <= #codes do
    ok = cmd(${PHYS_OP_UI_TEXT}, key | (chunk << 16), codes[at], codes[at + 1], codes[at + 2], codes[at + 3], codes[at + 4], codes[at + 5])
    chunk, at = chunk + 1, at + 6
  end
  return ok
end
local function sendlist(cmd, key, t)
  local n = math.min(#t, ${HOLO_LIST_MAX})
  local ok = cmd(${PHYS_OP_UI_LIST}, key, n, t[1], t[2], t[3], t[4], t[5])
  local chunk, at = 1, 6
  while ok and at <= n do
    ok = cmd(${PHYS_OP_UI_LIST}, key | (chunk << 16), t[at], at + 1 <= n and t[at + 1] or 0, at + 2 <= n and t[at + 2] or 0, at + 3 <= n and t[at + 3] or 0, at + 4 <= n and t[at + 4] or 0, at + 5 <= n and t[at + 5] or 0)
    chunk, at = chunk + 1, at + 6
  end
  return ok
end
local function sendval(cmd, key, v)
  if type(v) == "number" then return cmd(${PHYS_OP_UI_NUM}, key, v) end
  if type(v) == "boolean" or v == nil then return cmd(${PHYS_OP_UI_NUM}, key, v and 1 or 0) end
  if type(v) == "table" then
    local nums = true
    for _, item in ipairs(v) do if type(item) ~= "number" then nums = false end end
    if nums then return sendlist(cmd, key, v) end
    -- A list of texts: one string, a row a line.
    local rows = {}
    for i, item in ipairs(v) do rows[i] = type(item) == "table" and tostring(item.text or "") or tostring(item) end
    return sendtext(cmd, key, table.concat(rows, "\\n"))
  end
  local text = tostring(v)
  if string.sub(text, 1, 1) == "@" then text = cartbox.text(string.sub(text, 2)) end
  return sendtext(cmd, key, text)
end
local function hflush()
  local cmd = cartbox._cmd
  if not cmd then return false end
  for i, n in ipairs(HOLON) do
    i = i - 1
    local want = isshown(n)
    if hsent[n] ~= want and cmd(${PHYS_OP_UI_SHOW}, i, want and 1 or 0) then hsent[n] = want end
  end
  for _, k in ipairs(HKN) do
    if dirty[k] then
      local v = B[k]
      local s = sig(v)
      if s == sentv[k] then dirty[k] = nil
      elseif sendval(cmd, HK[k], v) then sentv[k] = s; dirty[k] = nil end
    end
  end
  return true
end
local plainset = U.set
U.set = function(k, v) plainset(k, v); if HK[k] then dirty[k] = true end end
U.draw = function()
  local host = hflush()
  for _, n in ipairs(shown) do if not (host and HOLO[n]) then drawdoc(n) end end
end
cartbox.ui = U
end`;
}
