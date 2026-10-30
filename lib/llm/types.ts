import type { z } from "zod";
import type { ProviderName } from "@/lib/config";

export type GenerateRequest = {
  model: string;
  system: string;
  prompt: string;
  /** Schema the output must match. Each provider turns it into its own JSON-output setting. */
  schema: z.ZodType;
  maxTokens: number;
  /** Anthropic only. */
  effort?: "low" | "medium" | "high";
  /** Anthropic only: enable server-side refusal fallback (strong tier). */
  refusalFallback?: boolean;
  /**
   * The provider's own timeout for this call, in ms. callAgent also enforces its own (shorter) limit, so this is the
   * backstop that frees the connection; a provider that ignores it is still stopped by callAgent.
   */
  timeoutMs?: number;
};

export type GenerateResponse = {
  /** Raw model text; validated by callAgent, not the provider. */
  text: string;
  /** Model that actually served the request (can differ after a fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * rate_limited: 429. transient: 5xx, overload, timeout, network (worth retrying).
 * fatal: everything else (bad request, auth, not found); retrying won't help.
 */
export type ErrorClass =
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "transient" }
  | { kind: "fatal" };

export interface LlmProvider {
  readonly name: ProviderName;
  /** Set when the provider serves one configured model for every agent (OpenAI-compatible providers); otherwise LLM_MODELS decides. */
  readonly model?: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  classifyError(err: unknown): ErrorClass;
}
