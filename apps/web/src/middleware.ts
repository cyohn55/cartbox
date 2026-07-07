/**
 * Session-refresh middleware.
 *
 * Server components cannot write cookies, so refreshed Supabase auth tokens are
 * persisted here on every request. Calling getUser() triggers the refresh; the
 * updated cookies are copied onto the response. Without this, sessions would
 * silently expire on server-rendered pages.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
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
    },
  );

  // Triggers a token refresh if needed and writes cookies via setAll above.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Run on all paths except static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
