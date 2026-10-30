import { describe, expect, it } from "vitest";
import { adminEmailProblem, envFileKeys, validateEnv } from "./env-check";

// `npm run check-env -- --production`: the launch checks from the audit's env checklist.

const GOOD: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  CRON_SECRET: "0123456789abcdef0123456789abcdef", // 32 characters
  ADMIN_EMAILS: "ada@adorpower.com, grace@adorpower.com",
  ALLOWED_EMAIL_DOMAINS: "adorpower.com",
  SITE_URL: "https://news.adorpower.com",
  PRIVACY_CONTACT: "privacy@adorpower.com",
  LLM_PROVIDER: "gemini",
  GEMINI_API_KEY: "gemini-key",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.office365.com",
  SMTP_PORT: "587",
  SMTP_USER: "newsroom@adorpower.com",
  SMTP_PASS: "a-real-password",
  MAIL_FROM: "Company Newsroom <newsroom@adorpower.com>",
  CSP_MODE: "enforce",
};

const prod = (over: Record<string, string | undefined> = {}, fileKeys: string[] = []) =>
  validateEnv({ ...GOOD, ...over } as Record<string, string | undefined>, { production: true, fileKeys });
const errorsOf = (over: Record<string, string | undefined> = {}, fileKeys: string[] = []) => prod(over, fileKeys).errors;

