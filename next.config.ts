import bundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";
import { cspHeaders, cspMode, type CspMode, type CspOptions } from "./lib/csp";

/** Hostname of the Supabase project, for the public photos of employee stories. */
function supabaseHost(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return null;
  }
}

const supabase = supabaseHost();

/**
 * Security headers on every response (SEC-05).
 *
 * The Content-Security-Policy is built in lib/csp.ts; read its header comment for the trade-off (inline scripts are
 * allowed, so the homepage and article pages can stay statically cached; everything else is closed). CSP_MODE picks
 * "report-only" (the default: violations are reported to /api/csp-report, nothing is blocked) or "enforce". Next
 * writes these headers into the build, so CSP_MODE is read when the app is built: change it, then deploy again.
 * The email preview in /admin/digest is an iframe with srcdoc and sandbox="", which the policy does not affect.
 */
export function securityHeaders(
  production: boolean = process.env.NODE_ENV === "production",
  csp: { mode: CspMode; options: CspOptions } = {
    mode: cspMode(process.env.CSP_MODE),
    options: { supabaseHost: supabase, dev: process.env.NODE_ENV === "development", turnstile: Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET) },
  },
) {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    ...cspHeaders(csp.mode, csp.options),
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
  // HSTS makes browsers refuse plain http for the host, so it is never sent by the dev server.
  if (production) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  return headers;
}
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      // Only the public article-images bucket, never the private submission-images one.
      ...(supabase ? [{ protocol: "https" as const, hostname: supabase, pathname: "/storage/v1/object/public/article-images/**" }] : []),
    ],
  },
  experimental: {
    // /submit posts a photo of up to 5 MB inside the form (plus a little for the other fields).
    serverActions: { bodySizeLimit: "6mb" },
  },
};

// `ANALYZE=true next build --webpack` writes the report to .next/analyze (add ANALYZE_MODE=json for a JSON file). It is a
// Webpack plugin: a plain `next build` uses Turbopack and ignores it. Turbopack has its own: `next experimental-analyze`.
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
  openAnalyzer: false,
  analyzerMode: process.env.ANALYZE_MODE === "json" ? "json" : "static",
});

export default withBundleAnalyzer(nextConfig);
