"use client";

import { useState, type ReactNode } from "react";
import { PhotoCredit } from "@/components/PhotoCredit";
import type { ReviewArticle, SkippedItem } from "@/lib/admin/review-data";
import { formatUtc, type RejectionInfo } from "@/lib/admin/review-view";
import { sourceAttribution } from "@/lib/pipeline/freshness";
import type { SubmitterView } from "@/lib/submissions/types";
import { bulkMarkRelevantAction, bulkRestoreAction, markRelevantAction, restoreAction } from "../actions";
import { EmployeeBlock } from "./EmployeeBlock";
import { ItemLink, SourceLinks } from "./SourceLinks";

const btn = "rounded border px-3 py-1.5 text-sm";

function useSelection(allIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  // Only rows in the current view count, so a filter change cannot leave hidden ones selected.
  const ids = allIds.filter((id) => selected.has(id));
  const allSelected = allIds.length > 0 && ids.length === allIds.length;
  return {
    ids,
    allSelected,
    confirm,
    setConfirm,
    toggle(id: string) {
      setConfirm(false);
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    selectAll() {
      setConfirm(false);
      setSelected(allSelected ? new Set() : new Set(allIds));
    },
  };
}

function BulkBar({
  sel,
  total,
  tab,
  action,
  verb,
  children,
  confirmText,
}: {
  sel: ReturnType<typeof useSelection>;
  total: number;
  tab: string;
  action: (form: FormData) => Promise<void>;
  verb: string;
  /** Extra controls (e.g. the department picker). */
  children?: ReactNode;
  confirmText: string;
}) {
  return (
    <form className="sticky top-0 z-10 flex flex-col gap-3 rounded border bg-white p-3 shadow-sm">
      <input type="hidden" name="tab" value={tab} />
      {sel.ids.map((id) => (
        <input key={id} type="hidden" name="ids" value={id} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={sel.selectAll} className={btn}>
          {sel.allSelected ? "Clear selection" : "Select all in view"}
        </button>
        <span className="text-sm text-zinc-600" aria-live="polite">
          {sel.ids.length} of {total} selected
        </span>
        {children}
        <button type="button" disabled={sel.ids.length === 0} onClick={() => sel.setConfirm(true)} className={`${btn} ml-auto bg-zinc-900 text-white disabled:opacity-40`}>
          {verb} selected
        </button>
      </div>
      {sel.confirm && sel.ids.length > 0 && (
        <div role="alertdialog" aria-label={`Confirm ${verb.toLowerCase()}`} className="flex flex-col gap-2 rounded bg-zinc-50 p-3">
          <p className="text-sm font-medium">
            {verb} {sel.ids.length} {sel.ids.length === 1 ? "item" : "items"}? {confirmText}
          </p>
          <input type="hidden" name="confirm" value="yes" />
          <div className="flex gap-2">
            <button formAction={action} className={`${btn} bg-zinc-900 text-white`}>
              Confirm {verb.toLowerCase()}
            </button>
            <button type="button" onClick={() => sel.setConfirm(false)} className={btn}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rejected
// ---------------------------------------------------------------------------

export type RejectedRow = { article: ReviewArticle; why: RejectionInfo; /** Author details of an employee story (admin only). */ submitter?: SubmitterView };

function Why({ why }: { why: RejectionInfo }) {
  return (
    <div className="rounded bg-red-50 p-2 text-sm text-red-900">
      {why.source === "fact-check" && (
        <>
          <p className="font-medium">Rejected by: the fact-checker. Flagged claims:</p>
          <ul className="ml-5 list-disc">
            {why.claims.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {why.source === "editor" && (
        <>
          <p>
            <span className="font-medium">Rejected by: editor {why.by}</span> on {formatUtc(why.at)}
            {why.reason ? `. Reason: ${why.reason}` : ". No reason given."}
          </p>
          {why.claims && why.claims.length > 0 && (
            <>
              <p className="mt-1 font-medium">The fact-checker had flagged:</p>
              <ul className="ml-5 list-disc">
                {why.claims.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {why.source === "unknown" && <p>No reason was recorded.</p>}
    </div>
  );
}

export function RejectedBoard({ rows }: { rows: RejectedRow[] }) {
  const sel = useSelection(rows.map((r) => r.article.id));
  if (rows.length === 0) return <p className="text-zinc-500">Nothing has been rejected.</p>;
  return (
    <div className="flex flex-col gap-4">
      <BulkBar
        sel={sel}
        total={rows.length}
        tab="rejected"
        action={bulkRestoreAction}
        verb="Restore"
        confirmText="They go back to Pending with their fact-check report and a note. Nothing is published."
      />
      {rows.map(({ article: a, why, submitter }) => (
        <section key={a.id} className={`flex flex-col gap-2 rounded border p-4 ${sel.ids.includes(a.id) ? "border-zinc-900" : ""}`}>
          <div className="flex items-start gap-3">
            <input type="checkbox" checked={sel.ids.includes(a.id)} onChange={() => sel.toggle(a.id)} aria-label={`Select: ${a.headline}`} className="mt-1 size-5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase text-zinc-500">{[a.department?.name, a.country_name].filter(Boolean).join(" · ")}</p>
              <h2 className="text-lg font-semibold">{a.headline}</h2>
            </div>
          </div>
          {a.origin === "employee" ? (
            <EmployeeBlock article={a} submitter={submitter} showNote={false} />
          ) : (
            <p className="text-sm">
              {sourceAttribution(a.source_published_at)}
              <SourceLinks urls={a.source_urls} />
            </p>
          )}
          <Why why={why} />
          {a.review_note && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">{a.review_note}</p>}
          {(a.origin === "employee" ? (submitter?.photoUrl ?? a.image_url) : a.image_url) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={(a.origin === "employee" ? (submitter?.photoUrl ?? a.image_url) : a.image_url) ?? ""}
              alt={a.image_alt ?? ""}
              className="aspect-video w-full max-w-sm rounded object-cover"
            />
          )}
          {a.origin !== "employee" && <PhotoCredit credit={a.image_credit} creditUrl={a.image_credit_url} />}
          <form>
            <input type="hidden" name="id" value={a.id} />
            <input type="hidden" name="tab" value="rejected" />
            <button formAction={restoreAction} className={btn}>
              Restore to review
            </button>
          </form>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skipped
// ---------------------------------------------------------------------------

type Dept = { id: string; name: string; slug: string };

export function SkippedBoard({ items, departments, showFailed }: { items: SkippedItem[]; departments: Dept[]; showFailed: boolean }) {
  const sel = useSelection(items.map((i) => i.id));
  const [bulkDept, setBulkDept] = useState("");
  const options = departments.map((d) => (
    <option key={d.id} value={d.id}>
      {d.name}
    </option>
  ));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-zinc-600">
        Items the classifier dropped. Marking one relevant sets it to <code>new-relevant</code>, and the normal write, image and fact-check stages pick it up.{" "}
        <a href={`/admin/review?tab=skipped${showFailed ? "" : "&failed=1"}`} className="underline">
          {showFailed ? "Hide failed items" : "Also show failed items"}
        </a>
      </p>
      {items.length === 0 ? (
        <p className="text-zinc-500">Nothing skipped{showFailed ? " or failed" : ""}.</p>
      ) : (
        <>
          <BulkBar
            sel={sel}
            total={items.length}
            tab="skipped"
            action={bulkMarkRelevantAction}
            verb="Mark relevant"
            confirmText={bulkDept ? "They all go to the department picked here." : "Each keeps the classifier's department guess."}
          >
            <label className="flex items-center gap-2 text-sm">
              Department
              <select name="department_id" value={bulkDept} onChange={(e) => setBulkDept(e.target.value)} className="rounded border p-1.5">
                <option value="">Each item&apos;s own guess</option>
                {options}
              </select>
            </label>
          </BulkBar>

          {items.map((it) => (
            <section key={it.id} className={`flex flex-col gap-2 rounded border p-4 ${sel.ids.includes(it.id) ? "border-zinc-900" : ""}`}>
              <div className="flex items-start gap-3">
                <input type="checkbox" checked={sel.ids.includes(it.id)} onChange={() => sel.toggle(it.id)} aria-label={`Select: ${it.title}`} className="mt-1 size-5" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase text-zinc-500">
                    {it.status} · {it.source ?? "unknown source"} · fetched {formatUtc(it.fetched_at)}
                  </p>
                  <h2 className="text-lg font-semibold">
                    <ItemLink url={it.url}>{it.title}</ItemLink>
                  </h2>
                </div>
              </div>
              <p className="text-sm">
                <span className="font-medium">Department guess:</span> {it.department?.name ?? "none"}
              </p>
              <p className="rounded bg-zinc-50 p-2 text-sm">
                <span className="font-medium">Classifier&apos;s reason:</span> {it.classify_reason ?? "No reason recorded."}
              </p>
              {it.classify_reason === "source_too_short" && (
                <p className="text-xs text-amber-800">The write stage skipped this for a short source text; it will be skipped again unless the source has more text.</p>
              )}
              <form className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={it.id} />
                <input type="hidden" name="tab" value="skipped" />
                <label className="flex items-center gap-2 text-sm">
                  Department
                  <select name="department_id" defaultValue={it.department?.id ?? ""} required className="rounded border p-1.5">
                    {!it.department && <option value="">Pick one</option>}
                    {options}
                  </select>
                </label>
                <button formAction={markRelevantAction} className={btn}>
                  Mark relevant
                </button>
              </form>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