describe("check-env --production", () => {
  it("passes a complete production environment, with no errors and no warnings", () => {
    expect(prod()).toEqual({ errors: [], warnings: [] });
  });

  it("is stricter than the normal check: the same environment fails only with --production", () => {
    const weak = { ...GOOD, SITE_URL: "http://localhost:3000", ALLOWED_EMAIL_DOMAINS: "", PEXELS_API_KEY: "pk" };
    expect(validateEnv(weak).errors).toEqual([]);
    expect(validateEnv(weak, { production: true }).errors.length).toBeGreaterThanOrEqual(3);
  });

  describe("SITE_URL", () => {
    it("is required", () => {
      expect(errorsOf({ SITE_URL: undefined })).toEqual([expect.stringMatching(/SITE_URL is required in production/)]);
    });

    it("must be https", () => {
      expect(errorsOf({ SITE_URL: "http://news.adorpower.com" })).toEqual([expect.stringMatching(/SITE_URL must be an https address/)]);
    });

    it.each(["https://localhost:3000", "https://127.0.0.1", "https://0.0.0.0", "https://192.168.1.20", "https://10.0.0.4"])("must not be %s", (url) => {
      expect(errorsOf({ SITE_URL: url }).join("\n")).toMatch(/SITE_URL points at/);
    });

    it("accepts a public https address with a path", () => {
      expect(errorsOf({ SITE_URL: "https://adorpower.com/newsroom" })).toEqual([]);
    });
  });

  it("requires ALLOWED_EMAIL_DOMAINS", () => {
    expect(errorsOf({ ALLOWED_EMAIL_DOMAINS: "" })).toEqual([expect.stringMatching(/ALLOWED_EMAIL_DOMAINS is required in production/)]);
  });

  it("requires CRON_SECRET of at least 32 characters", () => {
    expect(errorsOf({ CRON_SECRET: "a".repeat(31) })).toEqual([expect.stringMatching(/CRON_SECRET has 31 characters; use at least 32/)]);
    expect(errorsOf({ CRON_SECRET: "a".repeat(32) })).toEqual([]);
    // the normal check still accepts 16
    expect(validateEnv({ ...GOOD, CRON_SECRET: "a".repeat(16) }).errors).toEqual([]);
  });

  it("requires SMTP_PASS (not empty) when EMAIL_PROVIDER=smtp, and explains the quoting trap", () => {
    for (const pass of ["", "   ", undefined]) {
      const errors = errorsOf({ SMTP_PASS: pass });
      expect(errors.join("\n"), String(pass)).toMatch(/SMTP_PASS is empty while EMAIL_PROVIDER=smtp/);
      expect(errors.join("\n")).toMatch(/single quotes/);
    }
  });

  it("requires PRIVACY_CONTACT, which /submit shows", () => {
    expect(errorsOf({ PRIVACY_CONTACT: undefined })).toEqual([expect.stringMatching(/PRIVACY_CONTACT is required in production/)]);
  });

  describe("ADMIN_EMAILS", () => {
    it("is required", () => {
      expect(errorsOf({ ADMIN_EMAILS: "" })).toEqual([expect.stringMatching(/ADMIN_EMAILS is required in production/)]);
    });

    it.each(["test@adorpower.com", "admin@example.com", "someone@test.com", "boss@localhost", "you@yourcompany.com", "demo@adorpower.com", "changeme@adorpower.com"])(
      "refuses the placeholder or test address %s",
      (email) => {
        expect(errorsOf({ ADMIN_EMAILS: `ada@adorpower.com, ${email}` }).join("\n")).toMatch(new RegExp(`ADMIN_EMAILS: ${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} looks like a placeholder`));
      },
    );

    it.each(["someone@gmail.com", "someone@Outlook.com", "x@yahoo.com", "x@icloud.com", "x@proton.me"])("refuses the personal mailbox %s", (email) => {
      expect(errorsOf({ ADMIN_EMAILS: `ada@adorpower.com, ${email.toLowerCase()}` }).join("\n")).toMatch(/is a personal mailbox/);
    });

    it("refuses an address outside the company domains when they are configured", () => {
      expect(errorsOf({ ADMIN_EMAILS: "ada@adorpower.com, bob@partner-firm.org" }).join("\n")).toMatch(/bob@partner-firm\.org is outside the company domains \(adorpower\.com\)/);
    });

    it("a role address such as admin@ or newsroom@ on the company domain is fine", () => {
      expect(errorsOf({ ADMIN_EMAILS: "admin@adorpower.com, newsroom@adorpower.com" })).toEqual([]);
    });

    it("accepts a subdomain of a company domain, and reports each problem address once", () => {
      expect(errorsOf({ ADMIN_EMAILS: "ada@eu.adorpower.com" })).toEqual([]);
      const e = errorsOf({ ADMIN_EMAILS: "a@gmail.com, b@gmail.com" });
      expect(e.filter((x) => /ADMIN_EMAILS/.test(x))).toHaveLength(2);
    });

    it("does not judge the list in a normal (non-production) check", () => {
      expect(validateEnv({ ...GOOD, ADMIN_EMAILS: "me@gmail.com" }).errors).toEqual([]);
    });

    it("adminEmailProblem says why, or nothing for a good address", () => {
      expect(adminEmailProblem("ada@adorpower.com", ["adorpower.com"])).toBeNull();
      expect(adminEmailProblem("ada@adorpower.com", [])).toBeNull();
      expect(adminEmailProblem("a@gmail.com", [])).toBe("is a personal mailbox");
      expect(adminEmailProblem("a@gmail.com", ["adorpower.com"])).toBe("is a personal mailbox");
    });
  });

  describe("unused keys", () => {
    it("refuses PEXELS_API_KEY, whether it is in the environment or only in a .env file", () => {
      expect(errorsOf({ PEXELS_API_KEY: "pk" })).toEqual([expect.stringMatching(/PEXELS_API_KEY is set but the app does not use it/)]);
      expect(errorsOf({}, ["PEXELS_API_KEY"])).toEqual([expect.stringMatching(/PEXELS_API_KEY is set but the app does not use it/)]);
    });

    it("refuses any other secret-looking name in a .env file that the app does not read", () => {
      const errors = errorsOf({}, ["OPENAI_API_KEY", "STRIPE_SECRET", "SLACK_TOKEN", "DB_PASSWORD"]);
      expect(errors).toHaveLength(4);
      expect(errors[0]).toMatch(/OPENAI_API_KEY is defined in a \.env file but the app does not read it/);
    });

    it("lets the names the app reads through, and names that do not look like secrets", () => {
      const known = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "UNSPLASH_ACCESS_KEY", "CRON_SECRET", "SMTP_PASS", "MS_CLIENT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "TURNSTILE_SECRET", "SUBMISSION_HASH_SALT", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SOME_FLAG", "DEBUG"];
      expect(errorsOf({}, known)).toEqual([]);
    });

    it("warns about the other provider's LLM key without failing", () => {
      const r = prod({ ANTHROPIC_API_KEY: "sk-ant" });
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([expect.stringMatching(/ANTHROPIC_API_KEY is set but LLM_PROVIDER=gemini/)]);
    });

    it("envFileKeys lists the names of a .env file and skips comments", () => {
      expect(envFileKeys("# comment\nA=1\nexport B=2\n  C = 3\n#D=4\n\nA=again")).toEqual(["A", "B", "C"]);
    });
  });

  it("refuses APP_URL (it is for local scripts)", () => {
    expect(errorsOf({ APP_URL: "http://localhost:3000" })).toEqual([expect.stringMatching(/APP_URL is only for running scripts against a local server/)]);
  });

  it("refuses a Supabase URL on this computer", () => {
    expect(errorsOf({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }).join("\n")).toMatch(/NEXT_PUBLIC_SUPABASE_URL points at this computer/);
  });

  it("warns, not fails, when email is off or the CSP only reports", () => {
    expect(prod({ EMAIL_PROVIDER: "none", SMTP_PASS: undefined }).warnings.join("\n")).toMatch(/EMAIL_PROVIDER is none/);
    const r = prod({ CSP_MODE: undefined });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/CSP_MODE is report-only/);
    expect(prod({ CSP_MODE: "report-only" }).warnings.join("\n")).toMatch(/CSP_MODE is report-only/);
  });

  it("refuses a CSP_MODE that is neither report-only nor enforce", () => {
    expect(errorsOf({ CSP_MODE: "block" }).join("\n")).toMatch(/CSP_MODE/);
  });
});

