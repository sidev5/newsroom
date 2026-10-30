import { STORY_LIMITS } from "@/lib/config";
import { sameOrigin } from "@/lib/http/same-origin";
import { clientIp } from "@/lib/submissions/identity";
import { submissionDeps } from "@/lib/submissions/runtime";
import { GENERIC_ERROR } from "@/lib/submissions/service";
import { readStoryRequest } from "@/lib/stories/request";
import { IP_LIMIT_MESSAGE, ipAlreadyLimited, submitBlocksStory, type StoryResult } from "@/lib/stories/submit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: StoryResult | { ok: false; error: string }, status: number) => Response.json(body, { status, headers: NO_STORE });

const STATUS = { invalid: 422, limited: 429, captcha: 403, server: 500 } as const;

/**
 * POST /api/write/submit: a story from the Write page (multipart: the form fields, `blocks` as JSON, `image:<id>` files).
 * Public, no login, like the old /submit form: everything is validated here and the story is stored for review with the
 * service role only after that. A route handler rather than a server action so that up to eight images can travel in one
 * request without raising the body limit of every server action.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request.headers)) return json({ ok: false, error: "This request did not come from the Write page." }, 403);

  // Refuse an oversized request before reading any of it.
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return json({ ok: false, error: "The request has no size." }, 411);
  if (length > STORY_LIMITS.REQUEST_MAX_BYTES) return json({ ok: false, error: "The story and its images are too large (the limit is 41 MB in all)." }, 413);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ ok: false, error: "Unsupported request." }, 415);

  try {
    const deps = submissionDeps();
    const ip = clientIp(request.headers);
    // A connection that has already sent its daily limit does not get to upload another large request.
    if (await ipAlreadyLimited(deps, ip)) return json({ ok: false, kind: "limited", error: IP_LIMIT_MESSAGE }, 429);

    const form = await request.formData().catch(() => null);
    if (!form) return json({ ok: false, error: "The request could not be read." }, 400);
    const parsed = readStoryRequest(form, ip);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

    const result = await submitBlocksStory(deps, parsed.input);
    return json(result, result.ok ? 200 : STATUS[result.kind]);
  } catch (err) {
    console.error(`write: submission failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    return json({ ok: false, error: GENERIC_ERROR }, 500);
  }
}
