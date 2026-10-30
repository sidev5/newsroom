import { afterEach, describe, expect, it, vi } from "vitest";
import { bootCheck } from "./boot-check";
import { duplicateKeyWarnings, findDuplicateKeys, formatReport, QUOTING_RULE, validateEnv } from "./env-check";

const OK = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  CRON_SECRET: "a-long-test-secret-value-1234",
  ADMIN_EMAILS: "editor@example.com",
  ALLOWED_EMAIL_DOMAINS: "example.com",
  SITE_URL: "https://news.example.com",
  GEMINI_API_KEY: "g",
};

describe("validateEnv: required settings", () => {
  it("passes a complete environment with no warnings", () => {
    expect(validateEnv(OK)).toEqual({ errors: [], warnings: [] });
  });

  it("names every missing required variable", () => {
    const r = validateEnv({});
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "NEXT_PUBLIC_SUPABASE_URL is required but not set.",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY is required but not set.",
        "SUPABASE_SERVICE_ROLE_KEY is required but not set.",
        "CRON_SECRET is required but not set.",
      ]),
    );
  });

  it("treats an empty value as missing and a bad value as invalid", () => {
    expect(validateEnv({ ...OK, SUPABASE_SERVICE_ROLE_KEY: "" }).errors).toContain("SUPABASE_SERVICE_ROLE_KEY is required but not set.");
    expect(validateEnv({ ...OK, CRON_SECRET: "short" }).errors[0]).toMatch(/^CRON_SECRET: CRON_SECRET must be at least 16 characters/);
    expect(validateEnv({ ...OK, ALLOWED_EMAIL_DOMAINS: "adorpower,com" }).errors[0]).toMatch(/ALLOWED_EMAIL_DOMAINS: not a domain/);
    expect(validateEnv({ ...OK, ADMIN_IDLE_MINUTES: "abc" }).errors[0]).toMatch(/^ADMIN_IDLE_MINUTES:/);
    expect(validateEnv({ ...OK, ADMIN_SESSION_HOURS: "0" }).errors[0]).toMatch(/^ADMIN_SESSION_HOURS:/);
  });

  it("accepts the admin session settings and lets empty values fall back to the defaults", () => {
    expect(validateEnv({ ...OK, ADMIN_IDLE_MINUTES: "15", ADMIN_SESSION_HOURS: "4", ADMIN_SESSION_SECRET: "x".repeat(20) }).errors).toEqual([]);
    expect(validateEnv({ ...OK, ADMIN_IDLE_MINUTES: "", ADMIN_SESSION_HOURS: "" }).errors).toEqual([]);
    expect(validateEnv({ ...OK, ADMIN_SESSION_SECRET: "short" }).errors[0]).toMatch(/ADMIN_SESSION_SECRET/);
  });
});

describe("validateEnv: mail", () => {
  const smtp = { ...OK, EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.office365.com", SMTP_USER: "news@example.com", SMTP_PASS: "pw", MAIL_FROM: "news@example.com" };

  it("needs nothing for provider none or unset", () => {
    expect(validateEnv({ ...OK, EMAIL_PROVIDER: "none" }).errors).toEqual([]);
    expect(validateEnv({ ...OK, EMAIL_PROVIDER: "" }).errors).toEqual([]);
  });

  it("accepts a complete SMTP configuration", () => {
    expect(validateEnv(smtp).errors).toEqual([]);
  });

  it("refuses an empty SMTP_PASS with the quoting rule (DEP-02)", () => {
    for (const SMTP_PASS of ["", "   ", undefined]) {
      const r = validateEnv({ ...smtp, SMTP_PASS });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain("SMTP_PASS is empty while EMAIL_PROVIDER=smtp.");
      expect(r.errors[0]).toContain(QUOTING_RULE);
      expect(r.errors[0]).toContain("single quotes");
    }
  });

  it("names every missing SMTP setting", () => {
    const r = validateEnv({ ...OK, EMAIL_PROVIDER: "smtp" });
    expect(r.errors).toEqual(
      expect.arrayContaining(["SMTP_HOST is required when EMAIL_PROVIDER=smtp.", "SMTP_USER is required when EMAIL_PROVIDER=smtp.", "MAIL_FROM is required when EMAIL_PROVIDER=smtp."]),
    );
    expect(r.errors.join(" ")).toContain("SMTP_PASS is empty");
  });

  it("rejects an unknown provider and a bad sender or port", () => {
    expect(validateEnv({ ...OK, EMAIL_PROVIDER: "carrier-pigeon" }).errors[0]).toMatch(/EMAIL_PROVIDER must be one of/);
    expect(validateEnv({ ...smtp, MAIL_FROM: "not an address" }).errors[0]).toMatch(/Invalid SMTP settings/);
    expect(validateEnv({ ...smtp, SMTP_PORT: "99999" }).errors[0]).toMatch(/SMTP_PORT/);
  });

  it("checks the Graph settings when that provider is chosen", () => {
    const graph = { ...OK, EMAIL_PROVIDER: "graph", MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s", MAIL_FROM: "news@example.com" };
    expect(validateEnv(graph).errors).toEqual([]);
    expect(validateEnv({ ...graph, MS_CLIENT_SECRET: "" }).errors).toEqual(["MS_CLIENT_SECRET is required when EMAIL_PROVIDER=graph."]);
  });

  it("never puts a secret value in a message", () => {
    const text = JSON.stringify(validateEnv({ ...smtp, SMTP_PASS: "", CRON_SECRET: "short-secret", SMTP_USER: "user-name-value" }));
    expect(text).not.toContain("short-secret");
    expect(text).not.toContain("user-name-value");
  });
});

describe("validateEnv: warnings", () => {
  it("warns about settings that work but are probably unintended", () => {
    const r = validateEnv({ ...OK, ADMIN_EMAILS: "", ALLOWED_EMAIL_DOMAINS: "", SITE_URL: "", GEMINI_API_KEY: "" });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      "ADMIN_EMAILS is empty: nobody can sign in to /admin.",
      "ALLOWED_EMAIL_DOMAINS is empty: /submit accepts any email address (stories are flagged unverified).",
      "SITE_URL is not set: links in the weekly digest use a placeholder address.",
      "GEMINI_API_KEY is not set but LLM_PROVIDER=gemini: classify, write and fact-check will fail.",
    ]);
  });

  it("warns when production still points at localhost", () => {
    const r = validateEnv({ ...OK, NODE_ENV: "production", SITE_URL: "http://localhost:3000" });
    expect(r.warnings).toEqual(["SITE_URL points at localhost:3000 in production: digest links would not work for readers."]);
    expect(validateEnv({ ...OK, SITE_URL: "http://localhost:3000" }).warnings).toEqual([]); // fine while developing
  });
});

