// Reading a Content-Security-Policy violation report (see app/api/csp-report/route.ts). Plain module, so it can be tested.

export const CSP_REPORT_MAX_BYTES = 8 * 1024;
const FIELD = 200;

/** The page URL without its query string or fragment, shortened. */
export function pathOnly(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    return new URL(url).pathname.slice(0, FIELD);
  } catch {
    return url.split(/[?#]/)[0].slice(0, FIELD);
  }
}

const short = (v: unknown) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, FIELD) : "");

/**
 * One log line for a report, in either format: the legacy `csp-report` object and the Reporting API's list of
 * csp-violation entries. Null when it does not look like a report. Query strings are dropped from every address: they can carry tokens.
 */
export function describeReport(body: unknown): string | null {
  const inner = Array.isArray(body) ? (body[0] as { body?: unknown } | undefined)?.body : (body as { "csp-report"?: unknown } | null)?.["csp-report"];
  const r = inner as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return null;
  const directive = short(r["effective-directive"] ?? r["violated-directive"] ?? r.effectiveDirective);
  const blocked = short(r["blocked-uri"] ?? r.blockedURL ?? r.blockedUri);
  if (!directive && !blocked) return null;
  const target = blocked ? blocked.split(/[?#]/)[0] : "inline";
  const page = pathOnly(r["document-uri"] ?? r.documentURL ?? r.documentUri);
  return `CSP violation: ${directive || "?"} blocked ${target} on ${page || "?"}`;
}