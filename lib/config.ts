// Single place for model names and per-agent LLM settings.
// Change a model here and every stage picks it up.

export type AgentName = "classify" | "write" | "factcheck";
export type ModelTier = "fast" | "strong";

/**
 * Providers with an OpenAI-compatible chat API (POST <baseUrl>/chat/completions), driven by lib/llm/providers/openai-compatible.ts.
 * Adding one is an entry here and its two variables in the environment: no other code. Cerebras, for example, would be
 *   cerebras: { label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", modelEnv: "CEREBRAS_MODEL",
 *               requestsPerMinute: <its free-tier limit>, maxOutputTokens: 4096, jsonSchemaModels: [<models its docs list>], freeTier: true },
 * (check its documentation for the limit and the models before adding it).
 */
export type OpenAICompatibleConfig = {
  label: string;
  baseUrl: string;
  /** Environment variable that holds the API key. */
  apiKeyEnv: string;
  /** Environment variable that holds the model id, as the provider's model list spells it. There is no default on purpose. */
  modelEnv: string;
  /** Requests are spaced 60000 / requestsPerMinute ms apart within one process. */
  requestsPerMinute: number;
  /** Upper bound for max_completion_tokens, whatever the agent asks for (free tiers count it against tokens per minute). */
  maxOutputTokens: number;
  /** Models that accept response_format json_schema; every other model gets json_object with the schema in the prompt. */
  jsonSchemaModels: readonly string[];
  /** Free tier: its runs are priced at $0 (MODEL_PRICES_USD_PER_MTOK), so they do not use up DAILY_BUDGET_USD. */
  freeTier: boolean;
};

export const OPENAI_COMPATIBLE_PROVIDERS = {
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    // Groq's rate-limit page (checked 2026-10-29) lists 30 requests per minute for its text models.
    requestsPerMinute: 30,
    // A write needs ~500 tokens, a blog ~2000, gpt-oss also reasons; Groq's per-minute token limits are a few thousand.
    maxOutputTokens: 6000,
    // From Groq's "Structured Outputs" page, checked 2026-10-29.
    jsonSchemaModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-safeguard-20b", "qwen/qwen3.8-27b", "meta-models/muse-spark-open"],
    freeTier: true,
  },
} as const satisfies Record<string, OpenAICompatibleConfig>;

export type OpenAICompatibleName = keyof typeof OPENAI_COMPATIBLE_PROVIDERS;
/** Providers whose models are chosen per tier in LLM_MODELS. */
export type TieredProviderName = "anthropic" | "gemini";
export type ProviderName = TieredProviderName | OpenAICompatibleName;

export const TIERED_PROVIDERS = ["anthropic", "gemini"] as const satisfies readonly TieredProviderName[];
export const PROVIDER_NAMES = [...TIERED_PROVIDERS, ...(Object.keys(OPENAI_COMPATIBLE_PROVIDERS) as OpenAICompatibleName[])] as [ProviderName, ...ProviderName[]];

export function isOpenAICompatible(name: string): name is OpenAICompatibleName {
  return Object.hasOwn(OPENAI_COMPATIBLE_PROVIDERS, name);
}

/** fast = classify; strong = write and factcheck. */
export const LLM_MODELS: Record<TieredProviderName, Record<ModelTier, string>> = {
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    strong: "claude-sonnet-5-5",
  },
  gemini: {
    fast: "gemini-3.5-flash-lite",
    // Google lists no stable Pro model as of 2026-10; gemini-3.1-pro-preview is the preview option.
    // Not gemini-3.8-flash / 3.7-flash: on 2026-10-29 both answered 503 UNAVAILABLE ("high demand") or 504 DEADLINE_EXCEEDED
    // even for a 30-token reply, so every write and fact-check call ended as provider_error. 3.6-flash answered in ~3 s.
    // Before moving to a newer model, try it with the write prompt and watch for the same errors in pipeline_runs.error.
    strong: "gemini-3.6-flash",
  },
};

type AgentSettings = {
  tier: ModelTier;
  /** Output cap per call. Includes thinking tokens on models that think. */
  maxTokens: number;
  /** Anthropic `output_config.effort` (strong tier only; Haiku 4.5 doesn't accept it). Ignored by Gemini. */
  anthropicEffort?: "low" | "medium" | "high";
};

export const AGENTS: Record<AgentName, AgentSettings> = {
  classify: { tier: "fast", maxTokens: 1024 },
  write: { tier: "strong", maxTokens: 16000, anthropicEffort: "medium" },
  factcheck: { tier: "strong", maxTokens: 16000, anthropicEffort: "high" },
};

export function modelFor(provider: TieredProviderName, agent: AgentName): string {
  return LLM_MODELS[provider][AGENTS[agent].tier];
}

/** Backoff for 429s and transient provider errors (5xx, timeouts, network). */
export const LLM_BACKOFF = {
  retries: 3, // after the first attempt
  baseDelayMs: 2000, // 2s, 4s, 8s (+ jitter) unless the provider sends a retry delay
  maxDelayMs: 30000,
} as const;

