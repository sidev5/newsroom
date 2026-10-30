import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { ErrorClass, GenerateRequest, GenerateResponse, LlmProvider } from "../types";

/** Gemini puts RetryInfo in the error body, e.g. "retryDelay": "17s". */
function retryDelayMs(message: string): number | undefined {
  const match = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Number(match[1]) * 1000 : undefined;
}

export function geminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema; // Gemini rejects the meta-schema key
  return jsonSchema;
}

export function createGeminiProvider(apiKey: string): LlmProvider {
  // attempts: 1 = no SDK retries, so both providers share callAgent's backoff policy.
  const client = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });

  return {
    name: "gemini",

    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const response = await client.models.generateContent({
        model: req.model,
        contents: req.prompt,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: geminiJsonSchema(req.schema),
          maxOutputTokens: req.maxTokens,
          ...(req.timeoutMs ? { httpOptions: { timeout: req.timeoutMs }, abortSignal: AbortSignal.timeout(req.timeoutMs) } : {}),
        },
      });

      const u = response.usageMetadata;
      return {
        text: response.text ?? "",
        model: response.modelVersion ?? req.model,
        inputTokens: u?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output.
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      };
    },

    classifyError(err: unknown): ErrorClass {
      if (err instanceof ApiError) {
        if (err.status === 429) return { kind: "rate_limited", retryAfterMs: retryDelayMs(err.message) };
        return err.status === 408 || err.status >= 500 ? { kind: "transient" } : { kind: "fatal" };
      }
      // fetch failures and timeouts surface as plain errors (TypeError, AbortError).
      if (err instanceof TypeError || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
        return { kind: "transient" };
      }
      return { kind: "fatal" };
    },
  };
}
