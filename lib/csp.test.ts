import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import nextConfig, { securityHeaders } from "../next.config";
import { buildCsp, CSP_REPORT_PATH, cspHeaders, cspMode, supabaseHostOf, type CspOptions } from "./csp";
import { describeReport, pathOnly } from "./csp-report";

// SEC-05: the Content-Security-Policy. It must keep the homepage and article pages statically cached, so it has no nonce.

const OPTS: CspOptions = { supabaseHost: "abc.supabase.co", dev: false, turnstile: false };
const directives = (policy: string) => Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("cspMode (CSP_MODE)", () => {
  it("is report-only by default and for anything it does not know", () => {
    for (const v of [undefined, "", "report-only", "REPORT-ONLY", "enforced ", "off", "true", "1"]) expect(cspMode(v), String(v)).toBe("report-only");
  });

  it("is enforce for 'enforce', in any case", () => {
    for (const v of ["enforce", "Enforce", " ENFORCE "]) expect(cspMode(v)).toBe("enforce");
  });
});

describe("supabaseHostOf", () => {
  it("is the hostname of the project URL, or null", () => {
    expect(supabaseHostOf("https://abc.supabase.co")).toBe("abc.supabase.co");
    expect(supabaseHostOf("https://abc.supabase.co/rest/v1")).toBe("abc.supabase.co");
    expect(supabaseHostOf("not a url")).toBeNull();
    expect(supabaseHostOf(undefined)).toBeNull();
  });
});

