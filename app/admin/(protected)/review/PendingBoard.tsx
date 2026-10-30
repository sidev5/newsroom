"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoCredit } from "@/components/PhotoCredit";
import { BlocksView } from "@/components/story/BlocksView";
import { sourceAttribution } from "@/lib/pipeline/freshness";
import { SEEN_MS, SEEN_RATIO, unopenedIds, unopenedWarning } from "@/lib/admin/opened";
import type { ReviewArticle } from "@/lib/admin/review-data";
import { factCheckNotice } from "@/lib/admin/review-view";
import type { SubmitterView } from "@/lib/submissions/types";
import { approveAction, bulkApproveAction, bulkRejectAction, rejectAction, saveAction } from "../actions";
import { EmployeeBlock } from "./EmployeeBlock";
import { SourceLinks } from "./SourceLinks";

type Props = {
  rows: ReviewArticle[];
  /** Chip key currently shown, passed back so an action returns to the same filter. */
  dept: string;
  /** Author details of the employee stories in `rows`, by article id. Admin-only data. */
  submitters: Record<string, SubmitterView>;
  /** Signed links for the images of pending Write stories, by article id and block id. */
  blockImages?: Record<string, Record<string, string>>;
};

type Pending = "approve" | "reject" | null;

const btn = "rounded border px-3 py-1.5 text-sm";

