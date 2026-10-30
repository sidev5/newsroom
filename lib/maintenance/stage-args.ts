// The command line of `npm run stage -- <name> [--apply]`, as a plain function so the script's rules can be tested.

/** The stages that change data and therefore only do so with --apply. */
export const APPLY_STAGES = ["cleanup", "purge-sample"];

export type StageArgs = { ok: true; stage: string; apply: boolean } | { ok: false; error: string };

/**
 * `argv` is process.argv. `stages` are the names a single call accepts ("all" is always accepted too).
 * Only `cleanup` and `purge-sample` take an option, --apply; without it they are a dry run that changes nothing.
 */
export function parseStageArgs(argv: string[], stages: readonly string[]): StageArgs {
  const stage = argv[2];
  const usage = `Usage: npm run stage -- <all|${stages.join("|")}> (cleanup and purge-sample also take --apply)`;
  if (!stage || (stage !== "all" && !stages.includes(stage))) return { ok: false, error: usage };

  const extra = argv.slice(3);
  const unknown = extra.filter((a) => a !== "--apply");
  if (unknown.length > 0) return { ok: false, error: `Unknown option: ${unknown.join(" ")}. ${usage}` };
  if (extra.length > 0 && !APPLY_STAGES.includes(stage)) return { ok: false, error: `--apply is only for cleanup and purge-sample. ${usage}` };
  return { ok: true, stage, apply: extra.includes("--apply") };
}

/** The cron route to call. Only an applied cleanup or purge-sample gets ?apply=true. */
export function cronUrl(base: string, name: string, apply: boolean): string {
  return `${base}/api/cron/${name}${APPLY_STAGES.includes(name) && apply ? "?apply=true" : ""}`;
}