describe("buildCsp", () => {
  const d = directives(buildCsp(OPTS));

  it("has the strict directives the audit asked for", () => {
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    expect(d["font-src"]).toEqual(["'self'"]);
  });

  it("limits images to this site, data:, Unsplash and the Supabase host", () => {
    expect(d["img-src"]).toEqual(["'self'", "data:", "https://images.unsplash.com", "https://abc.supabase.co"]);
  });

  it("limits fetches to this site and the Supabase host", () => {
    expect(d["connect-src"]).toEqual(["'self'", "https://abc.supabase.co"]);
  });

  it("allows no script from any other host and no eval in production", () => {
    expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("uses no wildcard and no nonce, so the cached pages stay static", () => {
    const policy = buildCsp(OPTS);
    expect(policy).not.toMatch(/\*/);
    expect(policy).not.toMatch(/nonce-|strict-dynamic/);
  });

  it("allows 'unsafe-inline' only for scripts and styles, nowhere else", () => {
    const withInline = Object.entries(d).filter(([, v]) => v.includes("'unsafe-inline'")).map(([k]) => k);
    expect(withInline).toEqual(["script-src", "style-src"]);
  });

  it("reports violations to this site", () => {
    expect(d["report-uri"]).toEqual([CSP_REPORT_PATH]);
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });

  it("leaves the Supabase host out when it is not known", () => {
    const none = directives(buildCsp({ ...OPTS, supabaseHost: null }));
    expect(none["img-src"]).toEqual(["'self'", "data:", "https://images.unsplash.com"]);
    expect(none["connect-src"]).toEqual(["'self'"]);
  });

  it("development adds eval (React's debugging) and websockets (hot reload), nothing else changes", () => {
    const dev = directives(buildCsp({ ...OPTS, dev: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toEqual(expect.arrayContaining(["ws:", "wss:"]));
    expect(dev["img-src"]).toEqual(d["img-src"]);
  });

  it("Turnstile adds Cloudflare's host to scripts, frames and fetches, and only then", () => {
    const cf = directives(buildCsp({ ...OPTS, turnstile: true }));
    for (const dir of ["script-src", "connect-src", "frame-src"]) expect(cf[dir]).toContain("https://challenges.cloudflare.com");
    expect(cf["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
    for (const dir of ["script-src", "connect-src", "frame-src"]) expect(JSON.stringify(d[dir])).not.toContain("cloudflare");
  });
});

describe("cspHeaders", () => {
  it("report-only: the full policy only reports; the old frame-ancestors header is still enforced", () => {
    const h = cspHeaders("report-only", OPTS);
    expect(h.map((x) => x.key)).toEqual(["Content-Security-Policy", "Content-Security-Policy-Report-Only"]);
    expect(h[0].value).toBe("frame-ancestors 'none'");
    expect(h[1].value).toBe(buildCsp(OPTS));
  });

  it("enforce: the full policy is the enforced one and there is no report-only header", () => {
    const h = cspHeaders("enforce", OPTS);
    expect(h).toEqual([{ key: "Content-Security-Policy", value: buildCsp(OPTS) }]);
  });
});

describe("securityHeaders and the Next config", () => {
  const asMap = (headers: { key: string; value: string }[]) => Object.fromEntries(headers.map((h) => [h.key, h.value]));

  it("default to report-only: the full policy is a Report-Only header, nothing new is enforced", () => {
    const h = asMap(securityHeaders(true, { mode: "report-only", options: OPTS }));
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h["Content-Security-Policy-Report-Only"]).toContain("default-src 'self'");
  });

  it("enforce mode enforces the full policy", () => {
    const h = asMap(securityHeaders(true, { mode: "enforce", options: OPTS }));
    expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(h["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });

  it("keep the other headers in both modes", () => {
    for (const mode of ["report-only", "enforce"] as const) {
      const h = asMap(securityHeaders(true, { mode, options: OPTS }));
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["Strict-Transport-Security"]).toBeDefined();
    }
  });

  it("are on every path, with the report-only policy when CSP_MODE is not set", async () => {
    const rules = await nextConfig.headers!();
    const h = asMap(rules[0].headers);
    expect(rules[0].source).toBe("/:path*");
    expect(process.env.CSP_MODE).toBeUndefined();
    expect(h["Content-Security-Policy-Report-Only"]).toBeDefined();
  });
});

describe("the policy does not make pages dynamic", () => {
  it("nothing in the app or the proxy uses a nonce", () => {
    for (const file of ["proxy.ts", "app/layout.tsx", "app/page.tsx", "app/article/[slug]/page.tsx", "next.config.ts"]) {
      expect(read(file), file).not.toMatch(/x-nonce|nonce-\$\{|'nonce-/);
    }
  });

  it("the proxy still covers only /admin, so public pages are not run through it", () => {
    expect(read("proxy.ts")).toContain('matcher: ["/admin/:path*"]');
  });

  it("the homepage and the article page keep revalidate = 60", () => {
    expect(read("app/page.tsx")).toMatch(/export const revalidate = 60;/);
    expect(read("app/article/[slug]/page.tsx")).toMatch(/export const revalidate = 60;/);
  });

  it("the trade-off is written down in the policy's own file", () => {
    const text = read("lib/csp.ts");
    expect(text).toMatch(/THE TRADE-OFF/);
    expect(text).toMatch(/unsafe-inline/);
    expect(text).toMatch(/statically/i);
  });
});

describe("violation reports", () => {
  it("are read in the legacy format, with query strings dropped", () => {
    const line = describeReport({
      "csp-report": { "document-uri": "https://news.example.com/article/x?token=abc", "violated-directive": "img-src", "effective-directive": "img-src", "blocked-uri": "https://evil.example/pixel.png?id=7" },
    });
    expect(line).toBe("CSP violation: img-src blocked https://evil.example/pixel.png on /article/x");
    expect(line).not.toMatch(/token|id=7/);
  });

  it("are read in the Reporting API format", () => {
    expect(describeReport([{ type: "csp-violation", body: { documentURL: "https://news.example.com/", effectiveDirective: "script-src-elem", blockedURL: "inline" } }])).toBe(
      "CSP violation: script-src-elem blocked inline on /",
    );
  });

  it("say 'inline' when nothing was blocked by address, and ignore what is not a report", () => {
    expect(describeReport({ "csp-report": { "effective-directive": "style-src", "document-uri": "https://x.test/a" } })).toBe("CSP violation: style-src blocked inline on /a");
    for (const junk of [null, undefined, 5, "text", {}, [], { "csp-report": {} }, [{ body: 3 }]]) expect(describeReport(junk)).toBeNull();
  });

  it("keep every field short and on one line", () => {
    const line = describeReport({ "csp-report": { "effective-directive": "a\nb".repeat(300), "blocked-uri": "x".repeat(1000), "document-uri": `https://x.test/${"p".repeat(1000)}` } })!;
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(700);
    expect(pathOnly("https://x.test/a/b?c=d#e")).toBe("/a/b");
    expect(pathOnly(5)).toBe("");
  });
});

describe("POST /api/csp-report", () => {
  it("answers 204, logs one line, and refuses a huge body", async () => {
    const { POST } = await import("../app/api/csp-report/route");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = { "csp-report": { "effective-directive": "img-src", "blocked-uri": "https://evil.example/x", "document-uri": "https://news.example.com/" } };
    const ok = await POST(new Request("https://news.example.com/api/csp-report", { method: "POST", body: JSON.stringify(report), headers: { "content-type": "application/csp-report" } }));
    expect(ok.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const junk = await POST(new Request("https://news.example.com/api/csp-report", { method: "POST", body: "not json" }));
    expect(junk.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const big = await POST(new Request("https://news.example.com/api/csp-report", { method: "POST", body: "x", headers: { "content-length": "999999" } }));
    expect(big.status).toBe(413);
    warn.mockRestore();
  });
});
