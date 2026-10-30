"use client";

import { useMemo, useRef, useState } from "react";
import { renderDigest } from "@/lib/digest/render";
import type { DigestArticle, DigestRow } from "@/lib/digest/types";
import { formatLongDate } from "@/lib/digest/week";
import { approveAction, markFailedAction, retryAction, saveDigestAction, sendNowAction, sendTestAction, unapproveAction } from "./actions";

type Props = {
  digest: DigestRow;
  /** Every story the admin can pick from: the digest's own plus this week's other candidates. */
  articles: DigestArticle[];
  siteUrl: string;
  siteUrlIsPlaceholder: boolean;
  contact: string | null;
  recipientCount: number;
  hasDistributionList: boolean;
  providerName: "smtp" | "graph" | "none";
  /** Minutes in "sending" when that is over 15 (the digest is stuck), else null. */
  stuckMinutes: number | null;
  /** Minutes in "sending" at all, for a digest that is sending but not stuck yet. */
  sendingMinutes: number | null;
  /** The last failed send attempt of an approved digest, from the log. */
  lastFailure: { at: string; error: string } | null;
};

const btn = "rounded border px-3 py-1.5 text-sm disabled:opacity-40";
const STATUS_STYLE: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-800",
  approved: "bg-green-100 text-green-900",
  sending: "bg-yellow-100 text-yellow-900",
  sent: "bg-blue-100 text-blue-900",
  failed: "bg-red-100 text-red-900",
  skipped: "bg-zinc-100 text-zinc-600",
};

