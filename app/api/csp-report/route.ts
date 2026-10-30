import { CSP_REPORT_MAX_BYTES, describeReport } from "@/lib/csp-report";

export const dynamic = "force-dynamic";

/**
 * Receives Content-Security-Policy violation reports (the policy's report-uri). Public, so it stays small: the body is
 * capped, one short line is logged, and nothing is stored.
 */
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > CSP_REPORT_MAX_BYTES) return new Response(null, { status: 413 });
  try {
    const line = describeReport(JSON.parse((await request.text()).slice(0, CSP_REPORT_MAX_BYTES)));
    if (line) console.warn(line);
  } catch {
    // not JSON: nothing to log
  }
  return new Response(null, { status: 204 });
}