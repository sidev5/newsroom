import "server-only";
import { z } from "zod";
import { AGENTS, LLM_BACKOFF, modelFor, OPENAI_COMPATIBLE_PROVIDERS, PIPELINE_DEFAULTS, type AgentName, type ProviderName, type TieredProviderName } from "@/lib/config";
import { env, requireEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { budgetMessage, createBudgetGuard, type BudgetGuard } from "./budget";
import { supabaseBudgetStore } from "./budget-store";
import { describeProviderError, redactSecrets } from "./errors";
import { createAnthropicProvider } from "./providers/anthropic";
import { createGeminiProvider } from "./providers/gemini";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible";
import type { GenerateRequest, GenerateResponse, LlmProvider } from "./types";

export type { LlmProvider } from "./types";

// ---------------------------------------------------------------------------
// Provider selection (LLM_PROVIDER)
// ---------------------------------------------------------------------------

const providers = new Map<ProviderName, LlmProvider>();

/** Classify uses LLM_PROVIDER; write and fact-check use their own setting when it is given. */
export function providerNameFor(agent: AgentName): ProviderName {
  const e = env();
  if (agent === "write") return e.WRITE_LLM_PROVIDER ?? e.LLM_PROVIDER;
  if (agent === "factcheck") return e.FACTCHECK_LLM_PROVIDER ?? e.LLM_PROVIDER;
  return e.LLM_PROVIDER;
}

function createProvider(name: ProviderName): LlmProvider {
  if (name === "anthropic") return createAnthropicProvider(requireEnv("ANTHROPIC_API_KEY"));
  if (name === "gemini") return createGeminiProvider(requireEnv("GEMINI_API_KEY"));
  const config = OPENAI_COMPATIBLE_PROVIDERS[name];
  const values = env() as unknown as Record<string, string | undefined>;
  const apiKey = values[config.apiKeyEnv];
  const model = values[config.modelEnv];
  if (!apiKey) throw new Error(`${config.apiKeyEnv} is not set (a stage is configured to use ${config.label})`);
  if (!model) throw new Error(`${config.modelEnv} is not set: name a model from ${config.label}'s model list`);
  return createOpenAICompatibleProvider(name, config, apiKey, model);
}

export function getProvider(name: ProviderName = env().LLM_PROVIDER): LlmProvider {
  let provider = providers.get(name);
  if (!provider) {
    provider = createProvider(name);
    providers.set(name, provider);
  }
  return provider;
}

/** Tests only. */
export function resetProviderCache(): void {
  providers.clear();
}

// ---------------------------------------------------------------------------
// callAgent
// ---------------------------------------------------------------------------

export type AgentRun = {
  agent: AgentName;
  model: string;
  article_id: string | null;
  raw_item_id: string | null;
  input_tokens: number;
  output_tokens: number;
};

export type CallAgentParams<T> = {
  agent: AgentName;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  articleId?: string | null;
  rawItemId?: string | null;
};

/**
 * invalid_output: the model answered twice but never matched the schema -> mark the item failed.
 * rate_limited:   429s persisted through backoff -> leave the item unprocessed for the next run.
 * provider_error: outage or config problem (5xx after backoff, bad key, bad model) or a call that timed out -> leave unprocessed.
 * budget_exceeded: the daily spend cap (DAILY_BUDGET_USD) is reached; nothing was sent to the provider -> leave unprocessed.
 */
export type CallAgentResult<T> =
  | { ok: true; data: T; attempts: number }
  | { ok: false; reason: "invalid_output" | "rate_limited" | "provider_error" | "budget_exceeded"; error: string };

export type CallAgentDeps = {
  provider?: LlmProvider;
  logRun?: (run: AgentRun) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** The daily spend cap. Omitted: the real one (agent_runs and DAILY_BUDGET_USD), unless `logRun` is given. null: no cap. */
  budget?: BudgetGuard | null;
  /** Per-call timeout in ms. Omitted: LLM_TIMEOUT_MS. */
  timeoutMs?: number;
};

const MAX_ERROR_CHARS = 2000;

/** The configured keys, so an error text that echoes one is cleaned before it is logged or stored. */
function configuredKeys(): string[] {
  const openAICompatible = Object.values(OPENAI_COMPATIBLE_PROVIDERS).map((p) => process.env[p.apiKeyEnv]);
  return [process.env.GEMINI_API_KEY, process.env.ANTHROPIC_API_KEY, ...openAICompatible].filter((k): k is string => Boolean(k));
}

async function logToSupabase(run: AgentRun): Promise<void> {
  const { error } = await supabaseAdmin().from("agent_runs").insert(run);
  if (error) throw new Error(error.message);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** LLM_TIMEOUT_MS; the default when the environment is not valid (the stage reports that problem itself). */
function configuredTimeout(): number {
  try {
    return env().LLM_TIMEOUT_MS;
  } catch {
    return PIPELINE_DEFAULTS.LLM_TIMEOUT_MS;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse model text as JSON (tolerating a ```json fence) and validate it. */
export function parseAgentOutput<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  if (!trimmed) return { ok: false, error: "Empty response." };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `Response was not valid JSON: ${message(err)}` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: z.prettifyError(result.error).slice(0, MAX_ERROR_CHARS) };
}

function retryPrompt(prompt: string, error: string): string {
  return (
    `${prompt}\n\n` +
    `Your previous response was rejected because it did not match the required JSON schema:\n` +
    `${error}\n` +
    `Respond again with only a JSON object that matches the schema exactly.`
  );
}

/** A call that did not answer within the timeout. Transient by nature: the item stays queued for the next run. */
export class LlmTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = "LlmTimeoutError";
  }
}

/** The provider call, abandoned after `ms` even if the SDK ignores its own timeout. */
async function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([call, limit]);
  } finally {
    clearTimeout(timer);
    call.catch(() => {}); // the abandoned call may still fail later; nobody is waiting for it
  }
}

type GenerateOutcome =
  | { ok: true; response: GenerateResponse }
  | { ok: false; reason: "rate_limited" | "provider_error"; error: string };

async function generateWithBackoff(
  provider: LlmProvider,
  req: GenerateRequest,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<GenerateOutcome> {
  // "gemini gemini-3.6-flash, attempt 2 of 4: HTTP 503 UNAVAILABLE: ...", keys removed: printed by the stage and stored in pipeline_runs.
  const giveUp = (reason: "rate_limited" | "provider_error", attempt: number, detail: string): GenerateOutcome => {
    const error = redactSecrets(`${provider.name} ${req.model}, attempt ${attempt + 1} of ${LLM_BACKOFF.retries + 1}: ${detail}`, configuredKeys()).slice(0, MAX_ERROR_CHARS);
    console.error(`LLM call failed (${reason}): ${error}`);
    return { ok: false, reason, error };
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, response: await withTimeout(provider.generate(req), timeoutMs) };
    } catch (err) {
      // A timeout is not retried here: every retry would wait another full timeout, longer than the function may run.
      if (err instanceof LlmTimeoutError) {
        return giveUp("provider_error", attempt, `no answer ${err.message} (LLM_TIMEOUT_MS=${timeoutMs})`);
      }
      const cls = provider.classifyError(err);
      const reason = cls.kind === "rate_limited" ? "rate_limited" : "provider_error";
      if (cls.kind === "fatal" || attempt >= LLM_BACKOFF.retries) {
        return giveUp(reason, attempt, describeProviderError(err));
      }
      const backoff = LLM_BACKOFF.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      const hinted = cls.kind === "rate_limited" ? cls.retryAfterMs : undefined;
      await sleep(Math.min(LLM_BACKOFF.maxDelayMs, hinted ?? backoff));
    }
  }
}

/**
 * One LLM task with the same behaviour on every provider:
 * JSON output validated with zod, one retry that includes the validation error,
 * backoff on 429/transient errors, and an agent_runs row for every response received.
 */
let defaultBudget: BudgetGuard | undefined;

/** The real cap: agent_runs for the spend, DAILY_BUDGET_USD (and an admin's raise) for the limit. */
function budgetGuard(): BudgetGuard {
  defaultBudget ??= createBudgetGuard({ store: supabaseBudgetStore(), baseLimitUsd: () => env().DAILY_BUDGET_USD });
  return defaultBudget;
}

/** Tests only. */
export function resetBudgetGuard(): void {
  defaultBudget = undefined;
}

export async function callAgent<T>(
  params: CallAgentParams<T>,
  deps: CallAgentDeps = {},
): Promise<CallAgentResult<T>> {
  const provider = deps.provider ?? getProvider(providerNameFor(params.agent));
  const logRun = deps.logRun ?? logToSupabase;
  const sleep = deps.sleep ?? defaultSleep;
  const settings = AGENTS[params.agent];
  const timeoutMs = deps.timeoutMs ?? configuredTimeout();
  // Constructing the real guard needs the database client; if that is not available the call is simply not capped.
  let budget: BudgetGuard | null = null;
  try {
    // A caller that brings its own logRun is not using the database, so the database-backed cap is not applied either.
    budget = deps.budget === undefined ? (deps.logRun ? null : budgetGuard()) : deps.budget;
  } catch (err) {
    console.error(`daily budget unavailable, calls are not capped: ${message(err)}`);
  }

  const baseRequest: GenerateRequest = {
    model: provider.model ?? modelFor(provider.name as TieredProviderName, params.agent),
    system: params.system,
    prompt: params.prompt,
    schema: params.schema,
    maxTokens: settings.maxTokens,
    effort: settings.anthropicEffort,
    refusalFallback: settings.tier === "strong",
    // The SDK gets a little longer than callAgent does, so callAgent's own limit is the one that ends a hung call.
    timeoutMs: timeoutMs + 5000,
  };

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? params.prompt : retryPrompt(params.prompt, lastError);
    // BE-04: nothing is sent to the provider once the day's cap is reached; the item stays queued.
    if (budget) {
      const check = await budget.check();
      if (!check.allowed) return { ok: false, reason: "budget_exceeded", error: budgetMessage(check.state) };
    }
    const outcome = await generateWithBackoff(provider, { ...baseRequest, prompt }, sleep, timeoutMs);
    if (!outcome.ok) return outcome;

    const { response } = outcome;
    budget?.record({ model: response.model, input_tokens: response.inputTokens, output_tokens: response.outputTokens });
    try {
      await logRun({
        agent: params.agent,
        model: response.model,
        article_id: params.articleId ?? null,
        raw_item_id: params.rawItemId ?? null,
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
      });
    } catch (err) {
      // A logging failure must not discard a paid-for result.
      console.error(`agent_runs insert failed (${params.agent}): ${message(err)}`);
    }

    const parsed = parseAgentOutput(response.text, params.schema);
    if (parsed.ok) return { ok: true, data: parsed.data, attempts: attempt };
    lastError = parsed.error;
  }
  return { ok: false, reason: "invalid_output", error: lastError };
}

/**
 * What a stage does with an item after callAgent:
 * - done:          success, apply the result
 * - fail:          invalid output twice, mark the item 'failed'
 * - leave_and_stop: rate limit or provider problem; leave the item as it is
 *                  and stop the batch, since later items would hit the same wall
 */
export function itemAction(result: CallAgentResult<unknown>): "done" | "fail" | "leave_and_stop" {
  if (result.ok) return "done";
  return result.reason === "invalid_output" ? "fail" : "leave_and_stop";
}
