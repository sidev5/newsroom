import { z } from "zod";
import type { OpenAICompatibleConfig, OpenAICompatibleName } from "@/lib/config";
import type { ErrorClass, GenerateRequest, GenerateResponse, LlmProvider } from "../types";

// Providers with an OpenAI-compatible chat API (Groq; Cerebras and others by an entry in OPENAI_COMPATIBLE_PROVIDERS). Plain fetch,
// no SDK: one POST to <baseUrl>/chat/completions. callAgent does the rest exactly as for the other providers: zod validation with one
// retry, backoff on 429 and 5xx, items left queued when the provider keeps refusing, and the redacted error report.

/** An HTTP error from the provider. The message is the response body, which describeProviderError reads. */
export class OpenAICompatibleError extends Error {
  constructor(
    readonly status: number,
    body: string,
    readonly retryAfterMs?: number,
  ) {
    super(body || `HTTP ${status}`);
    this.name = "OpenAICompatibleError";
  }
}

export type OpenAICompatibleDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Keeps calls at least `intervalMs` apart in this process (30 per minute = one every 2 s). A slot is reserved before waiting, so
 * calls made at the same time line up instead of all going at once.
 */
export function createRequestSpacer(intervalMs: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = defaultSleep) {
  let nextAt = 0;
  return async (): Promise<void> => {
    const t = now();
    const startAt = Math.max(t, nextAt);
    nextAt = startAt + intervalMs;
    if (startAt > t) await sleep(startAt - t);
  };
}

/** The JSON Schema for response_format: no $schema key, and oneOf as anyOf (the union keyword Groq documents). */
export function openAIJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const rename = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rename);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k === "oneOf" ? "anyOf" : k, rename(v)]));
  };
  const json = rename(z.toJSONSchema(schema)) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function retryAfterMs(headers: Headers): number | undefined {
  const seconds = Number(headers.get("retry-after"));
  return headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

type ErrorBody = { error?: { message?: unknown; code?: unknown; failed_generation?: unknown } };

/** Groq answers 400 when the model's JSON fails the schema check; that is invalid output (one retry), not a provider fault. */
function failedGeneration(status: number, body: string): string | null {
  if (status !== 400) return null;
  let parsed: ErrorBody;
  try {
    parsed = JSON.parse(body) as ErrorBody;
  } catch {
    return null;
  }
  const e = parsed.error;
  const message = typeof e?.message === "string" ? e.message : "";
  if (e?.code !== "json_validate_failed" && !/failed to generate json|generated json does not match/i.test(message)) return null;
  return typeof e?.failed_generation === "string" ? e.failed_generation : "";
}

type ChatResponse = {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function createOpenAICompatibleProvider(
  name: OpenAICompatibleName,
  config: OpenAICompatibleConfig,
  apiKey: string,
  model: string,
  deps: OpenAICompatibleDeps = {},
): LlmProvider {
  const doFetch = deps.fetch ?? fetch;
  const space = createRequestSpacer(Math.ceil(60_000 / config.requestsPerMinute), deps.now, deps.sleep);
  const structured = config.jsonSchemaModels.includes(model);
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    name,
    model,

    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const schema = openAIJsonSchema(req.schema);
      // json_object only promises valid JSON, so the schema goes into the instructions; validation still happens in callAgent.
      const system = structured ? req.system : `${req.system}\n\nThe JSON object must match this JSON Schema:\n${JSON.stringify(schema)}`;
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: req.prompt },
        ],
        max_completion_tokens: Math.min(req.maxTokens, config.maxOutputTokens),
        response_format: structured
          ? // Best effort (strict: false): strict mode wants every field required, and the write schema has an optional one.
            { type: "json_schema", json_schema: { name: "output", schema, strict: false } }
          : { type: "json_object" },
      };

      await space();
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(req.timeoutMs ? { signal: AbortSignal.timeout(req.timeoutMs) } : {}),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const failed = failedGeneration(res.status, text);
        if (failed !== null) return { text: failed, model: `${name}/${model}`, inputTokens: 0, outputTokens: 0 };
        throw new OpenAICompatibleError(res.status, text, retryAfterMs(res.headers));
      }

      const data = (await res.json()) as ChatResponse;
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        // Prefixed with the provider, so the price table can tell a free tier from the same model elsewhere.
        model: `${name}/${data.model ?? model}`,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        // Reasoning tokens are part of completion_tokens on these APIs.
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    },

    classifyError(err: unknown): ErrorClass {
      if (err instanceof OpenAICompatibleError) {
        if (err.status === 429) return { kind: "rate_limited", retryAfterMs: err.retryAfterMs };
        return err.status === 408 || err.status >= 500 ? { kind: "transient" } : { kind: "fatal" };
      }
      // fetch failures and timeouts surface as plain errors (TypeError, AbortError, TimeoutError).
      if (err instanceof TypeError || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
        return { kind: "transient" };
      }
      return { kind: "fatal" };
    },
  };
}
