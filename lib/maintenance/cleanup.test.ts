import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PRIVACY_RETENTION, RETENTION } from "@/lib/config";
import { describeCleanupError, formatCleanup, parseCounts, parsePrivacy, runCleanup, type CleanupStore } from "./cleanup";
import { cronUrl, parseStageArgs } from "./stage-args";

// DB-03: retention. The rules themselves are SQL (run_retention); these tests cover the caller, the cron route,
// the command line and what the SQL file promises.

const NOW = new Date("2026-10-16T05:00:00Z");

const PRIVACY = { ip_hash_cleared: 7, emails_anonymized: 2, photo_paths: ["a.webp", "b.webp"] };

function fakeStore(
  counts = { full_text_cleared: 12, raw_items_deleted: 5, agent_runs_deleted: 40, pipeline_runs_deleted: 3 },
  over: Partial<CleanupStore> = {},
) {
  const retention = vi.fn<CleanupStore["retention"]>(async () => counts);
  const privacy = vi.fn<CleanupStore["privacy"]>(async () => PRIVACY);
  const removePrivatePhotos = vi.fn<CleanupStore["removePrivatePhotos"]>(async (paths) => ({ removed: paths.length, failed: 0 }));
  return { store: { retention, privacy, removePrivatePhotos, ...over } as CleanupStore, retention, privacy, removePrivatePhotos };
}

describe("runCleanup", () => {
  it("is a dry run unless told otherwise, and says nothing changed", async () => {
    const { store, retention } = fakeStore();
    const log = vi.fn();
    const r = await runCleanup({ now: NOW, log }, store);
    expect(retention).toHaveBeenCalledWith(expect.objectContaining({ apply: false }));
    expect(r.apply).toBe(false);
    expect(log.mock.calls[0][0]).toContain("dry run, nothing changed");
  });

  it("applies only with apply: true", async () => {
    const { store, retention } = fakeStore();
    for (const apply of [undefined, false]) await runCleanup({ apply, log: () => {} }, store);
    expect(retention.mock.calls.every(([a]) => a.apply === false)).toBe(true);
    const log = vi.fn();
    const r = await runCleanup({ apply: true, now: NOW, log }, store);
    expect(retention.mock.calls.at(-1)?.[0].apply).toBe(true);
    expect(r.apply).toBe(true);
    expect(log.mock.calls[0][0]).toContain("applied");
  });

  it("uses the retention periods of lib/config.ts: 14 days, 90 days, 12 months", async () => {
    const { store, retention } = fakeStore();
    await runCleanup({ now: NOW, log: () => {} }, store);
    expect(retention).toHaveBeenCalledWith({ apply: false, fullTextDays: 14, rawItemDays: 90, runLogMonths: 12, now: NOW });
    expect(RETENTION).toEqual({ FULL_TEXT_DAYS: 14, RAW_ITEM_DAYS: 90, RUN_LOG_MONTHS: 12 });
  });

  it("returns and logs how many rows each step touched", async () => {
    const { store } = fakeStore();
    const log = vi.fn();
    const r = await runCleanup({ apply: true, log }, store);
    expect(r).toMatchObject({ full_text_cleared: 12, raw_items_deleted: 5, agent_runs_deleted: 40, pipeline_runs_deleted: 3 });
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("full_text cleared on 12 raw items");
    expect(line).toContain("5 raw items with no article deleted");
    expect(line).toContain("40 agent_runs and 3 pipeline_runs deleted");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("tells you which file to run when the function does not exist yet", async () => {
    const { store } = fakeStore(undefined, { retention: async () => Promise.reject(new Error("Could not find the function public.run_retention(p_apply) in the schema cache")) });
    await expect(runCleanup({ log: () => {} }, store)).rejects.toThrow(/2026-10-19_reliability\.sql/);
    const privacyMissing = fakeStore(undefined, { privacy: async () => Promise.reject(new Error("Could not find the function public.run_privacy_retention in the schema cache")) });
    await expect(runCleanup({ log: () => {} }, privacyMissing.store)).rejects.toThrow(/2026-10-20_privacy_and_hardening\.sql/);
  });

  it("passes any other error through unchanged", async () => {
    const { store } = fakeStore(undefined, { retention: async () => Promise.reject(new Error("connection reset")) });
    await expect(runCleanup({ log: () => {} }, store)).rejects.toThrow("connection reset");
    expect(describeCleanupError("connection reset")).toBe("connection reset");
  });

  it("reads the counts the database returns, whatever their shape", () => {
    expect(parseCounts({ full_text_cleared: 3, raw_items_deleted: "4", agent_runs_deleted: null })).toEqual({
      full_text_cleared: 3,
      raw_items_deleted: 4,
      agent_runs_deleted: 0,
      pipeline_runs_deleted: 0,
    });
    expect(parseCounts(null)).toEqual({ full_text_cleared: 0, raw_items_deleted: 0, agent_runs_deleted: 0, pipeline_runs_deleted: 0 });
  });

  it("formatCleanup is one line", () => {
    const line = formatCleanup({
      apply: false,
      full_text_cleared: 1,
      raw_items_deleted: 2,
      agent_runs_deleted: 3,
      pipeline_runs_deleted: 4,
      ip_hash_cleared: 5,
      emails_anonymized: 6,
      photos_removed: 7,
      retention: { fullTextDays: 14, rawItemDays: 90, runLogMonths: 12, ipHashDays: 7, emailDays: 90 },
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("ip_hash cleared on 5 submissions (over 7 days old)");
    expect(line).toContain("6 submitter emails anonymized (decision over 90 days ago), 7 private photos removed");
  });
});

describe("SEC-13: the privacy rules in the cleanup", () => {
  it("a dry run counts and lists, removes no photo and applies nothing", async () => {
    const { store, privacy, removePrivatePhotos } = fakeStore();
    const r = await runCleanup({ now: NOW, log: () => {} }, store);
    expect(privacy).toHaveBeenCalledTimes(1);
    expect(privacy).toHaveBeenCalledWith({ apply: false, ipDays: 7, emailDays: 90, now: NOW });
    expect(removePrivatePhotos).not.toHaveBeenCalled();
    expect(r).toMatchObject({ apply: false, ip_hash_cleared: 7, emails_anonymized: 2, photos_removed: 2 });
  });

  it("apply removes the photo files BEFORE the rows that point at them are changed", async () => {
    const order: string[] = [];
    const { store } = fakeStore(undefined, {
      privacy: async ({ apply }) => {
        order.push(apply ? "privacy-apply" : "privacy-count");
        return PRIVACY;
      },
      removePrivatePhotos: async (paths) => {
        order.push(`remove ${paths.join(",")}`);
        return { removed: paths.length, failed: 0 };
      },
    });
    const r = await runCleanup({ apply: true, now: NOW, log: () => {} }, store);
    expect(order).toEqual(["privacy-count", "remove a.webp,b.webp", "privacy-apply"]);
    expect(r).toMatchObject({ apply: true, photos_removed: 2, emails_anonymized: 2 });
  });

  it("does not anonymize anything when a photo cannot be removed, and says so", async () => {
    const applied = vi.fn();
    const { store } = fakeStore(undefined, {
      privacy: async ({ apply }) => {
        if (apply) applied();
        return PRIVACY;
      },
      removePrivatePhotos: async () => ({ removed: 1, failed: 1 }),
    });
    await expect(runCleanup({ apply: true, log: () => {} }, store)).rejects.toThrow(/could not be removed.*no submitter email was anonymized/);
    expect(applied).not.toHaveBeenCalled();
  });

  it("with nothing to remove it does not call storage at all", async () => {
    const { store, removePrivatePhotos } = fakeStore(undefined, { privacy: async () => ({ ip_hash_cleared: 1, emails_anonymized: 0, photo_paths: [] }) });
    await runCleanup({ apply: true, log: () => {} }, store);
    expect(removePrivatePhotos).not.toHaveBeenCalled();
  });

  it("uses the configured periods (SUBMITTER_IP_RETENTION_DAYS / SUBMITTER_EMAIL_RETENTION_DAYS) when given", async () => {
    const { store, privacy } = fakeStore();
    const r = await runCleanup({ now: NOW, ipHashDays: 3, emailDays: 30, log: () => {} }, store);
    expect(privacy).toHaveBeenCalledWith({ apply: false, ipDays: 3, emailDays: 30, now: NOW });
    expect(r.retention).toMatchObject({ ipHashDays: 3, emailDays: 30 });
    expect(PRIVACY_RETENTION).toEqual({ IP_HASH_DAYS: 7, EMAIL_DAYS: 90 });
  });

  it("reads what the database returns, whatever its shape", () => {
    expect(parsePrivacy({ ip_hash_cleared: "4", emails_anonymized: 1, photo_paths: ["x.webp", 5, "", null] })).toEqual({ ip_hash_cleared: 4, emails_anonymized: 1, photo_paths: ["x.webp"] });
    expect(parsePrivacy(null)).toEqual({ ip_hash_cleared: 0, emails_anonymized: 0, photo_paths: [] });
  });
});

// ---------------------------------------------------------------------------
// npm run stage -- cleanup [--apply]
// ---------------------------------------------------------------------------
describe("the stage script's arguments", () => {
  const STAGES = ["health", "cleanup", "ingest", "classify", "write", "image", "factcheck"];
  const argv = (...a: string[]) => ["node", "run-stage.ts", ...a];

  it("cleanup without --apply is a dry run, with --apply it is real", () => {
    expect(parseStageArgs(argv("cleanup"), STAGES)).toEqual({ ok: true, stage: "cleanup", apply: false });
    expect(parseStageArgs(argv("cleanup", "--apply"), STAGES)).toEqual({ ok: true, stage: "cleanup", apply: true });
  });

  it("the other stages work as before", () => {
    expect(parseStageArgs(argv("write"), STAGES)).toEqual({ ok: true, stage: "write", apply: false });
    expect(parseStageArgs(argv("all"), STAGES)).toEqual({ ok: true, stage: "all", apply: false });
    expect(parseStageArgs(argv("health"), STAGES)).toMatchObject({ ok: true });
  });

  it("refuses --apply for anything but cleanup, other options, and unknown stages", () => {
    expect(parseStageArgs(argv("write", "--apply"), STAGES)).toMatchObject({ ok: false, error: expect.stringContaining("only for cleanup") });
    expect(parseStageArgs(argv("all", "--apply"), STAGES)).toMatchObject({ ok: false });
    expect(parseStageArgs(argv("cleanup", "--force"), STAGES)).toMatchObject({ ok: false, error: expect.stringContaining("--force") });
    expect(parseStageArgs(argv("cleanup", "--apply", "extra"), STAGES)).toMatchObject({ ok: false });
    expect(parseStageArgs(argv("nonsense"), STAGES)).toMatchObject({ ok: false, error: expect.stringContaining("Usage") });
    expect(parseStageArgs(argv(), STAGES)).toMatchObject({ ok: false });
  });

  it("only an applied cleanup calls the route with ?apply=true", () => {
    const base = "http://localhost:3000";
    expect(cronUrl(base, "cleanup", false)).toBe(`${base}/api/cron/cleanup`);
    expect(cronUrl(base, "cleanup", true)).toBe(`${base}/api/cron/cleanup?apply=true`);
    expect(cronUrl(base, "write", true)).toBe(`${base}/api/cron/write`);
  });
});

// ---------------------------------------------------------------------------
// The schedule (GitHub Actions) and the SQL
// ---------------------------------------------------------------------------
const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

describe(".github/workflows/pipeline.yml", () => {
  const workflow = read(".github/workflows/pipeline.yml");

  it("has a weekly cleanup run, which applies", () => {
    const schedule = /^\s+"([^"]+)"\) ROUTE="cleanup\?apply=true" ;;$/m.exec(workflow)?.[1];
    expect(schedule).toBeDefined();
    expect(workflow).toContain(`- cron: "${schedule}"`);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule!.split(" ");
    expect([dayOfMonth, month]).toEqual(["*", "*"]);
    expect(dayOfWeek).toMatch(/^\d$/); // one weekday: once a week
    expect(Number(minute)).toBeGreaterThanOrEqual(0);
    expect(Number(hour)).toBeGreaterThanOrEqual(0);
  });

  it("a run started by hand can choose the dry run or the applied cleanup", () => {
    expect(workflow).toContain('cleanup-dry-run) ROUTE="cleanup" ;;');
    expect(workflow).toContain('cleanup) ROUTE="cleanup?apply=true" ;;');
  });
});

describe("supabase/migrations/2026-10-19_reliability.sql and schema.sql", () => {
  const files = ["supabase/migrations/2026-10-19_reliability.sql", "supabase/schema.sql"].map((p) => ({ p, text: read(p) }));

  it.each(files)("$p: the run lock is a partial unique index on running rows, and finished_at and ok may be null", ({ text }) => {
    expect(text).toMatch(/alter table public\.pipeline_runs alter column finished_at drop not null;/);
    expect(text).toMatch(/alter table public\.pipeline_runs alter column ok\s+drop not null;/);
    expect(text).toMatch(/add column if not exists alert_sent boolean not null default false/);
    expect(text).toMatch(/create unique index if not exists pipeline_runs_one_running_idx on public\.pipeline_runs \(stage\) where finished_at is null;/);
  });

  it.each(files)("$p: budget_overrides is service-role only", ({ text }) => {
    expect(text).toMatch(/create table if not exists public\.budget_overrides/);
    expect(text).toMatch(/alter table public\.budget_overrides enable row level security;/);
    expect(text).not.toMatch(/create policy[^;]*budget_overrides/i);
  });

  it.each(files)("$p: run_retention defaults to a dry run with the 14 / 90 / 12 periods, and only the service role may call it", ({ text }) => {
    expect(text).toMatch(/create or replace function public\.run_retention\(/);
    expect(text).toMatch(/p_apply\s+boolean\s+default false/);
    expect(text).toMatch(/p_full_text_days int\s+default 14/);
    expect(text).toMatch(/p_raw_item_days\s+int\s+default 90/);
    expect(text).toMatch(/p_run_months\s+int\s+default 12/);
    expect(text).toMatch(/revoke all on function public\.run_retention\(boolean, int, int, int, timestamptz\) from public, anon, authenticated;/);
    expect(text).toMatch(/grant execute on function public\.run_retention\(boolean, int, int, int, timestamptz\) to service_role;/);
  });

  it.each(files)("$p: the three retention rules match the spec", ({ text }) => {
    // (a) full_text of written/skipped items older than the period
    expect(text).toMatch(/set full_text = null\s+where full_text is not null and status in \('written', 'skipped'\) and fetched_at < v_text_cut;/);
    // (b) old raw items that have no article
    expect(text).toMatch(/delete from public\.raw_items r\s+where r\.fetched_at < v_raw_cut\s+and not exists \(select 1 from public\.articles a where a\.raw_item_id = r\.id\);/);
    // (c) the two run logs
    expect(text).toMatch(/delete from public\.agent_runs where created_at < v_run_cut;/);
    expect(text).toMatch(/delete from public\.pipeline_runs where started_at < v_run_cut;/);
    // an apply and a dry run read the same rows
    expect(text).toMatch(/select count\(\*\) into v_text from public\.raw_items\s+where full_text is not null and status in \('written', 'skipped'\) and fetched_at < v_text_cut;/);
  });

  it.each(files)("$p: DB-05 makes articles.department_id on delete restrict", ({ text }) => {
    expect(text).toMatch(/foreign key \(department_id\) references public\.departments \(id\) on delete restrict;/);
  });

  it("schema.sql declares articles.department_id with restrict from the start, and pipeline_runs without NOT NULL on the run's outcome", () => {
    const schema = files[1].text;
    expect(schema).toMatch(/department_id\s+uuid references public\.departments\(id\) on delete restrict/);
    expect(schema).not.toMatch(/department_id\s+uuid references public\.departments\(id\) on delete set null,\s*\n\s*status\s+text not null default 'draft'/);
    expect(schema).toMatch(/finished_at\s+timestamptz,\s+-- null while the run is in progress/);
    expect(schema).toMatch(/ok\s+boolean,\s+-- null while the run is in progress/);
  });

  it("the migration ends by reloading the API schema, and is idempotent (no bare create table, index or constraint)", () => {
    const text = files[0].text;
    expect(text.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(text).not.toMatch(/create (unique )?index (?!if not exists)/);
    expect(text).not.toMatch(/create table (?!if not exists)/);
  });

  it("the retention periods in the SQL defaults are the ones the code passes", () => {
    expect([RETENTION.FULL_TEXT_DAYS, RETENTION.RAW_ITEM_DAYS, RETENTION.RUN_LOG_MONTHS]).toEqual([14, 90, 12]);
  });

  it("the old migration that created pipeline_runs is not edited: the new one relaxes it", () => {
    expect(read("supabase/migrations/2026-10-14_world_review_pipeline.sql")).toMatch(/finished_at\s+timestamptz not null/);
  });
});
