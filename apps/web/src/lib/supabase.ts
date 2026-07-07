/**
 * Supabase clients. Two flavours with different privileges:
 *   - anon client: for browser/RLS-scoped reads.
 *   - service client: for trusted server routes that must bypass RLS
 *     (publishing, granting entitlements from webhooks).
 *
 * The service key must never reach the browser — only import `serviceClient`
 * from server-only modules (route handlers, server actions).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Supabase speaks REST over fetch, and Next.js caches fetch GETs in its
 * persistent Data Cache by default — which would serve stale rows (e.g. a
 * just-saved cart missing from Browse). Database reads must always be live,
 * so every Supabase request opts out of the cache.
 */
const liveFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

/** Anonymous client — safe for the browser; all access flows through RLS. */
export function anonClient(): SupabaseClient {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    global: { fetch: liveFetch },
  });
}

/** Service-role client — server-only; bypasses RLS. Never expose to the client. */
export function serviceClient(): SupabaseClient {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
    global: { fetch: liveFetch },
  });
}
