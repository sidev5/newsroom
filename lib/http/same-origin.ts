// Protection of the routes that change something and are driven by cookies (likes, comments, sign-in): the request must
// come from a page of this site. Browsers put an Origin header on every cross-site POST and a Sec-Fetch-Site header on
// every request, and neither can be set by another site's script. Used together with SameSite=Lax cookies.

type HeaderSource = { get(name: string): string | null };

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The address the visitor used, as the platform's proxy reports it. */
function requestHost(headers: HeaderSource): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return (forwarded || headers.get("host") || "").toLowerCase() || null;
}

/**
 * True when the request was made by a page of this site: its Origin has the same host as the request, or (no Origin, as some
 * browsers omit it on same-origin GET-like requests) the browser says Sec-Fetch-Site: same-origin. A missing Origin without
 * that header is refused, so a plain script (curl) has to send a matching Origin on purpose, which is no protection against
 * itself but also no hole for a browser.
 */
export function sameOrigin(headers: HeaderSource): boolean {
  const origin = headers.get("origin");
  if (origin) {
    const o = hostOf(origin);
    return o !== null && o === requestHost(headers);
  }
  return headers.get("sec-fetch-site") === "same-origin";
}
