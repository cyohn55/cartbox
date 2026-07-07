/**
 * Cartridge fetching.
 *
 * Single responsibility: turn a cartridge URL into validated bytes. It knows
 * nothing about the engine or rendering, so it can be reused by the gallery,
 * thumbnail renderer, or any other consumer.
 */

/** Raised when a cartridge cannot be fetched or is obviously not a cartridge. */
export class CartridgeLoadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CartridgeLoadError";
  }
}

/** Smallest plausible cartridge; anything shorter is a fetch/routing error, not a cart. */
const MINIMUM_CARTRIDGE_BYTES = 4;

/**
 * Fetches a `.tic` cartridge and returns its raw bytes.
 *
 * @param cartUrl Absolute or relative URL of the cartridge.
 * @param signal Optional AbortSignal so callers can cancel navigation-away loads.
 * @throws {CartridgeLoadError} on network failure, non-2xx status, or empty payload.
 */
export async function fetchCartridge(cartUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(cartUrl, { signal });
  } catch (networkError) {
    throw new CartridgeLoadError(`Failed to reach cartridge at ${cartUrl}`, networkError);
  }

  if (!response.ok) {
    throw new CartridgeLoadError(`Cartridge request failed (${response.status}) for ${cartUrl}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MINIMUM_CARTRIDGE_BYTES) {
    throw new CartridgeLoadError(`Cartridge at ${cartUrl} is empty or truncated`);
  }

  return bytes;
}
