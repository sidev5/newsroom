"use server";

import { redirect } from "next/navigation";
import { LOGIN_EXPIRED_PATH, isNotAuthorised } from "@/lib/admin/messages";
import { eraseData, planErasure, type EraseOutcome, type EraseMode } from "@/lib/erasure/erase";
import { eraseDeps } from "@/lib/erasure/runtime";
import { revalidatePublicSite } from "@/lib/news/revalidate";

// The person's email address is only ever in this form's own state and in the action's arguments: it is never put in
// a URL, a log line or an error message. Both actions check the admin inside lib/erasure/erase.ts.

export type PlanView = {
  articles: { id: string; headline: string; status: string; hasPhoto: boolean }[];
  submitterRows: number;
  privatePhotos: number;
  publicPhotos: number;
  recipients: number;
  readerLikes: number;
  readerComments: number;
  empty: boolean;
};

export type ToolState =
  | { kind: "plan"; email: string; plan: PlanView }
  | { kind: "done"; outcome: EraseOutcome; mode: EraseMode }
  | { kind: "error"; error: string; email?: string }
  | null;

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

/** An error's text for the log, with anything that looks like an email address blanked: the subject must not end up in a log. */
function logSafe(err: unknown): string {
  return (err instanceof Error ? err.message : "unknown error").replace(/\S+@\S+/g, "[address]").slice(0, 300);
}

function failure(error: string, email?: string): ToolState {
  if (isNotAuthorised(error)) redirect(LOGIN_EXPIRED_PATH);
  return { kind: "error", error, email };
}

/** Step 1: what is stored for this address. Changes nothing. */
export async function planPersonAction(_previous: ToolState, form: FormData): Promise<ToolState> {
  const email = field(form, "email");
  let r: Awaited<ReturnType<typeof planErasure>>;
  try {
    r = await planErasure(eraseDeps(), email);
  } catch (err) {
    console.error(`looking up a person's data failed: ${logSafe(err)}`);
    return failure("The lookup did not work. Try again; the reason is in the server log.", email);
  }
  // Outside the try: for an expired session failure() redirects, and redirect() works by throwing.
  if (!r.ok) return failure(r.error, email);
  const { plan } = r;
  return {
    kind: "plan",
    email,
    plan: {
      articles: plan.articles.map((a) => ({ id: a.id, headline: a.headline, status: a.status, hasPhoto: Boolean(a.image_path) || (a.image_paths?.length ?? 0) > 0 })),
      submitterRows: plan.submitterRows,
      privatePhotos: plan.privatePhotos.length,
      publicPhotos: plan.publicPhotos.length,
      recipients: plan.recipientIds.length,
      readerLikes: plan.readerLikes,
      readerComments: plan.readerComments,
      empty: plan.empty,
    },
  };
}

/** Step 2: do it. Needs the mode and the confirmation word. */
export async function erasePersonAction(_previous: ToolState, form: FormData): Promise<ToolState> {
  const email = field(form, "email");
  const mode = field(form, "mode");
  let r: Awaited<ReturnType<typeof eraseData>>;
  try {
    r = await eraseData(eraseDeps(), email, mode, field(form, "confirm"));
  } catch (err) {
    console.error(`erasing a person's data failed: ${logSafe(err)}`);
    return failure("The deletion did not finish. Nothing is lost by trying again; the reason is in the server log.", email);
  }
  if (!r.ok) return failure(r.error, email);
  revalidatePublicSite(); // stories lost their byline or went off the site
  return { kind: "done", outcome: r.outcome, mode: mode as EraseMode };
}