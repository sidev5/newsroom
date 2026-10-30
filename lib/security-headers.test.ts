import { describe, expect, it } from "vitest";
import nextConfig, { securityHeaders } from "../next.config";

const asMap = (headers: { key: string; value: string }[]) => Object.fromEntries(headers.map((h) => [h.key, h.value]));

describe("security headers (SEC-05, first part)", () => {
  it("are sent on every path, and X-Powered-By is off", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    expect(rules[0].headers.length).toBeGreaterThanOrEqual(5);
  });

  it("include nosniff, a strict referrer policy, frame denial and a Permissions-Policy", () => {
    const h = asMap(securityHeaders(true));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("send HSTS in production only", () => {
    expect(asMap(securityHeaders(true))["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(asMap(securityHeaders(false))["Strict-Transport-Security"]).toBeUndefined();
  });

  it("only report the full CSP by default: the enforced policy stays frame-ancestors (see lib/csp.test.ts)", () => {
    const h = asMap(securityHeaders(true, { mode: "report-only", options: { supabaseHost: null, dev: false, turnstile: false } }));
    expect(h["Content-Security-Policy"]).not.toMatch(/default-src|script-src|style-src|img-src/);
    expect(h["Content-Security-Policy-Report-Only"]).toMatch(/default-src 'self'/);
  });

  it("leave the image hosts alone: Unsplash, and the Supabase bucket only when the project URL is known", () => {
    const patterns = nextConfig.images!.remotePatterns!;
    expect(patterns[0]).toMatchObject({ hostname: "images.unsplash.com" });
    for (const p of patterns.slice(1)) expect(p).toMatchObject({ pathname: "/storage/v1/object/public/article-images/**" });
  });
});