export function PendingBoard({ rows, dept, submitters, blockImages = {} }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Pending>(null);
  // SEC-08: which cards the editor has actually looked at, and whether they accepted publishing the ones they have not.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);
  const markOpened = useCallback((id: string) => setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);

  // Only articles in the current view count, so a chip change can't leave hidden ones selected.
  const ids = rows.map((r) => r.id).filter((id) => selected.has(id));
  const allSelected = rows.length > 0 && ids.length === rows.length;
  const unopened = unopenedIds(ids, opened);
  const warning = confirm === "approve" ? unopenedWarning(ids.length, unopened.length) : null;

  const toggle = (id: string) => {
    setConfirm(null);
    setAcknowledged(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () => {
    setConfirm(null);
    setAcknowledged(false);
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };

  if (rows.length === 0) return <p className="text-zinc-500">Nothing waiting for review in this view.</p>;

  return (
    <div className="flex flex-col gap-6">
      <form className="sticky top-0 z-10 flex flex-col gap-3 rounded border bg-white p-3 shadow-sm">
        <input type="hidden" name="tab" value="pending" />
        <input type="hidden" name="dept" value={dept === "all" ? "" : dept} />
        {ids.map((id) => (
          <input key={id} type="hidden" name="ids" value={id} />
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={selectAll} className={btn}>
            {allSelected ? "Clear selection" : "Select all in view"}
          </button>
          <span className="text-sm text-zinc-600" aria-live="polite">
            {ids.length} of {rows.length} selected
          </span>
          <button type="button" disabled={ids.length === 0} onClick={() => {
              setAcknowledged(false);
              setConfirm("approve");
            }} className={`${btn} ml-auto bg-green-700 text-white disabled:opacity-40`}>
            Approve selected
          </button>
          <button type="button" disabled={ids.length === 0} onClick={() => setConfirm("reject")} className={`${btn} bg-red-700 text-white disabled:opacity-40`}>
            Reject selected
          </button>
        </div>

        {confirm && ids.length > 0 && (
          <div role="alertdialog" aria-label="Confirm bulk action" className="flex flex-col gap-2 rounded bg-zinc-50 p-3">
            <p className="text-sm font-medium">
              {confirm === "approve" ? "Publish" : "Reject"} {ids.length} {ids.length === 1 ? "article" : "articles"}? Approved articles go live as stored, without edits.
            </p>
            {warning && (
              <div role="alert" className="flex flex-col gap-2 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">{warning}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirm(null);
                      document.getElementById(`card-${unopened[0]}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className={btn}
                  >
                    Take me to the first one
                  </button>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="size-4" />I understand and want to publish {unopened.length === 1 ? "it" : "them"} anyway
                  </label>
                </div>
              </div>
            )}
            {confirm === "reject" && (
              <label className="flex flex-col gap-1 text-sm">
                Reason (optional, saved with each rejection)
                <input name="reason" maxLength={500} className="rounded border p-2" />
              </label>
            )}
            <input type="hidden" name="confirm" value="yes" />
            <div className="flex gap-2">
              <button
                formAction={confirm === "approve" ? bulkApproveAction : bulkRejectAction}
                disabled={Boolean(warning) && !acknowledged}
                className={`${btn} text-white disabled:opacity-40 ${confirm === "approve" ? "bg-green-700" : "bg-red-700"}`}
              >
                Confirm {confirm}
              </button>
              <button type="button" onClick={() => setConfirm(null)} className={btn}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </form>

      {rows.map((a) => (
        <Card key={a.id} article={a} dept={dept} submitter={submitters[a.id]} images={blockImages[a.id]} checked={selected.has(a.id)} onToggle={() => toggle(a.id)} onOpened={markOpened} />
      ))}
    </div>
  );
}

function Card({
  article: a,
  dept,
  submitter,
  images,
  checked,
  onToggle,
  onOpened,
}: {
  article: ReviewArticle;
  dept: string;
  submitter: SubmitterView | undefined;
  images?: Record<string, string>;
  checked: boolean;
  onToggle: () => void;
  /** Reports that the editor looked at this card (clicked in it, or kept most of it in view for a moment). */
  onOpened: (id: string) => void;
}) {
  const place = [a.department?.name ?? "No department", a.country_name].filter(Boolean).join(" · ");
  const employee = a.origin === "employee";
  // A photo still in the private bucket is previewed through a short-lived signed URL.
  // A Write story has its images inside the blocks, shown in the preview below, and no separate photo.
  const blocks = a.body_format === "blocks" ? (a.body_blocks ?? null) : null;
  const photo = blocks && employee ? null : employee ? (submitter?.photoUrl ?? a.image_url) : a.image_url;
  const notice = factCheckNotice(a.fact_check_notes);
  const [rejecting, setRejecting] = useState(false);
  const card = useRef<HTMLElement>(null);

  // Opened = interacted with, or at least SEEN_RATIO of the card stayed on screen for SEEN_MS.
  useEffect(() => {
    const el = card.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer);
        if (entry.isIntersecting) timer = setTimeout(() => onOpened(a.id), SEEN_MS);
      },
      { threshold: [SEEN_RATIO] },
    );
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [a.id, onOpened]);

  return (
    <section
      ref={card}
      id={`card-${a.id}`}
      // Ticking the select box is choosing the story, not reading it.
      onClickCapture={(e) => !(e.target as HTMLElement).closest("[data-select]") && onOpened(a.id)}
      onFocusCapture={(e) => !(e.target as HTMLElement).closest("[data-select]") && onOpened(a.id)}
      className={`flex flex-col gap-3 rounded border p-4 ${checked ? "border-green-700" : ""}`}
    >
      <div className="flex items-start gap-3">
        <input type="checkbox" data-select checked={checked} onChange={onToggle} aria-label={`Select: ${a.headline}`} className="mt-1 size-5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase text-zinc-500">{place}</p>
          <h2 className="text-lg font-semibold">{a.headline}</h2>
        </div>
      </div>

      {employee ? (
        // Employee stories skip classify, write, image and fact-check: nothing but the editor has looked at them.
        <EmployeeBlock article={a} submitter={submitter} />
      ) : (
        <div className="flex flex-col gap-1.5">
          {blocks && (
            <p className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-white">AI-written</span>
              <span className="text-sm text-zinc-600">A blog made of blocks from one source. Read the code blocks and the pictures as well as the text: the fact-check below covers the text only.</span>
            </p>
          )}
          <p className="text-sm">
            {sourceAttribution(a.source_published_at)}
            <SourceLinks urls={a.source_urls} />
          </p>
        </div>
      )}

      {employee ? null : notice.kind !== "passed" ? (
        // A pass leaves only minor wording warnings; any other notes were kept from before a restore.
        <div className="rounded bg-amber-50 p-2 text-sm text-amber-900">
          <p className="font-medium">
            {notice.kind === "minor" ? "Fact-check: passed with minor wording warnings (check them before approving)" : "Fact-check: flagged claims (kept from before the restore)"}
          </p>
          <ul className="ml-5 list-disc">
            {notice.items.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded bg-green-50 p-2 text-sm text-green-900">
          <p className="font-medium">Fact-check: passed</p>
          <p>No claims flagged. The check compares the draft with the source text only.</p>
        </div>
      )}
      {a.review_note && <p className="rounded bg-amber-50 p-2 text-sm font-medium text-amber-900">{a.review_note}</p>}
      {photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt={a.image_alt ?? ""} className="aspect-video w-full max-w-xl rounded object-cover" />
      )}
      {blocks && employee ? null : employee ? (
        a.image_credit && <p className="text-xs text-zinc-500">Photo credit or caption from the author: {a.image_credit}</p>
      ) : (
        <PhotoCredit credit={a.image_credit} creditUrl={a.image_credit_url} />
      )}
      {!blocks && employee && submitter && !submitter.photoUrl && a.image_url?.startsWith("/") && (
        <p className="text-xs text-zinc-500">No photo was sent: the {a.department?.name ?? "department"} default image will be used.</p>
      )}

      {/* One form: the buttons pick the action. Approve publishes the text exactly as shown here. */}
      <form className="flex flex-col gap-3">
        <input type="hidden" name="id" value={a.id} />
        <input type="hidden" name="tab" value="pending" />
        <input type="hidden" name="dept" value={dept === "all" ? "" : dept} />
        <label className="flex flex-col gap-1 text-sm">
          Headline
          <input name="headline" defaultValue={a.headline} required maxLength={200} className="rounded border p-2 text-lg font-semibold" />
        </label>
        {blocks ? (
          // A Write story: the editor reads it exactly as readers will see it. It cannot be edited here (only the headline), so the
          // text is sent back unchanged and the server leaves the blocks alone. Reject it, with a reason, if it needs changes.
          <div className="flex flex-col gap-2 text-sm">
            <input type="hidden" name="body" value={a.body} />
            <p className="font-medium">Story, as readers will see it (read-only)</p>
            <div className="max-h-[70vh] overflow-y-auto rounded border bg-white p-4">
              <BlocksView doc={blocks} headingOffset={1} images={images} />
            </div>
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Body
            <textarea name="body" defaultValue={a.body} required rows={10} className="rounded border p-2" />
          </label>
        )}
        {employee ? (
          // Rejecting an employee's story needs a reason, which is also checked on the server.
          rejecting && (
            <label className="flex flex-col gap-1 text-sm">
              Reason for rejecting (required; kept in the audit log and shown in the Rejected tab)
              <input name="reason" required minLength={3} maxLength={500} className="rounded border p-2" autoFocus />
            </label>
          )
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Reason (optional, used if you reject)
            <input name="reason" maxLength={500} className="rounded border p-2" />
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <button formAction={saveAction} formNoValidate className={btn}>Save edits</button>
          <button formAction={approveAction} formNoValidate className={`${btn} bg-green-700 text-white`}>Approve and publish</button>
          {employee && !rejecting ? (
            <button type="button" onClick={() => setRejecting(true)} className={`${btn} bg-red-700 text-white`}>Reject…</button>
          ) : (
            <button formAction={rejectAction} className={`${btn} bg-red-700 text-white`}>{employee ? "Confirm reject" : "Reject"}</button>
          )}
          {employee && rejecting && (
            <button type="button" onClick={() => setRejecting(false)} className={btn}>Cancel</button>
          )}
        </div>
      </form>
      <p className="text-xs text-zinc-500">{employee ? "Edit the title or text above before approving if it needs fixing. Edits are not checked by AI." : "Edits are not fact-checked again."}</p>
    </section>
  );
}
