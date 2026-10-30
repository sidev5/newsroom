import "server-only";
import { cookies, headers } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { adminLimits } from "@/lib/admin/activity";
import { hardenCookies, isHttps, sessionCookieOptions } from "./cookies";

/**
 * Anon-key client bound to the request's auth cookies. Subject to RLS:
 * public pages see only published articles. Create one per request.
 * Session cookies it writes are HttpOnly, SameSite=Lax, Secure on https, and live no longer than the
 * absolute admin session limit.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  const secure = isHttps((await headers()).get("x-forwarded-proto"));
  const settings = { secure, maxAgeSeconds: Math.floor(adminLimits().absoluteMs / 1000) };
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: sessionCookieOptions(secure),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            hardenCookies(cookiesToSet, settings).forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The proxy refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}
