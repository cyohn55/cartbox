/**
 * Worker configuration and environment access. Centralizes required-var lookup
 * so a missing setting fails fast with a clear message at startup.
 */

/** Audio sample rate for the headless console (unused for rendering, but required by the core). */
export const DEFAULT_SAMPLE_RATE = 44100;

/** Number of carts a single worker pass claims and renders. */
export const DEFAULT_BATCH_SIZE = 10;

/** Returns a required environment variable or throws. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Resolves the local engine module path for a model. Per-model builds can be set
 * via `ENGINE_URL_<MODEL>`; falls back to the single `ENGINE_URL` (the classic
 * build) when a model-specific one is not configured.
 */
export function resolveEngineUrl(modelId: string): string {
  return process.env[`ENGINE_URL_${modelId.toUpperCase()}`] ?? requiredEnv("ENGINE_URL");
}
