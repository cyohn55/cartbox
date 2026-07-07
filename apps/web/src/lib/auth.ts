/**
 * Server-side session resolution.
 *
 * Extracts the Supabase access token from the request (Authorization: Bearer
 * <jwt>, as sent by the browser client) and returns the authenticated user id,
 * or null if the request is anonymous or the token is invalid.
 */

import { anonClient } from "@/lib/supabase";

/** Returns the authenticated user's id, or null when unauthenticated. */
export async function getSessionUserId(request: Request): Promise<string | null> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) {
    return null;
  }

  const { data, error } = await anonClient().auth.getUser(token);
  if (error || !data.user) {
    return null;
  }
  return data.user.id;
}
