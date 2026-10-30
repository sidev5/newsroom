import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_ACTIVITY_COOKIE, adminLimits, checkActivity, markerCookieOptions, markerSecret, signMarker } from "@/lib/admin/activity";
import { LOGIN_EXPIRED_PATH } from "@/lib/admin/messages";
import { adminAllowed } from "@/lib/admin/network";
import { type CookieToSet, hardenCookies, isHttps, sessionCookieOptions } from "@/lib/supabase/cookies";

/**
 * Keeps the Supabase session fresh on /admin pages (server components can't write cookies), sends signed-out
 * visitors to the login page, and enforces the admin session limits: signed out after ADMIN_IDLE_MINUTES
 * without a request (default 30) or ADMIN_SESSION_HOURS after signing in (default 8). A signed marker cookie
 * carries the two times and is refreshed on every admin request. The admin check itself still lives in the
 * admin layout, in each page and in every server action (currentAdminEmail checks the marker again).
 */
export async function proxy(request: NextRequest) {
  // Self-hosted with SELF_HOST_ADMIN=localhost (the default there): other machines do not learn /admin exists.
  if (!adminAllowed(request.headers)) return new NextResponse("Not found", { status: 404 });
  const path = request.nextUrl.pathname;
  const secure = isHttps(request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol);
  const limits = adminLimits();
  const settings = { secure, maxAgeSeconds: Math.floor(limits.absoluteMs / 1000) };

  // Cookies the Supabase client wants to set (a refreshed session, or a sign-out) are collected and put on
  // whichever response is returned at the end.
  const pending: CookieToSet[] = [];
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: sessionCookieOptions(secure),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const c of hardenCookies(cookiesToSet, settings)) {
          request.cookies.set(c.name, c.value);
          pending.push(c);
        }
      },
    },
  });

  const apply = (response: NextResponse) => {
    for (const c of pending) response.cookies.set(c.name, c.value, c.options);
    return response;
  };

  const { data } = await supabase.auth.getUser();

  // The login page must stay reachable without a session.
  if (path === "/admin/login") return apply(NextResponse.next({ request }));
  if (!data.user) return apply(NextResponse.redirect(new URL("/admin/login", request.url)));

  const secret = markerSecret();
  const now = Date.now();
  const verdict = await checkActivity(secret, request.cookies.get(ADMIN_ACTIVITY_COOKIE)?.value, now, limits);

  if (!verdict.ok || !secret) {
    // Too old (or no valid marker): end the session on the server, clear every auth cookie and go to the login page.
    try {
      await supabase.auth.signOut();
    } catch {
      // the cookies are cleared below either way
    }
    const response = NextResponse.redirect(new URL(LOGIN_EXPIRED_PATH, request.url));
    for (const { name } of request.cookies.getAll()) {
      if (name.startsWith("sb-") || name === ADMIN_ACTIVITY_COOKIE) {
        response.cookies.set(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure });
      }
    }
    return response;
  }

  // Still inside both limits: slide the idle window forward.
  const response = apply(NextResponse.next({ request }));
  response.cookies.set(ADMIN_ACTIVITY_COOKIE, await signMarker(secret, { start: verdict.marker.start, last: now }), markerCookieOptions(secure, limits));
  return response;
}

export const config = { matcher: ["/admin/:path*"] };
