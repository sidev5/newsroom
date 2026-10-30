import "server-only";
import { schema, type Env } from "./env-schema";

export { parseDomains } from "./env-schema";
export type { Env };

let cached: Env | undefined;

/** Validated server env. Parsed lazily so `next build` doesn't need secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Tests only: re-read process.env on the next env() call. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** For stage-specific keys declared optional above. */
export function requireEnv<K extends "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "UNSPLASH_ACCESS_KEY">(
  key: K,
): string {
  const value = env()[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}