/**
 * Rough USD prices per million tokens, for the /admin/costs estimate only. Keyed by the model name
 * recorded in agent_runs.model (what the API reports as serving the request, which can carry a
 * version suffix; the longest matching prefix wins). A model with no entry shows "no price" instead
 * of a guess. Check these against the providers' pricing pages before relying on the totals.
 * Last checked 2026-10-12: Anthropic from the Claude API docs; Gemini 3.5 Flash-Lite from third-party
 * aggregators (not Google's page); Gemini 3.8 Flash not found, so unset.
 */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  // "gemini-3.6-flash": { input: ?, output: ? },
  // OpenAI-compatible free tiers: their runs are recorded as "<provider>/<model>" (e.g. "groq/openai/gpt-oss-120b") and cost nothing.
  ...Object.fromEntries(
    Object.entries(OPENAI_COMPATIBLE_PROVIDERS as Record<string, OpenAICompatibleConfig>)
      .filter(([, p]) => p.freeTier)
      .map(([name]) => [`${name}/`, { input: 0, output: 0 }]),
  ),
};

/** Unsplash requires attribution links to carry utm_source=<app name>&utm_medium=referral. */
export const IMAGE_UTM = { source: "ai_newsroom", medium: "referral" } as const;

/** Department slugs that have a default SVG in public/images/defaults/ (plus default.svg). */
export const DEFAULT_IMAGE_SLUGS = ["ev", "batteries", "defence", "software", "sales-marketing", "ai-technology"] as const;

/** The AI & Technology department (kind company). The description is also what the migration stores. */
export const AI_TECH_DEPARTMENT_SLUG = "ai-technology";
export const AI_TECH_DEPARTMENT_NAME = "AI & Technology";
export const AI_TECH_DESCRIPTION =
  "Artificial intelligence and machine learning, LLMs and generative AI, AI regulation and safety, robotics and automation, semiconductors and AI chips, cloud and data-center technology, and cybersecurity.";

// ---------------------------------------------------------------------------
// Employee submissions (/submit)
// ---------------------------------------------------------------------------

/** The company departments an author can say they belong to (a select on /submit). Edit this list to change it. */
export const SUBMISSION_AUTHOR_DEPARTMENTS = [
  "EV",
  "Batteries",
  "Defence",
  "Software Development",
  "Sales & Marketing",
  "AI & Technology",
  "HR",
  "Finance",
  "Operations",
  "Other",
] as const;

export const SUBMISSION_LIMITS = {
  NAME_MAX: 60,
  TITLE_MIN: 5,
  TITLE_MAX: 140,
  TEXT_MIN: 200,
  TEXT_MAX: 6000,
  CREDIT_MAX: 200,
  EMAIL_MAX: 254,
  /** Photo upload, in bytes, checked on the real file. */
  PHOTO_MAX_BYTES: 5 * 1024 * 1024,
  /** The stored photo is scaled down to this width. */
  PHOTO_MAX_WIDTH: 1600,
  /** Refuse absurd pixel counts before decoding (decompression bombs). */
  PHOTO_MAX_PIXELS: 40_000_000,
  /** Per rolling 24 hours. */
  MAX_PER_IP_PER_DAY: 3,
  MAX_PER_EMAIL_PER_DAY: 5,
  /** The same email with the same title inside this window is a duplicate. */
  DUPLICATE_WINDOW_HOURS: 24,
} as const;

/** Country preselected on the form (ISO-3166 alpha-2). */
export const SUBMISSION_DEFAULT_COUNTRY = "IN";

/** Private bucket for photos waiting for review; public bucket for photos of published articles. */
export const STORAGE_BUCKETS = { submissions: "submission-images", published: "article-images" } as const;

/** Lifetime of the admin's photo preview link. */
export const SIGNED_URL_SECONDS = 600;

export const ARTICLE_WORDS = { min: 150, max: 250 } as const;

/**
 * AI-written "blocks" blogs (lib/pipeline/blog.ts): the write stage makes one for an item filed under one of these departments
 * (slugs), as headings, paragraphs, short code and images, instead of the short plain article. Every other department keeps the
 * plain format.
 */
export const BLOG_DEPARTMENT_SLUGS: readonly string[] = ["software", "ai-technology"];

/** The prompt asks for min-max words of reading text; validation accepts `tolerance` more or less, so a near miss is not a failure. */
export const BLOG_WORDS = { min: 600, max: 1200, tolerance: 0.1 } as const;

export const BLOG_LIMITS = {
  /**
   * A source shorter than this (in words) is written up in the short plain format instead: 600 words from a thin source
   * would have to be padded with things the source does not say.
   */
  MIN_SOURCE_WORDS: 350,
  MAX_CODE_BLOCKS: 2,
  /** "Short" code: more than this many lines or characters is refused. */
  CODE_MAX_LINES: 30,
  CODE_MAX_CHARS: 1500,
  MAX_IMAGES: 3,
  MIN_HEADINGS: 2,
} as const;

/**
 * Pipeline volume settings (defaults sized for a weekly run). Each can be overridden by the
 * environment variable of the same name; lib/env.ts validates the overrides with zod.
 */
