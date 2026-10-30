// Cookie attributes for the Supabase session (ADM-02), as strict as @supabase/ssr allows. The library fixes
// the lifetime of the session cookie at 400 days whatever is passed in `cookieOptions`, so the lifetime is
// clamped here, in the setAll callback of each server client.

export type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

export type SessionCookieSettings = {
  /** Serve the cookies with the Secure attribute (true whenever the site is on https). */
  secure: boolean;
  /** Upper bound for the cookie lifetime, in seconds (the absolute admin session limit). */
  maxAgeSeconds: number;
};

/** Options handed to createServerClient({ cookieOptions }). */
export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
}

/**
 * Applies the strict attributes to a cookie the library wants to write. A deletion (maxAge 0 or an expiry in the
 * past) stays a deletion; everything else is HttpOnly, SameSite=Lax, Secure on https, and lives at most
 * `maxAgeSeconds`.
 */
export function hardenCookies(cookies: CookieToSet[], settings: SessionCookieSettings): CookieToSet[] {
  return cookies.map(({ name, value, options }) => {
    const maxAge = typeof options?.maxAge === "number" ? options.maxAge : undefined;
    const deleting = maxAge === 0 || (maxAge !== undefined && maxAge < 0) || value === "";
    return {
      name,
      value,
      options: {
        ...options,
        httpOnly: true,
        sameSite: "lax",
        secure: settings.secure,
        path: typeof options?.path === "string" ? options.path : "/",
        maxAge: deleting ? 0 : Math.min(maxAge ?? settings.maxAgeSeconds, settings.maxAgeSeconds),
      },
    };
  });
}

/** True when the request reached the app over https (directly or behind a proxy that says so). */
export function isHttps(proto: string | null | undefined, nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  const p = proto?.split(",")[0]?.trim().replace(/:$/, "").toLowerCase();
  if (p) return p === "https";
  return nodeEnv === "production";
}
