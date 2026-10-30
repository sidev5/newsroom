"use client";

import { useActionState } from "react";
import { ERASE_CONFIRM_WORD } from "@/lib/erasure/constants";
import { erasePersonAction, planPersonAction, type ToolState } from "./actions";

const btn = "rounded border px-3 py-1.5 text-sm";

/** Search by email, see what would go, confirm, run. The address stays in this component's state: no URL, no log. */
export function PrivacyTool() {
  const [plan, planAction, planning] = useActionState<ToolState, FormData>(planPersonAction, null);
  const [done, eraseAction, erasing] = useActionState<ToolState, FormData>(erasePersonAction, null);

  // The result of the last action wins.
  const state = done ?? plan;
  const showing = state && state.kind !== "done" ? state : null;
  const result = state?.kind === "done" ? state : null;

  return (
    <div className="flex flex-col gap-6">
      <form action={planAction} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Email address of the person
          <input name="email" type="email" required autoComplete="off" placeholder="name@company.com" className="w-72 rounded border p-2" />
        </label>
        <button disabled={planning} className={`${btn} bg-zinc-900 text-white disabled:opacity-50`}>
          {planning ? "Looking…" : "Look up"}
        </button>
      </form>

      {showing?.kind === "error" && (
        <p role="alert" className="rounded bg-red-100 p-2 text-sm text-red-900">
          {showing.error}
        </p>
      )}

      {result && (
        <div role="status" className="flex flex-col gap-1 rounded bg-green-100 p-3 text-sm text-green-900">
          <p className="font-medium">Done.</p>
          <ul className="ml-5 list-disc">
            <li>
              {result.outcome.articles} {result.outcome.articles === 1 ? "story" : "stories"} anonymized
              {result.mode === "unpublish" ? `, ${result.outcome.unpublished} taken off the site` : ""}
            </li>
            <li>{result.outcome.submitterRows} submitter {result.outcome.submitterRows === 1 ? "record" : "records"} deleted</li>
            <li>{result.outcome.photos} photo {result.outcome.photos === 1 ? "file" : "files"} removed from storage</li>
            <li>{result.outcome.recipients} digest {result.outcome.recipients === 1 ? "subscription" : "subscriptions"} removed</li>
            <li>{result.outcome.likes} {result.outcome.likes === 1 ? "like" : "likes"} and {result.outcome.comments} {result.outcome.comments === 1 ? "comment" : "comments"} deleted</li>
          </ul>
          {result.outcome.warning && <p role="alert" className="font-medium text-red-800">{result.outcome.warning}</p>}
          <p>An entry was added to the log below (without the address).</p>
        </div>
      )}

      {showing?.kind === "plan" && !result && (
        <section className="flex flex-col gap-4 rounded border p-4" aria-label="What would be removed">
          {showing.plan.empty ? (
            <p className="text-sm">Nothing is stored for <strong>{showing.email}</strong>: no story sent from this address, no likes or comments, and it is not on the digest list.</p>
          ) : (
            <form action={eraseAction} className="flex flex-col gap-4">
              <input type="hidden" name="email" value={showing.email} />
              <h2 className="font-semibold">This would be removed for {showing.email}</h2>
              <ul className="flex flex-col gap-1 text-sm">
                <li>
                  <strong>{showing.plan.submitterRows}</strong> submitter {showing.plan.submitterRows === 1 ? "record" : "records"}: the email, the hashed network address and the photo reference.
                </li>
                <li>
                  <strong>{showing.plan.privatePhotos + showing.plan.publicPhotos}</strong> photo {showing.plan.privatePhotos + showing.plan.publicPhotos === 1 ? "file" : "files"} deleted from storage ({showing.plan.privatePhotos} private, {showing.plan.publicPhotos} public; a deleted public photo is replaced by the department image).
                </li>
                <li>
                  <strong>{showing.plan.recipients}</strong> digest {showing.plan.recipients === 1 ? "subscription" : "subscriptions"}.
                </li>
                <li>
                  <strong>{showing.plan.readerLikes}</strong> {showing.plan.readerLikes === 1 ? "like" : "likes"} and <strong>{showing.plan.readerComments}</strong> {showing.plan.readerComments === 1 ? "comment" : "comments"} made as a reader, deleted.
                </li>
                <li>
                  <strong>{showing.plan.articles.length}</strong> {showing.plan.articles.length === 1 ? "story" : "stories"}, each losing its byline, author department and photo credit:
                </li>
              </ul>
              {showing.plan.articles.length > 0 && (
                <ul className="ml-5 list-disc text-sm">
                  {showing.plan.articles.map((a) => (
                    <li key={a.id}>
                      {a.headline} <span className="text-zinc-500">({a.status.replace("_", " ")}{a.hasPhoto ? ", has a photo" : ""})</span>
                    </li>
                  ))}
                </ul>
              )}

              <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="font-medium">What happens to their stories</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" name="mode" value="anonymize" defaultChecked className="mt-1" />
                  <span>Keep the stories, without the author&apos;s name (published stories stay on the site).</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="mode" value="unpublish" className="mt-1" />
                  <span>Also take published stories off the site (they go back to Pending).</span>
                </label>
              </fieldset>
              <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">
                The text of a story is not edited. If a story&apos;s text names the person, choose the second option and edit it in Pending.
              </p>

              <label className="flex flex-col gap-1 text-sm">
                Type <strong>{ERASE_CONFIRM_WORD}</strong> to confirm. This cannot be undone.
                <input name="confirm" autoComplete="off" required className="w-40 rounded border p-2" />
              </label>
              <div>
                <button disabled={erasing} className={`${btn} bg-red-700 text-white disabled:opacity-50`}>
                  {erasing ? "Deleting…" : "Delete this person's data"}
                </button>
              </div>
              <p className="text-xs text-zinc-500">The log keeps your email, the date, the numbers above and a one-way hash of the address, never the address itself.</p>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
