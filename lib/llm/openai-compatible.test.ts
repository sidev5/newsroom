import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// No network and no database: every HTTP call goes to a fake fetch, and Supabase is never reached.
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => { throw new Error("no database in this test"); } }));

import { OPENAI_COMPATIBLE_PROVIDERS, type OpenAICompatibleConfig } from "@/lib/config";
import { budgetCost } from "@/lib/llm/budget";
import { resetEnvCache } from "@/lib/env";
import { validateEnv } from "@/lib/env-check";
import { runWrite, type WriteItem } from "@/lib/pipeline/write";
import { callAgent, getProvider, providerNameFor, resetProviderCache, type AgentRun } from "./index";
import { createOpenAICompatibleProvider, createRequestSpacer, openAIJsonSchema } from "./providers/openai-compatible";

const KEY = "gsk_test_key_0123456789abcdefghij";
const MODEL = "openai/gpt-oss-120b";
const groq: OpenAICompatibleConfig = OPENAI_COMPATIBLE_PROVIDERS.groq;

const Schema = z.object({ department: z.string(), relevance: z.number().int().min(0).max(10) });
const VALID = JSON.stringify({ department: "EV", relevance: 8 });

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fetch that answers from a script, one response per call, and records what it was sent. */
function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const ok = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content } }], usage }), { status: 200, headers: { "content-type": "application/json" } });
const err = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

let runs: AgentRun[];
let sleeps: number[];
const sleep = async (ms: number) => void sleeps.push(ms);

function provider(f: typeof fetch, model = MODEL, now: () => number = () => 0) {
  return createOpenAICompatibleProvider("groq", groq, KEY, model, { fetch: f, now, sleep });
}
const agent = (p: ReturnType<typeof provider>, agentName: "classify" | "write" = "write") =>
  callAgent({ agent: agentName, schema: Schema, system: "sys", prompt: "PROMPT", rawItemId: "raw-1" }, { provider: p, logRun: async (r) => void runs.push(r), sleep, budget: null });

beforeEach(() => {
  runs = [];
  sleeps = [];
});

describe("OpenAI-compatible provider (Groq): the request", () => {
  it("posts to /chat/completions with the key, the model, both messages and a json_schema response format", async () => {
    const f = fakeFetch(ok(VALID));
    expect(await agent(provider(f.fn))).toMatchObject({ ok: true, data: { department: "EV", relevance: 8 } });
    const [c] = f.calls;
    expect(c.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(c.body).toMatchObject({
      model: MODEL,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "PROMPT" }],
      response_format: { type: "json_schema", json_schema: { name: "output", strict: false, schema: { type: "object", required: ["department", "relevance"] } } },
    });
    expect((c.body.response_format as { json_schema: { schema: object } }).json_schema.schema).not.toHaveProperty("$schema");
  });

  it("caps max_completion_tokens at the provider's limit (write asks for 16000)", async () => {
    const f = fakeFetch(ok(VALID));
    await agent(provider(f.fn));
    expect(f.calls[0].body.max_completion_tokens).toBe(groq.maxOutputTokens);
  });

  it("uses json_object, with the schema in the system message, for a model without structured outputs", async () => {
    const f = fakeFetch(ok(VALID));
    await agent(provider(f.fn, "llama-3.3-70b-versatile"));
    const body = f.calls[0].body as { response_format: unknown; messages: { content: string }[] };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toMatch(/^sys\n\nThe JSON object must match this JSON Schema:\n\{[\s\S]*"department"/);
  });

  it("sends unions as anyOf, the keyword Groq documents", () => {
    const union = z.object({ blocks: z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("a") }), z.object({ type: z.literal("b") })])) });
    const json = JSON.stringify(openAIJsonSchema(union));
    expect(json).toContain('"anyOf"');
    expect(json).not.toContain('"oneOf"');
  });

  it("logs the run as groq/<model> with its tokens, which the price table counts as free", async () => {
    const f = fakeFetch(ok(VALID, { prompt_tokens: 3000, completion_tokens: 900 }));
    await agent(provider(f.fn));
    expect(runs).toEqual([{ agent: "write", model: `groq/${MODEL}`, article_id: null, raw_item_id: "raw-1", input_tokens: 3000, output_tokens: 900 }]);
    expect(budgetCost(runs[0])).toBe(0);
    expect(budgetCost({ model: "gemini-3.5-flash-lite", input_tokens: 1_000_000, output_tokens: 0 })).toBeGreaterThan(0);
  });
});

