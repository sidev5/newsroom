// The Content-Security-Policy (SEC-05). Plain module with no imports: next.config.ts loads it at build time.
//
// THE TRADE-OFF, in short. A nonce-based policy ('nonce-...' with 'strict-dynamic') makes every page render on each request,
// because the nonce has to be different every time and is put into the HTML while it is rendered. That would turn the cached
// homepage and article pages (revalidate = 60) into pages built per visitor. Next's other option, hashes through
// Subresource Integrity (experimental.sri), covers the script FILES, but a statically rendered Next page also contains small inline
// scripts (self.__next_f.push(...)) that carry the page's data; their text changes with every revalidation, so no hash can be
// written in advance. So this policy allows inline scripts ('unsafe-inline' in script-src) and is strict about everything else:
//   - no other script source than this site (nothing from any other host, no eval in production);
//   - objects, <base>, form targets and framing are closed; images and fetches are limited to this site, Unsplash and the
//     Supabase project, so an injected script could not load a remote script, send data to an arbitrary host, or embed
//     content from one. Inline scripts remain the weak spot: that is exactly what the 'unsafe-inline' costs, and why it is
//     written down here and in the README rather than hidden. style-src also allows 'unsafe-inline' because React components
//     set style="" attributes (the globe, the card colours) and those cannot be allow-listed one by one.
// If the pages ever have to be dynamic anyway, switch to the nonce policy from the Next.js CSP guide and drop 'unsafe-inline'.

export type CspMode = "report-only" | "enforce";

/** CSP_MODE: "enforce" or "report-only". Anything else, or nothing, is report-only (the safe default for a new policy). */
export function cspMode(value: string | undefined): CspMode {
  return value?.trim().toLowerCase() === "enforce" ? "enforce" : "report-only";
}

/** Hostname of the Supabase project from NEXT_PUBLIC_SUPABASE_URL, or null. */
export function supabaseHostOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? "").hostname || null;
  } catch {
    return null;
  }
}

/** Where browsers send violation reports (app/api/csp-report/route.ts logs them). */
export const CSP_REPORT_PATH = "/api/csp-report";

const TURNSTILE = "https://challenges.cloudflare.com";

export type CspOptions = {
  /** The Supabase project's hostname: its storage serves the photos of employee stories, and the admin login talks to it. */
  supabaseHost: string | null;
  /** next dev: React needs eval for its debugging, and hot reload uses a websocket. */
  dev: boolean;
  /** Cloudflare Turnstile is on for /submit: its script, frame and check request need their host. */
  turnstile: boolean;
};

export function buildCsp({ supabaseHost, dev, turnstile }: CspOptions): string {
  const supabase = supabaseHost ? [`https://${supabaseHost}`] : [];
  const cf = turnstile ? [TURNSTILE] : [];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // Inline scripts: see the trade-off above.
    ["script-src", ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...cf]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "https://images.unsplash.com", ...supabase]],
    ["font-src", ["'self'"]], // next/font serves the Google fonts from this site
    ["connect-src", ["'self'", ...supabase, ...cf, ...(dev ? ["ws:", "wss:"] : [])]],
    ["frame-src", turnstile ? [TURNSTILE] : ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["report-uri", [CSP_REPORT_PATH]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/**
 * The header(s) to send. report-only: the full policy as Content-Security-Policy-Report-Only (violations are reported, nothing
 * is blocked) next to the old enforced `frame-ancestors 'none'`. enforce: the full policy as Content-Security-Policy.
 */
export function cspHeaders(mode: CspMode, options: CspOptions): { key: string; value: string }[] {
  const policy = buildCsp(options);
  return mode === "enforce"
    ? [{ key: "Content-Security-Policy", value: policy }]
    : [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Content-Security-Policy-Report-Only", value: policy },
      ];
}
