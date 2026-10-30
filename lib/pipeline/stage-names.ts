// Plain module (no server-only imports) so the CLI script and tests can use the stage order.

/** Pipeline order. "Run next batch", `npm run stage -- all` and the funnel all follow it. */
export const STAGE_ORDER = ["ingest", "classify", "write", "image", "factcheck"] as const;
export type StageName = (typeof STAGE_ORDER)[number];

export function isStageName(value: unknown): value is StageName {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}
