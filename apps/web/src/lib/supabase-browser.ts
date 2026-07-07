/**
 * Browser Supabase client (singleton). Manages the auth session in cookies and
 * lets client components read the current access token so authenticated API
 * calls (submitting a score/replay, saving an avatar) can be attributed to the
 * signed-in user.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isStaticExport } from "./staticSite";

let client: SupabaseClient | undefined;

/** The shared browser Supabase client (auth session stored in cookies). */
export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return client;
}

function browserClient(): SupabaseClient {
  return supabaseBrowser();
}

/** Returns the current access token, or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  // The static demo build ships without Supabase credentials — everyone is
  // anonymous, and constructing the client would throw on the missing env.
  if (isStaticExport) {
    return null;
  }
  const { data } = await browserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/** Builds fetch headers with the bearer token when available. */
export async function authHeaders(base: HeadersInit = {}): Promise<HeadersInit> {
  const token = await getAccessToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}
