import { formatUtc } from "@/lib/admin/review-view";
import type { AdminComment } from "@/lib/stories/moderation";
import { hideCommentAction, unhideCommentAction } from "../actions";

/**
 * The comments under a published Write story, hidden ones included, with a button to hide a comment (readers stop seeing it at
 * once) or show it again. Every change is written to the comment log with the admin's address. Text is drawn as text.
 */
export function CommentsAdmin({ comments }: { comments: AdminComment[] }) {
  const hidden = comments.filter((c) => c.status === "hidden").length;
  return (
    <details className="rounded border bg-zinc-50 p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Comments ({comments.length}){hidden > 0 ? `, ${hidden} hidden` : ""}
      </summary>
      {comments.length === 0 ? (
        <p className="mt-2 text-zinc-500">No comments yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {comments.map((c) => (
            <li key={c.id} className={`rounded border bg-white p-3 ${c.status === "hidden" ? "opacity-70" : ""}`}>
              <p className="text-xs text-zinc-500">
                {c.name} · {formatUtc(c.createdAt)}
                {c.status === "hidden" && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">hidden</span>}
              </p>
              <p className="mt-1 whitespace-pre-line break-words">{c.body}</p>
              <form className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="tab" value="published" />
                {c.status === "visible" ? (
                  <>
                    <label className="sr-only" htmlFor={`why-${c.id}`}>Reason for hiding (optional)</label>
                    <input id={`why-${c.id}`} name="reason" maxLength={500} placeholder="Reason (optional)" className="min-w-0 flex-1 rounded border p-1.5" />
                    <button formAction={hideCommentAction} className="rounded border bg-red-700 px-3 py-1.5 text-white">Hide</button>
                  </>
                ) : (
                  <button formAction={unhideCommentAction} className="rounded border px-3 py-1.5">Show again</button>
                )}
              </form>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}