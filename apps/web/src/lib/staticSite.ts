/**
 * Static-site ("demo") build mode.
 *
 * When NEXT_PUBLIC_STATIC_EXPORT=1 the app compiles with `output: "export"`
 * for static hosts such as GitHub Pages. In this mode there is no server:
 * API routes, auth, checkout, and the community database are unavailable, so
 * pages read cart data from the baked-in demo catalog instead of Supabase and
 * the editor persists work to the browser's localStorage.
 *
 * Both flags are inlined at build time (NEXT_PUBLIC_*), so client and server
 * components see the same values.
 */

export const isStaticExport = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

/**
 * Base path the site is served under. GitHub Pages project sites live at
 * https://<user>.github.io/<repo>, so the deploy sets this to "/<repo>".
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Prefixes a root-relative asset URL with the configured base path.
 *
 * next/link handles the base path automatically, but plain string URLs (WASM
 * engine scripts, cart binaries fetched at runtime) do not — every such URL
 * must flow through here so the app works both at the domain root and under
 * a GitHub Pages project path.
 */
export function withBasePath(path: string): string {
  if (!basePath || !path.startsWith("/")) {
    return path;
  }
  return `${basePath}${path}`;
}
