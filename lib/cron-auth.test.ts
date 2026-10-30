import { describe, expect, it } from "vitest";
import { isAuthorizedCron, rejectUnlessCron } from "./cron-auth";

const SECRET = "test-secret-0123456789abcdef";

function req(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("http://localhost/api/cron/ingest", { headers });
}

describe("isAuthorizedCron", () => {
  it("accepts the exact bearer token", () => {
    expect(isAuthorizedCron(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isAuthorizedCron(req(), SECRET)).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorizedCron(req("Bearer wrong-secret-0123456789"), SECRET)).toBe(false);
  });

  it("rejects the token without the Bearer scheme", () => {
    expect(isAuthorizedCron(req(SECRET), SECRET)).toBe(false);
  });

  it("rejects a token that only shares a prefix", () => {
    expect(isAuthorizedCron(req(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    expect(isAuthorizedCron(req(`Bearer ${SECRET.slice(0, -1)}`), SECRET)).toBe(false);
  });

  it("rejects everything when the secret is unset", () => {
    expect(isAuthorizedCron(req("Bearer undefined"), undefined)).toBe(false);
    expect(isAuthorizedCron(req("Bearer "), "")).toBe(false);
  });

  it("rejects everything when the secret is too short", () => {
    expect(isAuthorizedCron(req("Bearer short"), "short")).toBe(false);
  });
});

describe("rejectUnlessCron", () => {
  it("returns a 401 response when unauthorized", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = rejectUnlessCron(req("Bearer nope"));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns null when authorized", () => {
    process.env.CRON_SECRET = SECRET;
    expect(rejectUnlessCron(req(`Bearer ${SECRET}`))).toBeNull();
  });
});
