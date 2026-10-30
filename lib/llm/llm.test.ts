import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mocked SDKs: same shapes the real SDKs expose (default export + error classes).
// ---------------------------------------------------------------------------
const sdk = vi.hoisted(() => ({ anthropicCreate: vi.fn(), geminiGenerate: vi.fn(), anthropicOptions: [] as unknown[] }));

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    constructor(
      public status: number | undefined,
      message: string,
      public headers?: Headers,
    ) {
      super(message);
    }
  }
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;
    beta = { messages: { create: sdk.anthropicCreate } };
    constructor(options: unknown) {
      sdk.anthropicOptions.push(options);
    }
  }
  return { default: Anthropic };
});

vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ type: "json_schema", schema: { type: "object" } }),
}));

vi.mock("@google/genai", () => {
  class ApiError extends Error {
    status: number;
    constructor(options: { message: string; status: number }) {
      super(options.message);
      this.status = options.status;
    }
  }
  class GoogleGenAI {
    models = { generateContent: sdk.geminiGenerate };
  }
  return { ApiError, GoogleGenAI };
});

import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";
import { resetEnvCache } from "@/lib/env";
import { callAgent, getProvider, itemAction, parseAgentOutput, resetProviderCache, type AgentRun } from "./index";

type MockAnthropicError = new (status: number | undefined, message: string, headers?: Headers) => Error;
const AnthropicErrors = Anthropic as unknown as {
  APIError: MockAnthropicError;
  RateLimitError: MockAnthropicError;
  APIConnectionError: MockAnthropicError;
};

// ---------------------------------------------------------------------------
// Per-provider fixtures. Both report 10 input / 5 output tokens so the
// assertions below are identical for each provider.
// ---------------------------------------------------------------------------
type Provider = "anthropic" | "gemini";

const fixtures = {
  anthropic: {
    mock: sdk.anthropicCreate,
    reply: (text: string) => ({
      content: [{ type: "text", text }],
      model: "claude-served-model",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    rateLimit: () => new AnthropicErrors.RateLimitError(429, "rate limited", new Headers({ "retry-after": "3" })),
    serverError: () => new AnthropicErrors.APIError(503, "overloaded"),
    authError: () => new AnthropicErrors.APIError(401, "invalid x-api-key"),
    promptOf: (call: unknown[]) => (call[0] as { messages: { content: string }[] }).messages[0].content,
  },
  gemini: {
    mock: sdk.geminiGenerate,
    reply: (text: string) => ({
      text,
      modelVersion: "gemini-served-model",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
    }),
    rateLimit: () =>
      new ApiError({ message: '{"error":{"code":429,"details":[{"retryDelay":"3s"}]}}', status: 429 }),
    serverError: () => new ApiError({ message: "overloaded", status: 503 }),
    authError: () => new ApiError({ message: "API key not valid", status: 400 }),
    promptOf: (call: unknown[]) => (call[0] as { contents: string }).contents,
  },
} as const;

const Schema = z.object({ department: z.string(), relevance: z.number().int().min(0).max(10) });
const VALID = JSON.stringify({ department: "EV", relevance: 8 });

let runs: AgentRun[];
let sleeps: number[];
const deps = () => ({
  logRun: async (run: AgentRun) => void runs.push(run),
  sleep: async (ms: number) => void sleeps.push(ms),
});

function useProvider(name: Provider) {
  process.env.LLM_PROVIDER = name;
  resetEnvCache();
  resetProviderCache();
}

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: "test-secret-0123456789",
    ANTHROPIC_API_KEY: "sk-ant-test",
    GEMINI_API_KEY: "gemini-test",
  });
  runs = [];
  sleeps = [];
  sdk.anthropicCreate.mockReset();
  sdk.geminiGenerate.mockReset();
});

afterEach(() => {
  delete process.env.LLM_PROVIDER;
  resetEnvCache();
  resetProviderCache();
});

const call = (agent: "classify" | "write" = "classify") =>
  callAgent({ agent, schema: Schema, system: "sys", prompt: "PROMPT", articleId: "art-1", rawItemId: "raw-1" }, deps());

