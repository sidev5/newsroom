import { timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 16;

/** True only if the request carries `Authorization: Bearer <secret>` exactly. */
export function isAuthorizedCron(
  request: Request,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  // A missing or weak secret must never authorize anything (e.g. "Bearer undefined").
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Use at the top of every cron route: `const denied = rejectUnlessCron(req); if (denied) return denied;` */
export function rejectUnlessCron(request: Request): Response | null {
  if (isAuthorizedCron(request)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
