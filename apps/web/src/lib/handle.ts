/**
 * Username (profile handle) validation — shared by the signup form and the
 * availability API so the rules live in one place. A handle is the public
 * `@handle` in URLs (`/profile/[handle]`), so it must be URL-safe, lowercase,
 * and not collide with a route segment.
 *
 * Pure (no imports), so both client and server use it and unit tests drive it
 * directly.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** Route segments and system names a handle must not shadow. */
const RESERVED_HANDLES = new Set([
  "admin",
  "api",
  "browse",
  "cartbox",
  "console",
  "edit",
  "help",
  "jams",
  "login",
  "me",
  "new",
  "onboarding",
  "play",
  "profile",
  "replay",
  "settings",
  "support",
]);

/** Lowercase and trim a raw username into its canonical form. */
export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Return a human-readable reason a handle is invalid, or null when it is valid.
 * Expects an already-normalized handle.
 */
export function handleError(handle: string): string | null {
  if (handle.length < HANDLE_MIN) return `At least ${HANDLE_MIN} characters.`;
  if (handle.length > HANDLE_MAX) return `At most ${HANDLE_MAX} characters.`;
  if (!/^[a-z]/.test(handle)) return "Must start with a letter.";
  if (!/^[a-z0-9_]+$/.test(handle)) return "Use letters, numbers, and underscores only.";
  if (RESERVED_HANDLES.has(handle)) return "That username is reserved.";
  return null;
}

/** Whether a normalized handle passes every rule. */
export function isValidHandle(handle: string): boolean {
  return handleError(handle) === null;
}
