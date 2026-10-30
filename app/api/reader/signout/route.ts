import { clearedCookie } from "@/lib/reader/identity";
import { json, secureRequest } from "@/lib/reader/http";
import { sameOrigin } from "@/lib/http/same-origin";

export const dynamic = "force-dynamic";

/** POST /api/reader/signout: ends the reader's session (the cookie is cleared). */
export async function POST(request: Request) {
  if (!sameOrigin(request.headers)) return json({ ok: false, error: "This request did not come from the site." }, 403);
  return json({ ok: true }, 200, { "Set-Cookie": clearedCookie(secureRequest(request)) });
}