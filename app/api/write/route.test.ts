import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORY_LIMITS } from "@/lib/config";

// POST /api/write/submit: the gate in front of the submission service (origin, size, type, connection limit). The service itself
// is tested in lib/stories/submit.test.ts.

const stub = vi.hoisted(() => ({ submit: vi.fn(), limited: vi.fn() }));
vi.mock("@/lib/submissions/runtime", () => ({ submissionDeps: () => ({}) }));
vi.mock("@/lib/stories/submit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/stories/submit")>()), submitBlocksStory: stub.submit, ipAlreadyLimited: stub.limited }));

import { POST } from "./submit/route";

const SITE = "https://news.example.com";
const blocks = JSON.stringify({ v: 1, blocks: [{ id: "p", type: "paragraph", text: "x" }] });

function request(over: { headers?: Record<string, string>; form?: FormData | null; length?: string } = {}) {
  const form = over.form === undefined ? new FormData() : over.form;
  if (form && !form.has("blocks")) form.set("blocks", blocks);
  const req = new Request(`${SITE}/api/write/submit`, { method: "POST", body: form ?? "x", headers: { origin: SITE, host: "news.example.com", "content-length": "1000", ...over.headers } });
  if (over.length !== undefined) Object.defineProperty(req.headers, "get", { value: (n: string) => (n.toLowerCase() === "content-length" ? over.length : Headers.prototype.get.call(req.headers, n)) });
  return req;
}

beforeEach(() => {
  stub.submit.mockReset().mockResolvedValue({ ok: true });
  stub.limited.mockReset().mockResolvedValue(false);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/write/submit", () => {
  it("stores a story from the site's own page and answers 200", async () => {
    const res = await POST(request({ headers: { "x-forwarded-for": "203.0.113.7" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stub.submit).toHaveBeenCalledTimes(1);
    expect(stub.submit.mock.calls[0][1]).toMatchObject({ ip: "203.0.113.7", blocks: { v: 1 } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses another site or a missing Origin before reading anything", async () => {
    expect((await POST(request({ headers: { origin: "https://evil.example" } }))).status).toBe(403);
    const none = new Request(`${SITE}/api/write/submit`, { method: "POST", body: new FormData(), headers: { host: "news.example.com" } });
    expect((await POST(none)).status).toBe(403);
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("refuses a request that is too large, or has no size, without reading its body", async () => {
    expect((await POST(request({ length: String(STORY_LIMITS.REQUEST_MAX_BYTES + 1) }))).status).toBe(413);
    expect((await POST(request({ length: "0" }))).status).toBe(411);
    expect((await POST(request({ length: "nope" }))).status).toBe(411);
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("refuses anything that is not multipart form data", async () => {
    const json = new Request(`${SITE}/api/write/submit`, { method: "POST", body: "{}", headers: { origin: SITE, host: "news.example.com", "content-length": "2", "content-type": "application/json" } });
    expect((await POST(json)).status).toBe(415);
  });

  it("stops a connection that already sent its daily limit before the body is read", async () => {
    stub.limited.mockResolvedValue(true);
    const res = await POST(request({ headers: { "x-forwarded-for": "203.0.113.7" } }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, kind: "limited" });
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("maps the service's refusals to 422 (fix something), 429, 403 (human check) and 500, with the field and block messages", async () => {
    for (const [kind, status] of [["invalid", 422], ["limited", 429], ["captcha", 403], ["server", 500]] as const) {
      stub.submit.mockResolvedValueOnce({ ok: false, kind, error: "message", fieldErrors: { title: "t" }, blockErrors: { p: "b" } });
      const res = await POST(request());
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ ok: false, error: "message", fieldErrors: { title: "t" }, blockErrors: { p: "b" } });
    }
  });

  it("a missing or broken blocks field is a 400, and an unexpected error is a plain 500 without its cause", async () => {
    const form = new FormData();
    form.set("blocks", "{broken");
    expect((await POST(request({ form }))).status).toBe(400);
    stub.submit.mockRejectedValueOnce(new Error("relation articles does not exist for ada@adorpower.com"));
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation|ada@/);
  });
});