describe("checks that apply with or without --production", () => {
  it("Turnstile needs both keys or neither", () => {
    expect(validateEnv({ ...GOOD, TURNSTILE_SITE_KEY: "site" }).errors.join("\n")).toMatch(/TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET is not/);
    expect(validateEnv({ ...GOOD, TURNSTILE_SECRET: "secret" }).errors.join("\n")).toMatch(/TURNSTILE_SECRET is set but TURNSTILE_SITE_KEY is not/);
    expect(validateEnv({ ...GOOD, TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret" }).errors).toEqual([]);
    expect(validateEnv({ ...GOOD }).errors).toEqual([]);
  });

  it("a secret in a NEXT_PUBLIC_ variable is an error: it would be sent to every visitor", () => {
    expect(validateEnv({ ...GOOD, NEXT_PUBLIC_SERVICE_ROLE_KEY: "oops" }).errors.join("\n")).toMatch(/NEXT_PUBLIC_SERVICE_ROLE_KEY starts with NEXT_PUBLIC_/);
    expect(validateEnv({ ...GOOD, NEXT_PUBLIC_SMTP_PASS: "oops" }).errors.join("\n")).toMatch(/NEXT_PUBLIC_SMTP_PASS/);
    expect(validateEnv({ ...GOOD }).errors).toEqual([]); // the anon key is meant to be public
  });

  it("CSP_MODE accepts the two modes", () => {
    expect(validateEnv({ ...GOOD, CSP_MODE: "enforce" }).errors).toEqual([]);
    expect(validateEnv({ ...GOOD, CSP_MODE: "report-only" }).errors).toEqual([]);
    expect(validateEnv({ ...GOOD, CSP_MODE: "block" }).errors.join("\n")).toMatch(/CSP_MODE/);
  });
});