export function DigestEditor({ digest, articles, siteUrl, siteUrlIsPlaceholder, contact, recipientCount, hasDistributionList, providerName, stuckMinutes, sendingMinutes, lastFailure }: Props) {
  const [subject, setSubject] = useState(digest.subject);
  const [intro, setIntro] = useState(digest.intro);
  const [ids, setIds] = useState<string[]>(digest.article_ids);
  const dialog = useRef<HTMLDialogElement>(null);
  const retryDialog = useRef<HTMLDialogElement>(null);
  const failDialog = useRef<HTMLDialogElement>(null);

  const byId = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);
  const chosen = ids.map((id) => byId.get(id)).filter((a): a is DigestArticle => Boolean(a));
  const pool = articles.filter((a) => !ids.includes(a.id));

  const dirty = subject !== digest.subject || intro !== digest.intro || ids.join() !== digest.article_ids.join();
  const editable = ["draft", "approved", "failed"].includes(digest.status);

  // The preview is the real render function, run in the browser on what is on screen.
  const preview = useMemo(
    () => renderDigest({ subject, intro, weekStart: digest.week_start, siteUrl, articles: chosen, contact }),
    [subject, intro, digest.week_start, siteUrl, chosen, contact],
  );

  const move = (i: number, to: number) =>
    setIds((cur) => {
      if (to < 0 || to >= cur.length) return cur;
      const next = [...cur];
      const [item] = next.splice(i, 1);
      next.splice(to, 0, item);
      return next;
    });

  const week = formatLongDate(digest.week_start);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,640px)]">
      <form className="flex min-w-0 flex-col gap-5">
        <input type="hidden" name="id" value={digest.id} />
        {ids.map((id) => (
          <input key={id} type="hidden" name="ids" value={id} />
        ))}

        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_STYLE[digest.status] ?? ""}`}>{digest.status}</span>
          <span className="text-sm text-zinc-600">Week of {week}</span>
          {digest.approved_by && digest.status === "approved" && (
            <span className="text-sm text-zinc-600">approved by {digest.approved_by}</span>
          )}
          {digest.sent_at && <span className="text-sm text-zinc-600">sent {digest.sent_at.slice(0, 16).replace("T", " ")} UTC</span>}
        </div>
        {digest.error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-900">{digest.error}</p>}
        {digest.status === "approved" && lastFailure && (
          <p role="alert" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
            The last attempt to send this digest failed{lastFailure.error ? `: ${lastFailure.error}` : "."} It is approved and waiting: fix the cause, then use Send now to try again.
          </p>
        )}
        {digest.status === "sending" && stuckMinutes !== null && (
          <div role="alert" className="flex flex-col gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            <p className="font-medium">Stuck in sending for more than 15 minutes ({stuckMinutes} minutes).</p>
            <p>
              The send most likely stopped before it could record the result. Some messages may already have gone out: check the mailbox first. Marking it as failed unlocks the digest so you can
              edit it or retry; it does not send anything.
            </p>
            <div>
              <button type="button" onClick={() => failDialog.current?.showModal()} className={`${btn} border-red-700 bg-red-700 text-white`}>Mark as failed</button>
            </div>
          </div>
        )}
        {digest.status === "sending" && stuckMinutes === null && (
          <p className="rounded bg-yellow-50 p-2 text-sm text-yellow-900">
            Sending{sendingMinutes !== null ? ` for ${sendingMinutes} ${sendingMinutes === 1 ? "minute" : "minutes"}` : ""}. If it is still here after 15 minutes it will be shown as stuck, with a button to mark it as failed.
          </p>
        )}
        {siteUrlIsPlaceholder && (
          <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">SITE_URL is not set, so links in the preview use a placeholder address. Set it before sending.</p>
        )}
        {digest.status === "approved" && <p className="text-sm text-zinc-600">Any change to an approved digest makes it a draft again; you will need to approve it again.</p>}

        <label className="flex flex-col gap-1 text-sm">
          Subject <span className="text-xs text-zinc-500">{subject.length}/90</span>
          <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={90} disabled={!editable} className="rounded border p-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Intro
          <textarea name="intro" value={intro} onChange={(e) => setIntro(e.target.value)} rows={3} maxLength={600} disabled={!editable} className="rounded border p-2" />
        </label>

        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Stories in this digest ({chosen.length})</h2>
          <ol className="flex flex-col gap-2">
            {chosen.map((a, i) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
                <span className="w-14 shrink-0 text-xs font-medium uppercase text-zinc-500">{i === 0 ? "Lead" : `#${i + 1}`}</span>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{a.headline}</span>
                  <span className="block text-xs text-zinc-500">
                    {a.department?.name ?? "General"}
                    {a.origin === "employee" ? " · Employee contribution" : ""} · {a.image_url ? "photo" : "no photo"}
                  </span>
                </span>
                {editable && (
                  <span className="flex gap-1">
                    <button type="button" onClick={() => move(i, 0)} disabled={i === 0} className={btn} aria-label={`Make "${a.headline}" the lead`}>Make lead</button>
                    <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className={btn} aria-label="Move up">↑</button>
                    <button type="button" onClick={() => move(i, i + 1)} disabled={i === chosen.length - 1} className={btn} aria-label="Move down">↓</button>
                    <button type="button" onClick={() => setIds((cur) => cur.filter((x) => x !== a.id))} disabled={chosen.length <= 1} className={btn}>Exclude</button>
                  </span>
                )}
              </li>
            ))}
          </ol>

          {editable && pool.length > 0 && (
            <>
              <h3 className="mt-2 text-sm font-semibold">Other stories from the last 7 days</h3>
              <ul className="flex flex-col gap-2">
                {pool.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded border border-dashed p-2">
                    <span className="min-w-0 flex-1 text-sm">
                      {a.headline}
                      <span className="block text-xs text-zinc-500">
                        {a.department?.name ?? "General"}
                        {a.origin === "employee" ? " · Employee contribution" : ""}
                      </span>
                    </span>
                    <button type="button" onClick={() => setIds((cur) => [...cur, a.id])} className={btn}>Include</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {dirty && <p className="text-sm text-amber-800">You have unsaved changes. Save before sending a test, downloading, or approving.</p>}

        <div className="flex flex-wrap items-center gap-2">
          <button formAction={saveDigestAction} disabled={!editable || !dirty} className={`${btn} bg-zinc-900 text-white`}>Save changes</button>
          <button formAction={sendTestAction} disabled={dirty} className={btn}>Send test to me</button>
          <a
            href={`/admin/digest/eml?id=${digest.id}`}
            aria-disabled={dirty}
            onClick={(e) => dirty && e.preventDefault()}
            className={`${btn} inline-block ${dirty ? "pointer-events-none opacity-40" : ""}`}
          >
            Download .eml
          </a>
          {digest.status === "draft" || digest.status === "failed" ? (
            <button formAction={approveAction} disabled={dirty || digest.status !== "draft"} className={`${btn} bg-green-700 text-white`}>Approve</button>
          ) : null}
          {digest.status === "failed" && (
            <button type="button" onClick={() => retryDialog.current?.showModal()} disabled={dirty || providerName === "none"} className={`${btn} bg-red-700 text-white`}>Retry</button>
          )}
          {digest.status === "approved" && (
            <>
              <button formAction={unapproveAction} disabled={dirty} className={btn}>Unapprove</button>
              <button type="button" onClick={() => dialog.current?.showModal()} disabled={dirty} className={`${btn} bg-red-700 text-white`}>Send now</button>
            </>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {recipientCount} {recipientCount === 1 ? "recipient" : "recipients"}
          {hasDistributionList ? " (including the distribution list)" : ""} · sending by {providerName === "none" ? "nothing: EMAIL_PROVIDER is none, so use Download .eml" : providerName}
        </p>
      </form>

      <dialog ref={dialog} className="m-auto w-[min(28rem,92vw)] rounded-lg border p-5 shadow-lg backdrop:bg-black/40" aria-labelledby="send-title">
        <form className="flex flex-col gap-4">
          <h2 id="send-title" className="text-lg font-semibold">Send this digest now?</h2>
          <p className="text-sm">
            It will be emailed to <strong>{recipientCount}</strong> {recipientCount === 1 ? "recipient" : "recipients"}. It can only be sent once.
          </p>
          <input type="hidden" name="id" value={digest.id} />
          <input type="hidden" name="confirm" value="yes" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className={btn}>Cancel</button>
            <button formAction={sendNowAction} className={`${btn} bg-red-700 text-white`}>Send to {recipientCount}</button>
          </div>
        </form>
      </dialog>

      <dialog ref={retryDialog} className="m-auto w-[min(28rem,92vw)] rounded-lg border p-5 shadow-lg backdrop:bg-black/40" aria-labelledby="retry-title">
        <form className="flex flex-col gap-4">
          <h2 id="retry-title" className="text-lg font-semibold">Retry sending this digest?</h2>
          <p className="text-sm">
            It goes back to approved and is emailed now to <strong>{recipientCount}</strong> {recipientCount === 1 ? "recipient" : "recipients"}.
          </p>
          {digest.error && <p className="rounded bg-red-50 p-2 text-sm text-red-900">Last error: {digest.error}</p>}
          <p className="text-sm">If part of the digest had already been sent, those recipients will get it a second time.</p>
          <input type="hidden" name="id" value={digest.id} />
          <input type="hidden" name="confirm" value="yes" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => retryDialog.current?.close()} className={btn}>Cancel</button>
            <button formAction={retryAction} className={`${btn} bg-red-700 text-white`}>Retry now</button>
          </div>
        </form>
      </dialog>

      <dialog ref={failDialog} className="m-auto w-[min(28rem,92vw)] rounded-lg border p-5 shadow-lg backdrop:bg-black/40" aria-labelledby="fail-title">
        <form className="flex flex-col gap-4">
          <h2 id="fail-title" className="text-lg font-semibold">Mark this digest as failed?</h2>
          <p className="text-sm">It has been in sending for {stuckMinutes ?? "more than 15"} minutes. Nothing is sent. The change is logged with your email.</p>
          <input type="hidden" name="id" value={digest.id} />
          <input type="hidden" name="confirm" value="yes" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => failDialog.current?.close()} className={btn}>Cancel</button>
            <button formAction={markFailedAction} className={`${btn} bg-red-700 text-white`}>Mark as failed</button>
          </div>
        </form>
      </dialog>

      <section className="min-w-0">
        <h2 className="mb-2 font-semibold">Preview</h2>
        <p className="mb-2 truncate text-sm text-zinc-600">Subject: {preview.subject}</p>
        {/* Sandboxed with no permissions: the email's HTML cannot run scripts or reach this page. */}
        <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[900px] w-full rounded border bg-white" />
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">Plain-text version</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded border bg-zinc-50 p-3 text-xs">{preview.text}</pre>
        </details>
      </section>
    </div>
  );
}
