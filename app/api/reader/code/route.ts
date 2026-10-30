import { clientIp } from "@/lib/submissions/identity";
import { requestCode, SIGN_IN_UNAVAILABLE } from "@/lib/reader/auth";
import { json, readJson, refuseUnlessSameSiteJson, STATUS } from "@/lib/reader/http";
import { authDeps, readerSignInAvailable } from "@/lib/reader/runtime";

export const dynamic = "force-dynamic";

/** POST /api/reader/code {email}: sends a one-time sign-in code to a company address (limited per address and per connection). */
export async function POST(request: Request) {
  const refused = refuseUnlessSameSiteJson(request);
  if (refused) return refused;
  if (!readerSignInAvailable()) return json({ ok: false, error: SIGN_IN_UNAVAILABLE }, 404);
  const body = await readJson(request);
  if (typeof body?.email !== "string") return json({ ok: false, error: "Enter your company email address." }, 422);
  try {
    const result = await requestCode(authDeps(), { email: body.email, ip: clientIp(request.headers) });
    return result.ok ? json({ ok: true }) : json(result, STATUS[result.kind === "server" ? "server" : result.kind]);
  } catch (err) {
    // No address in the log: only what went wrong.
    console.error(`reader: sending a code failed: ${err instanceof Error ? err.message.replace(/[^\s<>"',;()]+@[^\s<>"',;()]+/g, "[address]") : "unknown"}`);
    return json({ ok: false, error: "The code could not be sent. Please try again in a few minutes." }, 500);
  }
}