// ---------------------------------------------------------------------------
// Behaviour that must be identical for both providers
// ---------------------------------------------------------------------------
describe.each(["anthropic", "gemini"] as const)("callAgent with %s", (name) => {
  const f = fixtures[name];
  beforeEach(() => useProvider(name));

  it("returns validated data and logs one run with tokens", async () => {
    f.mock.mockResolvedValueOnce(f.reply(VALID));
    const result = await call();
    expect(result).toEqual({ ok: true, data: { department: "EV", relevance: 8 }, attempts: 1 });
    expect(runs).toEqual([
      {
        agent: "classify",
        model: name === "anthropic" ? "claude-served-model" : "gemini-served-model",
        article_id: "art-1",
        raw_item_id: "raw-1",
        input_tokens: 10,
        output_tokens: 5,
      },
    ]);
  });

  it("retries once with the validation error, then succeeds", async () => {
    f.mock.mockResolvedValueOnce(f.reply(JSON.stringify({ department: "EV", relevance: 42 })));
    f.mock.mockResolvedValueOnce(f.reply(VALID));
    const result = await call();
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    const retryPrompt = f.promptOf(f.mock.mock.calls[1]);
    expect(retryPrompt).toContain("PROMPT");
    expect(retryPrompt).toContain("relevance");
    expect(retryPrompt).toMatch(/rejected/);
    expect(runs).toHaveLength(2);
  });

  it("gives invalid_output after two bad responses, logging both", async () => {
    f.mock.mockResolvedValueOnce(f.reply("not json"));
    f.mock.mockResolvedValueOnce(f.reply(JSON.stringify({ department: "EV" })));
    const result = await call();
    expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
    expect(f.mock).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(2);
    expect(itemAction(result)).toBe("fail");
  });

  it("backs off on 429 using the provider's retry delay, then succeeds", async () => {
    f.mock.mockRejectedValueOnce(f.rateLimit());
    f.mock.mockResolvedValueOnce(f.reply(VALID));
    const result = await call();
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(sleeps).toEqual([3000]);
    expect(runs).toHaveLength(1); // the 429 returned no usage, so nothing to log
  });

  it("returns rate_limited (item left unprocessed) when 429s persist", async () => {
    f.mock.mockRejectedValue(f.rateLimit());
    const result = await call();
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(f.mock).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(sleeps).toHaveLength(3);
    expect(runs).toHaveLength(0);
    expect(itemAction(result)).toBe("leave_and_stop");
  });

  it("retries transient 5xx errors with exponential backoff", async () => {
    f.mock.mockRejectedValueOnce(f.serverError());
    f.mock.mockRejectedValueOnce(f.serverError());
    f.mock.mockResolvedValueOnce(f.reply(VALID));
    const result = await call();
    expect(result).toMatchObject({ ok: true });
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(4000);
  });

  it("does not retry fatal errors such as a bad API key", async () => {
    f.mock.mockRejectedValue(f.authError());
    const result = await call();
    expect(result).toMatchObject({ ok: false, reason: "provider_error" });
    expect(f.mock).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
    expect(itemAction(result)).toBe("leave_and_stop");
  });
});

// ---------------------------------------------------------------------------
// Provider-specific request shape
// ---------------------------------------------------------------------------
describe("provider requests", () => {
  it("asks Gemini for JSON with a schema and uses the configured models", async () => {
    useProvider("gemini");
    sdk.geminiGenerate.mockResolvedValue(fixtures.gemini.reply(VALID));
    await call("classify");
    await call("write");
    const [classifyReq] = sdk.geminiGenerate.mock.calls[0];
    expect(classifyReq.model).toBe("gemini-3.5-flash-lite");
    expect(classifyReq.config.responseMimeType).toBe("application/json");
    expect(classifyReq.config.responseJsonSchema).toMatchObject({ type: "object", required: ["department", "relevance"] });
    expect(classifyReq.config.responseJsonSchema).not.toHaveProperty("$schema");
    expect(classifyReq.config.systemInstruction).toBe("sys");
    expect(sdk.geminiGenerate.mock.calls[1][0].model).toBe("gemini-3.6-flash");
  });

  it("sends Anthropic a JSON output format; refusal fallback and effort only on the strong tier", async () => {
    useProvider("anthropic");
    sdk.anthropicCreate.mockResolvedValue(fixtures.anthropic.reply(VALID));
    await call("classify");
    await call("write");
    const [classifyReq] = sdk.anthropicCreate.mock.calls[0];
    const [writeReq] = sdk.anthropicCreate.mock.calls[1];
    expect(classifyReq.model).toBe("claude-haiku-4-5-20251001");
    expect(classifyReq.output_config.format.type).toBe("json_schema");
    expect(classifyReq.output_config.effort).toBeUndefined();
    expect(classifyReq.fallbacks).toBeUndefined();
    expect(writeReq.model).toBe("claude-sonnet-5-5");
    expect(writeReq.output_config.effort).toBe("medium");
    expect(writeReq.fallbacks).toBe("default");
    expect(writeReq.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("turns off SDK retries so callAgent owns backoff", () => {
    useProvider("anthropic");
    getProvider();
    expect(sdk.anthropicOptions.at(-1)).toMatchObject({ maxRetries: 0 });
  });
});

describe("provider selection", () => {
  it("defaults to gemini", () => {
    resetEnvCache();
    resetProviderCache();
    expect(getProvider().name).toBe("gemini");
  });

  it("uses LLM_PROVIDER=anthropic", () => {
    useProvider("anthropic");
    expect(getProvider().name).toBe("anthropic");
  });

  it("fails clearly when the selected provider's key is missing", () => {
    useProvider("gemini");
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
    expect(() => getProvider()).toThrow(/GEMINI_API_KEY is not set/);
  });
});

describe("parseAgentOutput", () => {
  it("accepts JSON wrapped in a ```json fence", () => {
    expect(parseAgentOutput("```json\n" + VALID + "\n```", Schema)).toEqual({
      ok: true,
      data: { department: "EV", relevance: 8 },
    });
  });

  it("reports empty output", () => {
    expect(parseAgentOutput("  ", Schema)).toEqual({ ok: false, error: "Empty response." });
  });
});
