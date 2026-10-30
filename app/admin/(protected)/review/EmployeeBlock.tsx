import type { ReviewArticle } from "@/lib/admin/review-data";
import { formatUtc } from "@/lib/admin/review-view";
import type { SubmitterView } from "@/lib/submissions/types";

export const EMPLOYEE_NOTE = "Written by an employee, not checked by AI: please verify before approving.";

export function EmployeeBadge() {
  return (
    <span className="rounded-full bg-sky-800 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-white">Employee submission</span>
  );
}

/** The author's name and department are public (they appear in the byline); the email and flags are for admins only. */
export function authorLine(a: Pick<ReviewArticle, "author_first_name" | "author_last_name" | "author_department">): string {
  const name = [a.author_first_name, a.author_last_name].filter(Boolean).join(" ") || "Unknown author";
  return a.author_department ? `${name} · ${a.author_department}` : name;
}

export function EmployeeBlock({ article, submitter, showNote = true }: { article: ReviewArticle; submitter: SubmitterView | undefined; showNote?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950">
      <p className="flex flex-wrap items-center gap-2">
        <EmployeeBadge />
        <span className="font-medium">{authorLine(article)}</span>
      </p>
      {submitter ? (
        <>
          <p>
            Company email: <span className="font-mono">{submitter.email}</span> <span className="text-sky-800">(admin only)</span>
          </p>
          {!submitter.emailVerified && (
            <p className="rounded bg-amber-100 p-1.5 font-medium text-amber-900">
              Unverified email: no company domain list (ALLOWED_EMAIL_DOMAINS) is set, so this address was not checked.
            </p>
          )}
          {submitter.authorName && submitter.namePublic === false && (
            <p className="rounded bg-amber-100 p-1.5 font-medium text-amber-900">
              Written by {submitter.authorName}{submitter.authorDepartment ? ` (${submitter.authorDepartment})` : ""}. The author did not agree to show their name: it is published as &ldquo;Newsroom contributor&rdquo;.
            </p>
          )}
          <p className="text-sky-800">Sent {formatUtc(submitter.submittedAt)}</p>
        </>
      ) : (
        <p className="text-amber-900">The author&apos;s contact details could not be found.</p>
      )}
      {showNote && <p className="font-medium">{EMPLOYEE_NOTE}</p>}
    </div>
  );
}
