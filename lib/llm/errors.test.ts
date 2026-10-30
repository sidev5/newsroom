import { describe, expect, it } from "vitest";
import { describeProviderError, redactSecrets } from "./errors";

class FakeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

describe("describeProviderError", () => {
  it("reads Gemini's error body: HTTP status, status word and message", () => {
    const body = JSON.stringify({ error: { code: 504, message: "Deadline expired before operation could complete.", status: "DEADLINE_EXCEEDED" } });
    expect(describeProviderError(new FakeApiError(body, 504))).toBe("HTTP 504 DEADLINE_EXCEEDED: Deadline expired before operation could complete.");
  });

  it("reads Anthropic's '<status> {json}' message", () => {
    const err = new FakeApiError('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529);
    expect(describeProviderError(err)).toBe("HTTP 529 overloaded_error: Overloaded");
  });

  it("keeps a plain message, with the status when there is one", () => {
    expect(describeProviderError(new FakeApiError("quota", 429))).toBe("HTTP 429: quota");
    expect(describeProviderError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeProviderError(new Error("boom"))).toBe("boom");
    expect(describeProviderError("odd")).toBe("odd");
  });
});

describe("redactSecrets", () => {
  it("removes the configured keys and anything shaped like a key", () => {
    const configured = "my-configured-secret-key";
    const text = `failed for ${configured} at https://x.test/v1?key=abc123&alt=json, AIzaSyA1234567890abcdefghijklmnopqrstu, sk-ant-api03-abcdefghijkl, Authorization: Bearer abcdefghijklmnop==`;
    const out = redactSecrets(text, [configured, undefined, ""]);
    for (const secret of [configured, "abc123", "AIzaSyA1234567890", "sk-ant-api03", "abcdefghijklmnop"]) expect(out).not.toContain(secret);
    expect(out).toContain("key=[REDACTED]&alt=json");
    expect(out).toContain("Authorization: [REDACTED]");
  });

  it("leaves ordinary text alone and ignores secrets too short to be keys", () => {
    expect(redactSecrets("HTTP 503 UNAVAILABLE: high demand", ["503"])).toBe("HTTP 503 UNAVAILABLE: high demand");
  });
});