export const PIPELINE_DEFAULTS = {
  /** Max items one stage processes in one run, across all its chunks. Also the cap for cron calls. */
  BATCH_LIMIT: 25,
  /** Max new items taken from one feed per ingest run, newest first. */
  MAX_ITEMS_PER_FEED: 15,
  /** A stage works through its queue this many items at a time... */
  STAGE_CHUNK_SIZE: 5,
  /** ...pausing this long between chunks, to stay under provider rate limits. */
  STAGE_DELAY_MS: 1500,
  /** A stage stops starting new work after this long, so it ends cleanly before the route's maxDuration (60s). */
  STAGE_TIME_BUDGET_MS: 50_000,
  /** One LLM call may take this long before it is given up on and the item stays queued (BE-02). */
  LLM_TIMEOUT_MS: 45_000,
  /** The most the LLM calls may cost per day (Asia/Kolkata), in USD, by the prices in MODEL_PRICES_USD_PER_MTOK (BE-04). */
  DAILY_BUDGET_USD: 2,
} as const;

/** A "running" row in pipeline_runs older than this is a crashed run: it no longer blocks the stage (BE-05). */
export const STAGE_LOCK_STALE_MS = 10 * 60_000;

/** A digest in "sending" for longer than this is shown as stuck, with a "Mark as failed" button (BE-03). */
export const DIGEST_STUCK_MINUTES = 15;

/** The same stage failing this many runs in a row raises the banner and the alert email (BE-06). */
export const FAILURE_ALERT_STREAK = 2;

/** Redirects followed when fetching a feed or an article page; each hop is checked again (SEC-07). */
export const MAX_FETCH_REDIRECTS = 3;

/** SEC-13: how long personal data of /submit is kept. Both can be changed with an environment variable (lib/env-schema.ts). */
export const PRIVACY_RETENTION = {
  /** article_submitters.ip_hash is set to null after this many days (the abuse limits need 24 hours). */
  IP_HASH_DAYS: 7,
  /** The submitter's email is replaced by an anonymous placeholder this many days after the article's decision (published or rejected). */
  EMAIL_DAYS: 90,
} as const;

/** DB-03: retention. */
export const RETENTION = {
  /** raw_items.full_text of a written/skipped item is cleared after this many days. */
  FULL_TEXT_DAYS: 14,
  /** raw_items older than this with no article are deleted. */
  RAW_ITEM_DAYS: 90,
  /** agent_runs and pipeline_runs older than this are deleted. */
  RUN_LOG_MONTHS: 12,
} as const;

export const DEFAULT_BATCH_LIMIT = PIPELINE_DEFAULTS.BATCH_LIMIT;

/** Slug of the departments row with kind = 'world'. */
export const WORLD_DEPARTMENT_SLUG = "world";

/** Characters of item content sent to the classifier. */
export const CLASSIFY_CONTENT_CHARS = 500;

/** The "Write" page: block-based stories (lib/stories/blocks.ts). Limits are enforced on the server; the form shows them as hints. */
export const STORY_LIMITS = {
  TITLE_MIN: 5,
  TITLE_MAX: 120,
  SUMMARY_MAX: 240,
  MAX_BLOCKS: 60,
  MAX_IMAGES: 8,
  PARAGRAPH_MAX: 5000,
  HEADING_MAX: 200,
  QUOTE_MAX: 2000,
  CITE_MAX: 200,
  LIST_ITEMS_MAX: 50,
  LIST_ITEM_MAX: 500,
  CODE_MAX: 20_000,
  FILENAME_MAX: 100,
  CAPTION_MAX: 300,
  ALT_MAX: 300,
  LINK_TITLE_MAX: 200,
  LINK_DESCRIPTION_MAX: 300,
  URL_MAX: 2000,
  /** Characters of reading text (paragraphs, headings, quotes, lists) a story needs, as TEXT_MIN does for plain stories. */
  PROSE_MIN: 200,
  /** All text of all blocks together, code included. */
  TOTAL_TEXT_MAX: 100_000,
  /** The JSON part of the request. */
  PAYLOAD_MAX_BYTES: 400_000,
  /** The whole multipart request: eight images of the size limit, plus the JSON and form fields. */
  REQUEST_MAX_BYTES: 8 * 5 * 1024 * 1024 + 1024 * 1024,
} as const;

/** Likes and comments on stories written with Write. Readers prove a company email with a one-time code. */
export const READER_LIMITS = {
  CODE_DIGITS: 6,
  CODE_TTL_MINUTES: 10,
  CODE_MAX_ATTEMPTS: 5,
  CODES_PER_EMAIL_PER_HOUR: 5,
  CODES_PER_IP_PER_HOUR: 20,
  SESSION_DAYS: 14,
  COMMENT_MAX: 1000,
  COMMENT_MIN: 2,
  COMMENTS_PER_HOUR: 5,
  COMMENTS_PER_DAY: 20,
  LIKE_TOGGLES_PER_HOUR: 30,
  LIKE_TOGGLES_PER_DAY: 200,
  /** The newest comments the reader loads. */
  COMMENTS_SHOWN: 100,
} as const;