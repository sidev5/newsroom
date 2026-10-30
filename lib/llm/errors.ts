// The provider error as people need to read it: HTTP status, the provider's own status word and message, with every API key
// taken out. Plain module (no env, no SDK imports) so it is tested on its own; callAgent passes the configured keys in.

/** Shapes of keys that must never reach a log, the pipeline_runs table or the admin screen, whatever their source. */
const KEY_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /sk-ant-[0-9A-Za-z_-]{10,}/g, // Anthropic keys
  /\b(key|api_key|apikey|x-goog-api-key|x-api-key)=[^&\s"']+/gi, // a key in a query string or header dump
  /\bBearer\s+[0-9A-Za-z._~+/-]{10,}=*/g,
];

export const REDACTED = "[REDACTED]";

/** `text` without the given secrets (exact values, at least 8 characters) and without anything shaped like an API key. */
export function redactSecrets(text: string, secrets: readonly (string | undefined | null)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join(REDACTED);
  for (const pattern of KEY_PATTERNS) {
    // Without a capture group the second argument is the match's offset (a number), not a name.
    out = out.replace(pattern, (_match, name: unknown) => (typeof name === "string" ? `${name}=${REDACTED}` : REDACTED));
  }
  return out;
}

type ErrorBody = { error?: { code?: unknown; status?: unknown; message?: unknown; type?: unknown } };

/** The first JSON object in `text`, if there is one (Gemini's message is the body itself; Anthropic's is "504 {...}"). */
function jsonBody(text: string): ErrorBody | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ErrorBody) : null;
  } catch {
    return null;
  }
}

/**
 * "HTTP 504 DEADLINE_EXCEEDED: Deadline expired before operation could complete." from a provider SDK error (both SDKs put the
 * HTTP status on `status`), or the plain message for network errors. Not yet redacted: see redactSecrets.
 */
export function describeProviderError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const statusProp = (err as { status?: unknown }).status;
  const body = jsonBody(err.message)?.error;
  const code = typeof statusProp === "number" ? statusProp : typeof body?.code === "number" ? body.code : null;
  const word = typeof body?.status === "string" ? body.status : typeof body?.type === "string" ? body.type : null;
  const text = typeof body?.message === "string" ? body.message : err.message;
  const head = [code !== null ? `HTTP ${code}` : null, word].filter(Boolean).join(" ");
  const named = head || (err.name && err.name !== "Error" ? err.name : "");
  return named ? `${named}: ${text}` : text;
}