describe("OpenAI-compatible provider (Groq): validation, errors and backoff through callAgent", () => {
  it("retries once with the validation error, then succeeds", async () => {
    const f = fakeFetch(ok(JSON.stringify({ department: "EV", relevance: 42 })), ok(VALID));
    expect(await agent(provider(f.fn))).toMatchObject({ ok: true, attempts: 2 });
    const retry = (f.calls[1].body.messages as { content: string }[])[1].content;
    expect(retry).toContain("PROMPT");
    expect(retry).toMatch(/rejected/);
  });

  it("treats Groq's 400 json_validate_failed as invalid output: one retry, then invalid_output (the item is marked failed)", async () => {
    const bad = { error: { message: "Failed to generate JSON. Please adjust your prompt.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: '{"department": "EV"' } };
    const f = fakeFetch(err(400, bad), err(400, bad));
    const r = await agent(provider(f.fn));
    expect(r).toMatchObject({ ok: false, reason: "invalid_output" });
    expect(r.ok ? "" : r.error).toMatch(/not valid JSON/);
    expect(f.calls).toHaveLength(2);
    expect(sleeps.filter((ms) => ms !== 2000)).toEqual([]); // no backoff: only the 30/min spacing
  });

  it("backs off on 429 using retry-after, then succeeds", async () => {
    const f = fakeFetch(err(429, { error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "3" }), ok(VALID));
    expect(await agent(provider(f.fn))).toMatchObject({ ok: true });
    expect(sleeps).toContain(3000);
  });

  it("leaves the item queued on persistent 429s, reporting status and message with the key removed", async () => {
    const body = { error: { message: `Rate limit reached for model ${MODEL} (key ${KEY})`, type: "tokens", code: "rate_limit_exceeded" } };
    const f = fakeFetch(...Array.from({ length: 4 }, () => err(429, body, { "retry-after": "1" })));
    process.env.GROQ_API_KEY = KEY;
    try {
      const r = await agent(provider(f.fn));
      expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
      const message = r.ok ? "" : r.error;
      expect(message).toBe(`groq ${MODEL}, attempt 4 of 4: HTTP 429 tokens: Rate limit reached for model ${MODEL} (key [REDACTED])`);
      expect(message).not.toContain(KEY);
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it("retries 5xx with backoff, then gives provider_error (the item stays queued)", async () => {
    const f = fakeFetch(...Array.from({ length: 4 }, () => err(503, { error: { message: "Service Unavailable", type: "internal_server_error" } })));
    const r = await agent(provider(f.fn));
    expect(r).toMatchObject({ ok: false, reason: "provider_error", error: expect.stringMatching(/HTTP 503 internal_server_error: Service Unavailable$/) });
    expect(f.calls).toHaveLength(4);
  });

  it("does not retry a bad key (401)", async () => {
    const f = fakeFetch(err(401, { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }));
    expect(await agent(provider(f.fn))).toMatchObject({ ok: false, reason: "provider_error", error: expect.stringMatching(/HTTP 401 invalid_request_error: Invalid API Key/) });
    expect(f.calls).toHaveLength(1);
  });

  it("treats a network failure as transient", async () => {
    const f = { fn: vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch };
    expect(await agent(provider(f.fn))).toMatchObject({ ok: false, reason: "provider_error", error: expect.stringMatching(/attempt 4 of 4: TypeError: fetch failed/) });
  });
});

describe("30 requests per minute", () => {
  it("spaces calls 2 s apart, also when they are started together", async () => {
    let t = 0;
    const waits: number[] = [];
    const space = createRequestSpacer(Math.ceil(60_000 / groq.requestsPerMinute), () => t, async (ms) => void waits.push(ms));
    await Promise.all([space(), space(), space()]);
    expect(waits).toEqual([2000, 4000]);
    t = 10_000; // long after: no wait
    await space();
    expect(waits).toEqual([2000, 4000]);
  });

  it("the provider waits before its second request", async () => {
    const f = fakeFetch(ok(VALID), ok(VALID));
    const p = provider(f.fn);
    await agent(p);
    await agent(p);
    expect(sleeps).toEqual([2000]);
  });
});

describe("write stage on Groq", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const article = JSON.stringify({ headline: "Leipzig approves tram depot", body: words(180), image_query: "tram depot", image_alt: "A tram in a depot", country_code: "DE" });
  const item = (id: string): WriteItem => ({ id, url: `https://example.org/${id}`, title: "T", content: words(200), full_text: null, source_published_at: null, department_id: "d1", department_slug: "ev", place: null, lat: null, lon: null });

  function harness(n: number, f: typeof fetch) {
    const queue = Array.from({ length: n }, (_, i) => item(`i${i}`));
    const written: string[] = [];
    const p = provider(f);
    return {
      written,
      deps: {
        loadItems: async (limit: number) => queue.filter((q) => !written.includes(q.id)).slice(0, limit),
        insertArticle: async () => {},
        updateItem: async (id: string) => void written.push(id),
        agent: <T>(params: Parameters<typeof callAgent<T>>[0]) => callAgent(params, { provider: p, logRun: async () => {}, sleep, budget: null }),
      },
    };
  }

  beforeEach(() => {
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", CRON_SECRET: "test-secret-0123456789", MIN_SOURCE_WORDS: "120" });
    resetEnvCache();
  });

  it("writes no more items than the run's cap (BATCH_LIMIT unless the call passes a limit)", async () => {
    const f = fakeFetch(...Array.from({ length: 10 }, () => ok(article)));
    const h = harness(10, f.fn);
    const counts = await runWrite(h.deps, { limit: 3, chunkSize: 5, delayMs: 0, sleep });
    expect(counts).toMatchObject({ written: 3, stopped: null, stoppedError: null });
    expect(f.calls).toHaveLength(3);
  });

  it("stops on persistent 429s with every item still queued and the reason in stoppedError", async () => {
    const f = fakeFetch(...Array.from({ length: 4 }, () => err(429, { error: { message: "Rate limit reached", type: "requests" } })));
    const h = harness(3, f.fn);
    const counts = await runWrite(h.deps, { delayMs: 0, sleep });
    expect(counts).toMatchObject({ processed: 0, written: 0, unprocessed: 3, stopped: "rate_limited" });
    expect(counts.stoppedError).toMatch(/^groq openai\/gpt-oss-120b, attempt 4 of 4: HTTP 429 requests: Rate limit reached$/);
    expect(h.written).toEqual([]);
  });
});

describe("provider per agent", () => {
  const base = { NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", CRON_SECRET: "test-secret-0123456789", GEMINI_API_KEY: "gemini-test" };
  const vars = ["LLM_PROVIDER", "WRITE_LLM_PROVIDER", "FACTCHECK_LLM_PROVIDER", "GROQ_API_KEY", "GROQ_MODEL"];
  const set = (values: Record<string, string>) => {
    for (const v of vars) delete process.env[v];
    Object.assign(process.env, base, values);
    resetEnvCache();
    resetProviderCache();
  };
  afterEach(() => set({}));

  it("defaults write and fact-check to LLM_PROVIDER", () => {
    set({ LLM_PROVIDER: "gemini" });
    expect(["classify", "write", "factcheck"].map((a) => providerNameFor(a as "write"))).toEqual(["gemini", "gemini", "gemini"]);
  });

  it("puts write and fact-check on Groq while classify stays on LLM_PROVIDER", () => {
    set({ LLM_PROVIDER: "gemini", WRITE_LLM_PROVIDER: "groq", FACTCHECK_LLM_PROVIDER: "groq", GROQ_API_KEY: KEY, GROQ_MODEL: MODEL });
    expect(providerNameFor("classify")).toBe("gemini");
    expect(providerNameFor("write")).toBe("groq");
    expect(providerNameFor("factcheck")).toBe("groq");
    expect(getProvider("groq")).toMatchObject({ name: "groq", model: MODEL });
  });

  it("refuses LLM_PROVIDER=groq: classify keeps its current provider", () => {
    set({ LLM_PROVIDER: "groq" });
    expect(() => providerNameFor("classify")).toThrow(/LLM_PROVIDER/);
  });

  it("fails clearly when the key or the model is missing", () => {
    set({ WRITE_LLM_PROVIDER: "groq", GROQ_MODEL: MODEL });
    expect(() => getProvider("groq")).toThrow(/GROQ_API_KEY is not set/);
    set({ WRITE_LLM_PROVIDER: "groq", GROQ_API_KEY: KEY });
    expect(() => getProvider("groq")).toThrow(/GROQ_MODEL is not set/);
  });

  it("check-env warns about a missing Groq key or model, and accepts the Groq variables as known", () => {
    const r = validateEnv({ ...base, ADMIN_EMAILS: "a@example.org", ALLOWED_EMAIL_DOMAINS: "example.org", SITE_URL: "https://x.example.org", WRITE_LLM_PROVIDER: "groq", FACTCHECK_LLM_PROVIDER: "groq", GROQ_API_KEY: KEY });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(
      expect.arrayContaining(["GROQ_MODEL is not set but WRITE_LLM_PROVIDER=groq: the write stage will fail.", "GROQ_MODEL is not set but FACTCHECK_LLM_PROVIDER=groq: the fact-check stage will fail."]),
    );
    expect(r.warnings.join("\n")).not.toMatch(/GROQ_API_KEY/);
    const unknown = validateEnv({ ...base, WRITE_LLM_PROVIDER: "openai" });
    expect(unknown.errors.join("\n")).toMatch(/WRITE_LLM_PROVIDER/);
  });
});
