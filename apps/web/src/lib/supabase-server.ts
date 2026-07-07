/**
 * Supabase client for server components and route handlers, backed by the
 * request cookies (SSR auth). This is how server-rendered pages know who the
 * logged-in user is — the browser client stores the session in cookies, and
 * @supabase/ssr reads them here.
 *
 * Token refresh happens in middleware (see middleware.ts); server components
 * cannot write cookies, so the setAll below is a no-op there and relied upon in
 * route handlers.
 */

import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Creates a request-scoped Supabase client bound to the current cookies. */
export async function serverClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Middleware performs the refresh write instead.
        }
      },
    },
  });
}

/**
 * Returns the authenticated user's id from the request cookies, or null when
 * the visitor is not signed in.
 */
export async function getServerUserId(): Promise<string | null> {
  const supabase = await serverClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}
