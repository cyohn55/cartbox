/**
 * Session-refresh middleware.
 *
 * Server components cannot write cookies, so refreshed Supabase auth tokens are
 * persisted here on every request. Calling getUser() triggers the refresh; the
 * updated cookies are copied onto the response. Without this, sessions would
 * silently expire on server-rendered pages.
 *
 * Refreshing a session is an *enhancement*, never a precondition for serving a
 * page. Middleware runs in front of every matched route, so anything thrown
 * here is not one broken page — it is `MIDDLEWARE_INVOCATION_FAILED` (HTTP 500)
 * on all of them, the whole site down. A deployment that is missing its
 * Supabase credentials, or whose auth host is briefly unreachable, must still
 * serve the site signed-out. Hence: read the credentials instead of asserting
 * them, and treat a failed refresh as "not signed in".
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/** The credentials the session refresh needs, or null if unconfigured. */
export interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

/**
 * Reads the Supabase credentials from an environment.
 *
 * Returns null when either is absent or blank, which is what distinguishes an
 * unconfigured deployment (serve signed-out) from a configured one. Takes the
 * environment as an argument so the decision is testable without mutating the
 * process's own.
 */
export function readSupabaseCredentials(
  env: Record<string, string | undefined>,
): SupabaseCredentials | null {
  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();

  return url && anonKey ? { url, anonKey } : null;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const credentials = readSupabaseCredentials(process.env);
  if (!credentials) {
    return response;
  }

  try {
    const supabase = createServerClient(credentials.url, credentials.anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    // Triggers a token refresh if needed and writes cookies via setAll above.
    await supabase.auth.getUser();
  } catch {
    // An unreachable or misconfigured auth host means the visitor is not signed
    // in — it does not mean the page cannot be rendered. Fall through with
    // whatever response we hold rather than failing the invocation.
  }

  return response;
}

export const config = {
  // Run on all paths except Next's own static output and the assets served
  // straight out of public/: the WASM cores under /engine and the emulated-game
  // bundle roots (which `next.config.mjs` may rewrite to the game CDN).
  //
  // Those are anonymous byte serving — a session refresh cannot change the
  // response, and running one per request adds a Supabase round-trip and a
  // failure mode to every chunk of a multi-hundred-megabyte game download.
  //
  // Next requires this to be a static literal, so the bundle roots cannot be
  // imported from next.config.mjs; "Unit Tests/middleware-matcher.test.ts"
  // asserts the two lists still agree.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|engine/|quake/|cube2/|scummvm/|supertux/|dosbox/|games/|opentyrian/|openttd/|cavestory/).*)",
  ],
};
