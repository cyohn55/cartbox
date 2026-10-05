/**
 * Input actions at run time (ENGINE_PARITY_ROADMAP.md EP15). The host works out
 * which of the cart's actions are held from every device (keys, controller
 * buttons, console buttons — with the player's rebinding applied) and writes
 * the mask into a small input block in the console's free RAM before every
 * tick, with the last tick's beside it:
 *
 *   +0  magic ("CBIA")       +4  actions held now (bit i = action i)       +8  held last tick
 *
 * It sits just below the debug block (see debugBlock.ts), in free RAM on every
 * core (on Classic, in the few hundred bytes TIC-80 leaves free before it).
 * The mask is recorded in replays above the 8 console-button bits, so a replay
 * plays the actions back too.
 *
 *   cartbox.action(name)    -> held now
 *   cartbox.actionp(name)   -> pressed this tick (held now, not last tick)
 *   cartbox.actionr(name)   -> released this tick
 *   cartbox.actions()       -> { name, ... } in bit order
 *   cartbox.actionlabel(name, device)   -> its bindings as a prompt reads them
 *                              ("G / Q"; device "pad" for the controller's, else the keyboard's)
 *
 * Before the host writes the block (or on a host that never does) an action
 * still answers from its console-button bindings, through btn().
 */

import { actionLabel, parseInputActions, type InputAction } from "@cartbox/editor";

import { debugBlockAddress } from "./debug/debugBlock.js";
import type { RamLayout } from "./physics/protocol.js";

export const INPUT_BLOCK_BYTES = 16;
export const INPUT_MAGIC = 0x41494243; // "CBIA"
export const INPUT_HELD = 4;
export const INPUT_PREVIOUS = 8;

/** Where the input block sits in Lua's RAM address space. */
export function inputBlockAddress(layout: RamLayout): number {
  return debugBlockAddress(layout) - INPUT_BLOCK_BYTES;
}

/** Write this tick's actions (and the last tick's) into the input block. */
export function writeInputBlock(block: DataView, held: number, previous: number): void {
  block.setUint32(0, INPUT_MAGIC, true);
  block.setUint32(INPUT_HELD, held >>> 0, true);
  block.setUint32(INPUT_PREVIOUS, previous >>> 0, true);
}

const lua = (s: string) => JSON.stringify(s);

/** The `cartbox.action*` Lua for a cart's actions, or "" when it has none. */
export function actionsSdkLua(actions: readonly InputAction[] | null | undefined, layout: RamLayout): string {
  if (!actions || actions.length === 0) return "";
  const names = actions.map((a) => lua(a.name));
  const idx = actions.map((a, i) => `[${lua(a.name)}]=${i}`);
  const buttons = actions.map((a) => `{${a.buttons.join(",")}}`);
  const keyLabels = actions.map((a) => lua(actionLabel(a, "keyboard")));
  const padLabels = actions.map((a) => lua(actionLabel(a, "pad")));
  return `do
local _A = ${inputBlockAddress(layout)}
local NAMES = {${names.join(",")}}
local IDX = {${idx.join(",")}}
local BTN = {${buttons.join(",")}}
local LK, LP = {${keyLabels.join(",")}}, {${padLabels.join(",")}}
local function rd(a) return peek(a) | (peek(a + 1) << 8) | (peek(a + 2) << 16) | (peek(a + 3) << 24) end
local function index(n) if type(n) == "number" then return n end return IDX[n] end
local function any(i, f) for _, b in ipairs(BTN[i + 1] or {}) do if f(b) then return true end end return false end
-- now, before (nil for an unknown action); without the host, from the console buttons.
local function state(n)
  local i = index(n)
  if i == nil or i < 0 or i >= #NAMES then return nil end
  if rd(_A) ~= ${INPUT_MAGIC} then
    local now = any(i, btn)
    return now, now and not any(i, btnp)
  end
  return (rd(_A + ${INPUT_HELD}) >> i) & 1 == 1, (rd(_A + ${INPUT_PREVIOUS}) >> i) & 1 == 1
end
cartbox.action = function(n) local now = state(n) return now == true end
cartbox.actionp = function(n) local now, before = state(n) return now == true and not before end
cartbox.actionr = function(n) local now, before = state(n) return now == false and before == true end
cartbox.actions = function() local out = {} for i, v in ipairs(NAMES) do out[i] = v end return out end
cartbox.actionlabel = function(n, device)
  local i = index(n)
  if i == nil then return "" end
  return (device == "pad" and LP or LK)[i + 1] or ""
end
end`;
}

/** A stored scene sidecar's input actions (EP15): what the host hands the player as its `actions` option. */
export function readSidecarActions(raw: string | null | undefined): InputAction[] {
  if (!raw) return [];
  try {
    return parseInputActions((JSON.parse(raw) as { actions?: unknown }).actions);
  } catch {
    return [];
  }
}
