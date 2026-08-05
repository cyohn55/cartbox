/**
 * The cart-facing tile-flags accessor, as injectable Lua.
 *
 * Like the collision accessor (see collisionSdk.ts), a cart's flags layer is host
 * data the cart reads and it never changes during play, so the whole byte grid is
 * injected once as Lua data plus a `cartbox.flag(cx, cy, n)` accessor — no
 * per-frame protocol. Flag `n` is 0..7; the cart decides what each means (hazard,
 * ladder, one-way platform, water, trigger zones, …).
 *
 * Pure and import-free so it can be unit-tested on its own inputs and outputs; the
 * player prepends the returned string after the base SDK, so the `cartbox` table
 * already exists when this overrides its `flag` stub.
 *
 * Every arithmetic operand feeding a bitwise operator is forced to an integer, so
 * the Pro core's bitwise-of-float trap can never abort TIC() mid-frame (see the
 * `lua-bitwise-float-trap` note).
 */

/** The runtime shape of a tile-flags layer the player consumes. */
export interface FlagsField {
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** Base64 of the row-major, one-byte-per-cell flag bytes (as TileFlags serialises). */
  bytes: string;
}

/**
 * Validate an untrusted value (e.g. a cart row's `flags` column) as a FlagsField,
 * returning null when it is absent or malformed — the same defensive contract as
 * parseCollisionField / parseScene.
 */
export function parseFlagsField(value: unknown): FlagsField | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.width !== "number" || typeof data.height !== "number") return null;
  if (typeof data.bytes !== "string") return null;
  if (data.width <= 0 || data.height <= 0 || !Number.isFinite(data.width) || !Number.isFinite(data.height)) {
    return null;
  }
  return { width: Math.floor(data.width), height: Math.floor(data.height), bytes: data.bytes };
}

/**
 * Build the Lua that exposes a cart's flags layer as `cartbox.flag(cx, cy, n)`
 * (true when flag n is set on that cell, false out of bounds or n outside 0..7).
 * Returns an empty string when there is no usable layer, so the caller injects
 * nothing and the base SDK's no-op stub remains.
 */
export function flagsSdkLua(flags: FlagsField | null | undefined): string {
  const field = parseFlagsField(flags);
  if (!field || field.bytes.length === 0) return "";

  const width = field.width;
  const height = field.height;
  return `do
  local _fw, _fh = ${width}, ${height}
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
  local _fb = _b64("${field.bytes}")
  cartbox = cartbox or {}
  cartbox.flag = function(x, y, n)
    x = math.floor(x or 0)
    y = math.floor(y or 0)
    n = math.floor(n or 0)
    if x < 0 or x >= _fw or y < 0 or y >= _fh or n < 0 or n > 7 then return false end
    local byte = string.byte(_fb, y * _fw + x + 1) or 0
    return ((byte >> n) & 1) ~= 0
  end
end`;
}
