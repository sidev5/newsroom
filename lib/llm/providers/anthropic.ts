import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ErrorClass, GenerateRequest, GenerateResponse, LlmProvider } from "../types";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  const seconds = value ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function createAnthropicProvider(apiKey: string): LlmProvider {
  // SDK retries are off so both providers share callAgent's backoff policy.
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  return {
    name: "anthropic",

    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const response = await client.beta.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        // Structured outputs constrain the reply to the schema; callAgent still validates with zod.
        output_config: {
          format: zodOutputFormat(req.schema),
          ...(req.effort ? { effort: req.effort } : {}),
        },
        // On a safety decline, the API re-runs the request on a fallback model in the same call.
        ...(req.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      }, req.timeoutMs ? { timeout: req.timeoutMs } : undefined);

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const u = response.usage;
      return {
        text,
        model: response.model,
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      };
    },

    classifyError(err: unknown): ErrorClass {
      if (err instanceof Anthropic.RateLimitError) {
        return { kind: "rate_limited", retryAfterMs: retryAfterMs(err.headers) };
      }
      if (err instanceof Anthropic.APIConnectionError) return { kind: "transient" }; // includes timeouts
      if (err instanceof Anthropic.APIError) {
        const status = err.status ?? 0;
        return status === 408 || status >= 500 ? { kind: "transient" } : { kind: "fatal" };
      }
      return { kind: "fatal" };
    },
  };
}
