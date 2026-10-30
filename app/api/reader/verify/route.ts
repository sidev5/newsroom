import { SIGN_IN_UNAVAILABLE, verifyCode } from "@/lib/reader/auth";
import { json, readJson, refuseUnlessSameSiteJson, secureRequest, STATUS } from "@/lib/reader/http";
import { signSession, sessionCookie } from "@/lib/reader/identity";
import { authDeps, readerSecret, readerSignInAvailable } from "@/lib/reader/runtime";

export const dynamic = "force-dynamic";

/** POST /api/reader/verify {email, code}: checks the code and starts the session (a signed HttpOnly cookie). */
export async function POST(request: Request) {
  const refused = refuseUnlessSameSiteJson(request);
  if (refused) return refused;
  if (!readerSignInAvailable()) return json({ ok: false, error: SIGN_IN_UNAVAILABLE }, 404);
  const body = await readJson(request);
  if (typeof body?.email !== "string" || typeof body.code !== "string") return json({ ok: false, error: "Enter your email address and the code." }, 422);
  try {
    const result = await verifyCode(authDeps(), { email: body.email, code: body.code });
    if (!result.ok) return json(result, STATUS[result.kind]);
    return json({ ok: true, name: result.session.n }, 200, { "Set-Cookie": sessionCookie(signSession(result.session, readerSecret()), secureRequest(request)) });
  } catch (err) {
    console.error(`reader: checking a code failed: ${err instanceof Error ? err.message : "unknown"}`);
    return json({ ok: false, error: "The code could not be checked. Please try again." }, 500);
  }
}