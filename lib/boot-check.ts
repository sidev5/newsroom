import { formatReport, validateEnv } from "./env-check";

/**
 * Runs when the server starts (instrumentation.ts). Missing or broken settings stop the boot with a message
 * that names every problem; warnings are printed and the app starts. (A key defined twice in .env.local is
 * found by `npm run check-env`, which reads the file; this code runs in the server bundle and must not touch the disk.)
 */
export function bootCheck(source: Record<string, string | undefined> = process.env): void {
  const report = validateEnv(source);
  if (report.errors.length > 0) throw new Error(`The newsroom cannot start.\n${formatReport(report)}`);
  if (report.warnings.length > 0) console.warn(`Newsroom startup warnings.\n${formatReport(report)}`);
}