describe("duplicate keys in a .env file (DEP-03)", () => {
  const file = ["A=1", "# ADMIN_EMAILS=commented@out", "ADMIN_EMAILS=a@x.com", "", "export B=2", "ADMIN_EMAILS=b@x.com", "  B = 3", "C='x=y'"].join("\n");

  it("lists each key defined more than once, with line numbers, ignoring comments", () => {
    expect(findDuplicateKeys(file)).toEqual([
      { key: "ADMIN_EMAILS", lines: [3, 6] },
      { key: "B", lines: [5, 7] },
    ]);
    expect(findDuplicateKeys("A=1\nB=2\n")).toEqual([]);
    expect(findDuplicateKeys("A=1\r\nA=2\r\n")).toEqual([{ key: "A", lines: [1, 2] }]);
  });

  it("explains that only the last one is used", () => {
    expect(duplicateKeyWarnings(".env.local", file)[0]).toBe("ADMIN_EMAILS is defined 2 times in .env.local (lines 3, 6). Only the last one is used; delete the others.");
  });
});

describe("formatReport", () => {
  it("prints errors and warnings in two blocks", () => {
    expect(formatReport({ errors: ["E1"], warnings: ["W1"] })).toBe("Environment problems (fix these, then restart):\n  - E1\n\nWarnings:\n  - W1");
    expect(formatReport({ errors: [], warnings: [] })).toBe("");
  });
});

describe("bootCheck (instrumentation.ts)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws with every problem named when the environment is broken", () => {
    expect(() => bootCheck({ ...OK, CRON_SECRET: "" })).toThrow(/The newsroom cannot start\.[\s\S]*CRON_SECRET is required but not set\./);
    expect(() => bootCheck({ ...OK, EMAIL_PROVIDER: "smtp", SMTP_HOST: "h", SMTP_USER: "u", MAIL_FROM: "a@b.co" })).toThrow(/SMTP_PASS is empty/);
  });

  it("starts when only warnings exist, and prints them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => bootCheck({ ...OK, ADMIN_EMAILS: "" })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("ADMIN_EMAILS is empty");
  });

  it("does not read the disk (it runs inside the server bundle)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("./boot-check.ts", import.meta.url), "utf8")).not.toMatch(/node:fs|readFileSync|existsSync/);
  });

  it("is silent when everything is fine", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bootCheck(OK);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("instrumentation.register", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
    vi.doUnmock("./boot-check");
  });

  async function run(env: Record<string, string>) {
    const check = vi.fn();
    vi.resetModules();
    vi.doMock("./boot-check", () => ({ bootCheck: check }));
    Object.assign(process.env, env);
    const { register } = await import("../instrumentation");
    await register();
    return check;
  }

  it("checks the environment when a Node server starts", async () => {
    expect(await run({ NEXT_RUNTIME: "nodejs", NODE_ENV: "production", NEXT_PHASE: "phase-production-server" })).toHaveBeenCalledTimes(1);
  });

  it("does not run during next build, in tests, or in the edge runtime", async () => {
    expect(await run({ NEXT_RUNTIME: "nodejs", NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).not.toHaveBeenCalled();
    expect(await run({ NEXT_RUNTIME: "nodejs", NODE_ENV: "test", NEXT_PHASE: "" })).not.toHaveBeenCalled();
    expect(await run({ NEXT_RUNTIME: "edge", NODE_ENV: "production", NEXT_PHASE: "" })).not.toHaveBeenCalled();
  });
});
