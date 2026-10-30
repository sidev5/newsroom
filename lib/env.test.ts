import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "./env";

const BASE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  CRON_SECRET: "test-secret-0123456789",
};

const KEYS = [...Object.keys(BASE), "ALLOWED_EMAIL_DOMAINS", "SUBMISSION_HASH_SALT"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, BASE);
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  delete process.env.SUBMISSION_HASH_SALT;
  resetEnvCache();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("ALLOWED_EMAIL_DOMAINS", () => {
  it("is an empty list when unset or empty: any email is accepted, flagged unverified", () => {
    expect(env().ALLOWED_EMAIL_DOMAINS).toEqual([]);
    process.env.ALLOWED_EMAIL_DOMAINS = "";
    resetEnvCache();
    expect(env().ALLOWED_EMAIL_DOMAINS).toEqual([]);
  });

  it("is a lower-cased, de-duplicated list of domains", () => {
    process.env.ALLOWED_EMAIL_DOMAINS = " AdorPower.com, @example.org ;adorpower.com";
    resetEnvCache();
    expect(env().ALLOWED_EMAIL_DOMAINS).toEqual(["adorpower.com", "example.org"]);
  });

  it("refuses a typo instead of silently becoming an empty list (which would let every email through)", () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "adorpower,com";
    resetEnvCache();
    expect(() => env()).toThrow(/ALLOWED_EMAIL_DOMAINS: not a domain: adorpower, com/);
  });
});

describe("SUBMISSION_HASH_SALT", () => {
  it("is optional, and must be long enough when set", () => {
    expect(env().SUBMISSION_HASH_SALT).toBeUndefined();
    process.env.SUBMISSION_HASH_SALT = "short";
    resetEnvCache();
    expect(() => env()).toThrow(/SUBMISSION_HASH_SALT/);
    process.env.SUBMISSION_HASH_SALT = "a-long-enough-secret-value";
    resetEnvCache();
    expect(env().SUBMISSION_HASH_SALT).toBe("a-long-enough-secret-value");
  });
});
