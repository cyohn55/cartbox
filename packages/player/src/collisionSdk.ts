/**
 * The cart-facing collision accessor, as injectable Lua.
 *
 * A cart's collision layer is authored in the editor and stored as a sidecar (a
 * packed per-cell bitmap, see @cartbox/editor's CollisionMap). Unlike the lights
 * SDK — where the cart writes to the host through the mailbox — collision is host
 * data the cart *reads*, and it never changes during play, so the whole bitmap is
 * injected once as Lua data plus a `cartbox.solid(x, y)` / `cartbox.mapsize()`
 * accessor. A cart then does its own physics against it with no per-frame
 * protocol.
 *
 * Pure and import-free so it can be unit-tested on its own inputs and outputs;
 * the player is what prepends the returned string (after the base SDK, so the
 * `cartbox` table already exists when this overrides its solid/mapsize stubs).
 *
 * Every arithmetic operand feeding a bitwise operator is forced to an integer
 * (via math.floor or an integer literal): the Pro core's Lua throws on a bitwise
 * op applied to a float, which would abort TIC() mid-frame (see the
 * `lua-bitwise-float-trap` note).
 */

/** The runtime shape of a collision layer the player consumes. */
export interface CollisionField {
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** Base64 of the row-major, LSB-first packed solidity bits (as CollisionMap serialises). */
  bits: string;
}

/**
 * Validate an untrusted value (e.g. a cart row's `collision` column) as a
 * CollisionField, returning null when it is absent or malformed — the same
 * defensive contract as parseScene / parseParticles.
 */
export function parseCollisionField(value: unknown): CollisionField | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.width !== "number" || typeof data.height !== "number") return null;
  if (typeof data.bits !== "string") return null;
  if (data.width <= 0 || data.height <= 0 || !Number.isFinite(data.width) || !Number.isFinite(data.height)) {
    return null;
  }
  return { width: Math.floor(data.width), height: Math.floor(data.height), bits: data.bits };
}

/**
 * Build the Lua that exposes a cart's collision layer as `cartbox.solid(x, y)`
 * (true when the cell is solid, false out of bounds) and `cartbox.mapsize()`.
 * Returns an empty string when there is no usable layer, so the caller injects
 * nothing and the base SDK's no-op stubs remain.
 */
export function collisionSdkLua(collision: CollisionField | null | undefined): string {
  const field = parseCollisionField(collision);
  if (!field || field.bits.length === 0) return "";

  const width = field.width;
  const height = field.height;
  // The stored bits are already base64 and contain only [A-Za-z0-9+/=], none of
  // which are special inside a Lua double-quoted string, so they embed directly.
  return `do
  local _cw, _ch = ${width}, ${height}
  local function _b64(s)
    local _T = {}
    local _A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for i = 1, #_A do _T[string.byte(_A, i)] = i - 1 end
    local out, acc, bits = {}, 0, 0
    for i = 1, #s do
      local v = _T[string.byte(s, i)]
      if v then
        acc = (acc << 6) | v
        bits = bits + 6
        if bits >= 8 then
          bits = bits - 8
          out[#out + 1] = string.char((acc >> bits) & 0xff)
          acc = acc & ((1 << bits) - 1)
        end
      end
    end
    return table.concat(out)
  end
  local _cb = _b64("${field.bits}")
  cartbox = cartbox or {}
  cartbox.mapsize = function() return _cw, _ch end
  cartbox.solid = function(x, y)
    x = math.floor(x or 0)
    y = math.floor(y or 0)
    if x < 0 or x >= _cw or y < 0 or y >= _ch then return false end
    local cell = y * _cw + x
    local byte = string.byte(_cb, (cell >> 3) + 1) or 0
    return (byte & (1 << (cell & 7))) ~= 0
  end
end`;
}
