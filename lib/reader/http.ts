import { sameOrigin } from "@/lib/http/same-origin";
import { isHttps } from "@/lib/supabase/cookies";

// Shared by the routes of the reader sign-in, likes and comments.

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** The HTTP status of a failure kind. */
export const STATUS = { not_found: 404, auth: 401, invalid: 422, limited: 429, server: 500 } as const;

/** Slugs are lowercase letters, digits and dashes (the same rule as /api/story/[slug]). */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * The checks every changing request passes first: it comes from a page of this site (Origin / Sec-Fetch-Site), and it is JSON
 * (a cross-site form cannot send JSON without a preflight). Returns the refusal, or null.
 */
export function refuseUnlessSameSiteJson(request: Request): Response | null {
  if (!sameOrigin(request.headers)) return json({ ok: false, error: "This request did not come from the site." }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ ok: false, error: "Unsupported request." }, 415);
  return null;
}

/** The JSON body, at most 8 KB, or null when it is missing, too large or not JSON. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 8192) return null;
  try {
    const text = await request.text();
    if (text.length > 8192) return null;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const secureRequest = (request: Request) => isHttps(request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol);