import Link from "next/link";
import { notFound } from "next/navigation";
import { getBudgetStatus } from "@/lib/admin/budget-admin";
import { getPipelineOverview } from "@/lib/admin/pipeline";
import {
  countByStatus,
  latestLogs,
  loadArticles,
  loadDepartmentOptions,
  loadDepartments,
  loadSkipped,
  type ReviewArticle,
} from "@/lib/admin/review-data";
import {
  ARTICLE_STATUSES,
  filterByChip,
  formatUtc,
  funnel,
  parseChip,
  parseTab,
  pendingChips,
  RAW_STATUSES,
  rejectionInfo,
  summarizeRun,
  type ReviewTab,
} from "@/lib/admin/review-view";
import { articleParam, bannerFromSearch } from "@/lib/admin/messages";
import { formatUsd } from "@/lib/llm/budget";
import { currentAdminEmail } from "@/lib/admin/session";
import { DEFAULT_BATCH_LIMIT, PIPELINE_DEFAULTS } from "@/lib/config";
import { env } from "@/lib/env";
import { sourceAttribution } from "@/lib/pipeline/freshness";
import { STAGE_ORDER } from "@/lib/pipeline/stages";
import { blockImageUrls, loadSubmitters } from "@/lib/submissions/admin";
import { loadCommentsFor } from "@/lib/stories/moderation-store";
import type { SubmitterView } from "@/lib/submissions/types";
import { unpublishAction } from "../actions";
import { CommentsAdmin } from "./CommentsAdmin";
import { authorLine, EmployeeBadge } from "./EmployeeBlock";
import { PendingBoard } from "./PendingBoard";
import { SourceLinks } from "./SourceLinks";
import { RejectedBoard, SkippedBoard } from "./RecoverBoards";
import { RunBatch } from "./RunBatch";

export const dynamic = "force-dynamic";
// maxDuration = 300 is deliberate (DEP-01). The "Run next batch" button calls a server action (runStageAction) on this page, once
// per stage, and a server action runs under the page's own limit, not under a cron route's 60 s. One call handles a chunk of
// STAGE_CHUNK_SIZE items (5) one after the other, and one LLM call may take up to LLM_TIMEOUT_MS (45 s): 5 x 45 s = 225 s in the
// worst case, which does not fit in 60 s. 300 s is the highest value every Vercel plan allows with fluid compute (Hobby: default
// 300 s, maximum 300 s; Pro: default 300 s, maximum 800 s; Vercel docs, "Configuring Maximum Duration", checked 2026-10).
// lib/deploy.test.ts keeps the three numbers consistent. The cron routes stay at 60 s: they stop themselves at STAGE_TIME_BUDGET_MS.
export const maxDuration = 300;

const TAB_LABELS: Record<ReviewTab, string> = { pending: "Pending", published: "Published", rejected: "Rejected", skipped: "Skipped", pipeline: "Pipeline" };

function SourceLine({ a }: { a: ReviewArticle }) {
  return (
    <p className="text-sm">
      {sourceAttribution(a.source_published_at)}
      <SourceLinks urls={a.source_urls} />
    </p>
  );
}

export default async function ReviewPage({ searchParams }: PageProps<"/admin/review">) {
  // Layouts don't protect pages on their own: check again before using the service role.
  if (!(await currentAdminEmail())) notFound();

  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const banner = bannerFromSearch(sp);
  const highlight = articleParam(sp.article);

  let counts = { pending_review: 0, published: 0, rejected: 0, skipped: 0 };
  let loadError: string | null = null;
  try {
    counts = await countByStatus();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const tabLink = (t: ReviewTab, n?: number) => (
    <Link
      key={t}
      href={`/admin/review?tab=${t}`}
      aria-current={t === tab ? "page" : undefined}
      className={`rounded-t border-b-2 px-3 py-2 text-sm font-medium ${t === tab ? "border-zinc-900" : "border-transparent text-zinc-500"}`}
    >
      {TAB_LABELS[t]}
      {n !== undefined && <span className="ml-1.5 rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs">{n}</span>}
    </Link>
  );

  return (
    <main className="flex flex-col gap-6">
      <nav aria-label="Review sections" className="flex gap-1 border-b">
        {tabLink("pending", counts.pending_review)}
        {tabLink("published", counts.published)}
        {tabLink("rejected", counts.rejected)}
        {tabLink("skipped", counts.skipped)}
        {tabLink("pipeline")}
      </nav>

      {banner?.kind === "ok" && <p className="rounded bg-green-100 p-2 text-green-900">{banner.text}</p>}
      {banner?.kind === "problem" && <p role="alert" className="rounded bg-red-100 p-2 text-red-900">{banner.text}</p>}
      {loadError && <p role="alert" className="text-red-600">Loading failed: {loadError}</p>}

      {tab === "pending" && <PendingTab dept={sp.dept} />}
      {tab === "published" && <PublishedTab highlight={highlight} />}
      {tab === "rejected" && <RejectedTab />}
      {tab === "skipped" && <SkippedTab showFailed={sp.failed === "1"} />}
      {tab === "pipeline" && <PipelineTab />}
    </main>
  );
}

async function PendingTab({ dept }: { dept: string | string[] | undefined }) {
  const [rows, departments] = await Promise.all([loadArticles("pending_review"), loadDepartments()]);
  const chips = pendingChips(rows, departments);
  const active = parseChip(dept, chips);
  const visible = filterByChip(rows, active);
  const submitters = await submittersOf(visible);
  // Signed links so the editor sees the images of Write stories as readers will (they are still in the private bucket).
  const blockImages: Record<string, Record<string, string>> = {};
  await Promise.all(visible.map(async (a) => {
    if (a.body_format === "blocks" && a.body_blocks) blockImages[a.id] = await blockImageUrls(a.body_blocks).catch(() => ({}));
  }));

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter pending by department">
        {chips.map((c) => (
          <Link
            key={c.key}
            href={`/admin/review?tab=pending&dept=${c.key}`}
            aria-current={c.key === active ? "true" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${c.key === active ? "border-zinc-900 bg-zinc-900 text-white" : ""}`}
          >
            {c.label} <span className="opacity-70">{c.count}</span>
          </Link>
        ))}
      </div>
      <PendingBoard rows={visible} dept={active} submitters={submitters} blockImages={blockImages} />
    </>
  );
}

/** Email, flags and photo link of the employee stories among `rows`. Admin-only: the page checked the admin before calling this. */
async function submittersOf(rows: ReviewArticle[]): Promise<Record<string, SubmitterView>> {
  const ids = rows.filter((r) => r.origin === "employee").map((r) => r.id);
  try {
    return Object.fromEntries(await loadSubmitters(ids));
  } catch (err) {
    console.error(`Loading submitters failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

async function PublishedTab({ highlight }: { highlight: string | null }) {
  const rows = await loadArticles("published");
  const logs = await latestLogs(rows.map((r) => r.id));
  const comments = await loadCommentsFor(rows.filter((r) => r.body_format === "blocks").map((r) => r.id));
  if (rows.length === 0) return <p className="text-zinc-500">Nothing is published yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      {rows.map((a) => {
        const log = logs.get(a.id);
        return (
          <section key={a.id} className={`flex flex-col gap-2 rounded border p-4 ${highlight === a.id ? "border-red-500" : ""}`}>
            <p className="text-xs uppercase text-zinc-500">{[a.department?.name, a.country_name].filter(Boolean).join(" · ")}</p>
            {a.origin === "employee" && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <EmployeeBadge />
                <span>{authorLine(a)}</span>
              </p>
            )}
            <h2 className="text-lg font-semibold">{a.headline}</h2>
            {a.origin !== "employee" && <SourceLine a={a} />}
            <p className="text-sm text-zinc-600">
              Published {formatUtc(a.published_at)}
              {log?.action === "approve" && ` · approved by ${log.actor_email}`}
            </p>
            {a.body_format === "blocks" && <CommentsAdmin comments={comments.get(a.id) ?? []} />}
            <form>
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="tab" value="published" />
              <button formAction={unpublishAction} className="rounded border px-3 py-1.5 text-sm">
                Unpublish
              </button>
            </form>
          </section>
        );
      })}
    </div>
  );
}

async function RejectedTab() {
  const rows = await loadArticles("rejected");
  const logs = await latestLogs(rows.map((r) => r.id));
  const submitters = await submittersOf(rows);
  return (
    <RejectedBoard
      rows={rows.map((a) => ({ article: a, why: rejectionInfo(a.fact_check_notes, logs.get(a.id) ?? null), submitter: submitters[a.id] }))}
    />
  );
}

async function SkippedTab({ showFailed }: { showFailed: boolean }) {
  const [items, departments] = await Promise.all([loadSkipped(showFailed), loadDepartmentOptions()]);
  return <SkippedBoard items={items} departments={departments} showFailed={showFailed} />;
}
function Funnel({ title, order, counts }: { title: string; order: readonly string[]; counts: Record<string, number> }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {funnel(order, counts).map((r) => (
          <li key={r.status} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3 text-sm">
            <span>{r.status}</span>
            <span className="h-4 rounded bg-zinc-100">
              <span className="block h-4 rounded bg-zinc-700" style={{ width: `${Math.max(r.count > 0 ? 2 : 0, r.share * 100)}%` }} />
            </span>
            <span className="text-right tabular-nums">{r.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function PipelineTab() {
  const [o, budget] = await Promise.all([getPipelineOverview(), getBudgetStatus()]);
  let batchLimit: number = DEFAULT_BATCH_LIMIT;
  let chunk: number = PIPELINE_DEFAULTS.STAGE_CHUNK_SIZE;
  try {
    batchLimit = env().BATCH_LIMIT;
    chunk = env().STAGE_CHUNK_SIZE;
  } catch {
    // Env problems show up elsewhere; the default is still the right thing to display.
  }

  return (
    <div className="flex flex-col gap-8">
      {o.warnings.map((w) => (
        <p key={w} role="alert" className="rounded bg-yellow-100 p-2 text-sm text-yellow-900">{w}</p>
      ))}

      {budget && (
        <p className="text-sm text-zinc-600">
          AI spend today ({budget.day}, Asia/Kolkata): <strong>{formatUsd(budget.spentUsd)}</strong> of {formatUsd(budget.limitUsd)}
          {budget.raisedBy ? ` (limit raised by ${budget.raisedBy})` : ""}. At the limit the stages stop and their items stay queued; the limit is DAILY_BUDGET_USD.
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Run next batch</h2>
        <p className="text-sm text-zinc-600">
          Runs ingest, classify, write, image and fact-check in that order, on the server, one chunk of {chunk} items per stage. Cron and
          <code> npm run stage -- all</code> work through up to {batchLimit} items per stage per run (BATCH_LIMIT; default {DEFAULT_BATCH_LIMIT} in lib/config.ts).
        </p>
        <RunBatch chunkSize={chunk} />
      </section>
      <div className="grid gap-8 sm:grid-cols-2">
        <Funnel title="Raw items" order={RAW_STATUSES} counts={o.raw} />
        <Funnel title="Articles" order={ARTICLE_STATUSES} counts={o.articles} />
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">Last run per stage</h3>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-1">Stage</th>
              <th>Last run</th>
              <th>Result</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {STAGE_ORDER.map((stage) => {
              const run = o.lastRuns[stage];
              const live = o.running[stage];
              return (
                <tr key={stage} className="border-t align-top">
                  <td className="py-1.5">
                    {stage}
                    {live && <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-900">running since {formatUtc(live.started_at)} ({live.triggered_by})</span>}
                  </td>
                  <td>{run ? formatUtc(run.finished_at) : "never"}</td>
                  <td className="max-w-md break-words">
                    {run ? (run.ok ? <span className="text-xs">{summarizeRun(run.summary)}</span> : <span className="text-red-700">failed: {run.error}</span>) : "—"}
                  </td>
                  <td>{run?.triggered_by ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">Why items were dropped (latest 25 skipped or failed)</h3>
        {o.dropped.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing skipped or failed.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {o.dropped.map((d) => (
              <li key={d.id} className="rounded border p-2">
                <p className="font-medium">{d.title}</p>
                <p className="text-zinc-600">
                  {d.status}
                  {d.source ? ` · ${d.source}` : ""} · {formatUtc(d.fetched_at)}
                </p>
                <p>{d.reason ?? "No reason recorded."}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-zinc-500">Articles rejected by the fact-check are on the Rejected tab, with the flagged claims.</p>
      </section>
    </div>
  );
}
