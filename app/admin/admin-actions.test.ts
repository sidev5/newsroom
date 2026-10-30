import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions are exercised with their dependencies mocked. redirect() throws, as it does in Next, so the
// URL an action redirects to is what the test reads.
const m = vi.hoisted(() => ({
  review: {
    approveArticle: vi.fn(),
    rejectArticle: vi.fn(),
    saveArticleEdits: vi.fn(),
    unpublishArticle: vi.fn(),
    bulkApprove: vi.fn(),
    bulkReject: vi.fn(),
  },
  recover: { restoreArticle: vi.fn(), bulkRestore: vi.fn(), markRelevant: vi.fn(), bulkMarkRelevant: vi.fn() },
  pipeline: { runOneStage: vi.fn() },
  digest: {
    adminCreateDraft: vi.fn(),
    approveDigest: vi.fn(),
    unapproveDigest: vi.fn(),
    sendDigestNow: vi.fn(),
    sendTestToAdmin: vi.fn(),
    updateDigest: vi.fn(),
    markDigestFailed: vi.fn(),
    retryDigest: vi.fn(),
  },
  budget: { raiseTodaysLimit: vi.fn() },
  recipients: { addRecipients: vi.fn(), removeRecipient: vi.fn(), setRecipientActive: vi.fn() },
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  signOut: vi.fn(async () => {}),
  deleted: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath, revalidateTag: m.revalidateTag }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: (n: string) => m.deleted.push(n) }) }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => ({ auth: { signOut: m.signOut } }) }));
vi.mock("@/lib/admin/review", () => m.review);
vi.mock("@/lib/admin/recover", () => m.recover);
vi.mock("@/lib/admin/pipeline", () => m.pipeline);
vi.mock("@/lib/admin/budget-admin", () => m.budget);
vi.mock("@/lib/digest/service", () => m.digest);
vi.mock("@/lib/digest/recipients", () => m.recipients);
vi.mock("@/lib/digest/runtime", () => ({ digestDeps: () => ({}), recipientDeps: () => ({}), sendDeps: () => ({}) }));
vi.mock("@/lib/digest/store", () => ({ DigestSchemaError: class DigestSchemaError extends Error {} }));

import * as review from "./(protected)/actions";
import * as digest from "./(protected)/digest/actions";

const ID = "0b6f9a6e-2f4d-4d7e-9a53-3c1f0e8b7a11";
const form = (fields: Record<string, string | string[]> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
/** Runs an action and returns the URL it redirected to. */
async function redirected(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("REDIRECT ")) return msg.slice("REDIRECT ".length);
    throw err;
  }
  throw new Error("the action did not redirect");
}

beforeEach(() => {
  for (const group of [m.review, m.recover, m.pipeline, m.digest, m.recipients, m.budget]) for (const fn of Object.values(group)) fn.mockReset();
  m.signOut.mockClear();
  m.revalidatePath.mockClear();
  m.revalidateTag.mockClear();
  m.deleted.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ADM-04: an action that fails with 'Not authorised.' goes to the login page", () => {
  const expired = { ok: false, error: "Not authorised." };

  it.each([
    ["approve", () => (m.review.approveArticle.mockResolvedValue(expired), review.approveAction(form({ id: ID, headline: "H", body: "B" })))],
    ["reject", () => (m.review.rejectArticle.mockResolvedValue(expired), review.rejectAction(form({ id: ID })))],
    ["save", () => (m.review.saveArticleEdits.mockResolvedValue(expired), review.saveAction(form({ id: ID })))],
    ["unpublish", () => (m.review.unpublishArticle.mockResolvedValue(expired), review.unpublishAction(form({ id: ID })))],
    ["restore", () => (m.recover.restoreArticle.mockResolvedValue(expired), review.restoreAction(form({ id: ID })))],
    ["mark relevant", () => (m.recover.markRelevant.mockResolvedValue(expired), review.markRelevantAction(form({ id: ID })))],
    ["bulk approve", () => (m.review.bulkApprove.mockResolvedValue(expired), review.bulkApproveAction(form({ ids: [ID], confirm: "yes" })))],
    ["bulk reject", () => (m.review.bulkReject.mockResolvedValue(expired), review.bulkRejectAction(form({ ids: [ID], confirm: "yes" })))],
    ["bulk restore", () => (m.recover.bulkRestore.mockResolvedValue(expired), review.bulkRestoreAction(form({ ids: [ID], confirm: "yes" })))],
    ["bulk mark relevant", () => (m.recover.bulkMarkRelevant.mockResolvedValue(expired), review.bulkMarkRelevantAction(form({ ids: [ID], confirm: "yes" })))],
    ["create digest draft", () => (m.digest.adminCreateDraft.mockResolvedValue(expired), digest.createDraftAction())],
    ["save digest", () => (m.digest.updateDigest.mockResolvedValue(expired), digest.saveDigestAction(form({ id: "d1" })))],
    ["approve digest", () => (m.digest.approveDigest.mockResolvedValue(expired), digest.approveAction(form({ id: "d1" })))],
    ["unapprove digest", () => (m.digest.unapproveDigest.mockResolvedValue(expired), digest.unapproveAction(form({ id: "d1" })))],
    ["send test", () => (m.digest.sendTestToAdmin.mockResolvedValue(expired), digest.sendTestAction(form({ id: "d1" })))],
    ["send now", () => (m.digest.sendDigestNow.mockResolvedValue(expired), digest.sendNowAction(form({ id: "d1", confirm: "yes" })))],
    ["add recipients", () => (m.recipients.addRecipients.mockResolvedValue(expired), digest.addRecipientsAction(form({ emails: "a@b.co" })))],
    ["remove recipient", () => (m.recipients.removeRecipient.mockResolvedValue(expired), digest.removeRecipientAction(form({ id: "r1" })))],
    ["toggle recipient", () => (m.recipients.setRecipientActive.mockResolvedValue(expired), digest.setRecipientActiveAction(form({ id: "r1", active: "false" })))],
  ])("%s", async (_name, run) => {
    expect(await redirected(run as () => Promise<unknown>)).toBe("/admin/login?reason=expired");
  });
});

describe("PERF-05: the public site is revalidated when what it shows may have changed", () => {
  const expectRevalidated = () => {
    expect(m.revalidateTag).toHaveBeenCalledWith("stories", { expire: 0 });
    expect(m.revalidatePath).toHaveBeenCalledWith("/");
    expect(m.revalidatePath).toHaveBeenCalledWith("/article/[slug]", "page");
  };
  const expectNotRevalidated = () => {
    expect(m.revalidateTag).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalledWith("/");
  };

  it.each([
    ["approve (AI or employee story)", () => (m.review.approveArticle.mockResolvedValue({ ok: true }), review.approveAction(form({ id: ID, headline: "H", body: "B" })))],
    ["unpublish", () => (m.review.unpublishArticle.mockResolvedValue({ ok: true }), review.unpublishAction(form({ id: ID })))],
    ["restore", () => (m.recover.restoreArticle.mockResolvedValue({ ok: true }), review.restoreAction(form({ id: ID })))],
    ["edit", () => (m.review.saveArticleEdits.mockResolvedValue({ ok: true }), review.saveAction(form({ id: ID, headline: "H", body: "B" })))],
    ["bulk approve", () => (m.review.bulkApprove.mockResolvedValue({ ok: true, done: 2, failed: [] }), review.bulkApproveAction(form({ ids: ["a", "b"], confirm: "yes" })))],
    ["bulk restore", () => (m.recover.bulkRestore.mockResolvedValue({ ok: true, done: 1, failed: [] }), review.bulkRestoreAction(form({ ids: ["a"], confirm: "yes" })))],
  ])("after a successful %s", async (_name, run) => {
    await redirected(run);
    expectRevalidated();
  });

  it.each([
    ["approve", () => (m.review.approveArticle.mockResolvedValue({ ok: false, error: "This article is no longer pending review." }), review.approveAction(form({ id: ID, headline: "H", body: "B" })))],
    ["unpublish", () => (m.review.unpublishArticle.mockResolvedValue({ ok: false, error: "This article is no longer published." }), review.unpublishAction(form({ id: ID })))],
    ["a bulk approve that changed nothing", () => (m.review.bulkApprove.mockResolvedValue({ ok: true, done: 0, failed: [{ id: "x", error: "boom" }] }), review.bulkApproveAction(form({ ids: ["x"], confirm: "yes" })))],
    ["a bulk approve without the confirmation", () => review.bulkApproveAction(form({ ids: ["x"] }))],
  ])("not after a failed %s", async (_name, run) => {
    await redirected(run);
    expectNotRevalidated();
  });
});
describe("SEC-09: the redirect carries codes, never free text", () => {
  it("a known failure becomes its code, with the article id only for highlighting", async () => {
    m.review.approveArticle.mockResolvedValue({ ok: false, error: "This article is no longer pending review." });
    const url = await redirected(() => review.approveAction(form({ id: ID, headline: "H", body: "B", tab: "pending", dept: "ev" })));
    expect(url).toBe(`/admin/review?tab=pending&dept=ev&error=not_pending&article=${ID}`);
  });

  it("an unknown or technical failure becomes 'generic', and its text goes to the log", async () => {
    m.review.rejectArticle.mockResolvedValue({ ok: false, error: 'Update failed: relation "public.articles" does not exist' });
    const url = await redirected(() => review.rejectAction(form({ id: ID, reason: "x" })));
    expect(url).toContain("error=update_failed");
    m.review.rejectArticle.mockResolvedValue({ ok: false, error: "Some <b>new</b> message from a library" });
    const url2 = await redirected(() => review.rejectAction(form({ id: ID })));
    expect(url2).toContain("error=generic");
    expect(url2).not.toMatch(/Some|library|%3C|<b>/i);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Some <b>new</b> message from a library"));
  });

  it("a success is a code, and a failed audit-log write is only a flag", async () => {
    m.review.approveArticle.mockResolvedValue({ ok: true });
    expect(await redirected(() => review.approveAction(form({ id: ID, headline: "H", body: "B" })))).toBe("/admin/review?tab=pending&notice=published");
    m.review.approveArticle.mockResolvedValue({ ok: true, warning: "The change was saved but the audit log entry failed: relation review_log does not exist" });
    const url = await redirected(() => review.approveAction(form({ id: ID, headline: "H", body: "B" })));
    expect(url).toBe("/admin/review?tab=pending&notice=published&warn=1");
    expect(url).not.toMatch(/review_log|relation/);
  });

  it("bulk results carry counts and the first reason as a code", async () => {
    m.review.bulkApprove.mockResolvedValue({ ok: true, done: 2, failed: [{ id: "x", error: "This article is no longer pending review." }, { id: "y", error: "Update failed: boom" }] });
    const url = await redirected(() => review.bulkApproveAction(form({ ids: ["a", "b", "x", "y"], confirm: "yes", tab: "pending" })));
    expect(url).toBe("/admin/review?tab=pending&notice=bulk_published&n=2&k=2&why=not_pending");
    m.review.bulkReject.mockResolvedValue({ ok: true, done: 3, failed: [], warning: "audit log failed" });
    expect(await redirected(() => review.bulkRejectAction(form({ ids: ["a"], confirm: "yes", tab: "pending" })))).toBe("/admin/review?tab=pending&notice=bulk_rejected&n=3&warn=1");
  });

  it("a bulk action without the confirmation does nothing but say so", async () => {
    const url = await redirected(() => review.bulkApproveAction(form({ ids: [ID] })));
    expect(url).toContain("error=needs_confirmation");
    expect(m.review.bulkApprove).not.toHaveBeenCalled();
  });

  it("digest actions use codes as well", async () => {
    m.digest.adminCreateDraft.mockResolvedValue({ ok: true, draft: { kind: "created", digest: { article_ids: ["a", "b", "c"] } } });
    expect(await redirected(() => digest.createDraftAction())).toBe("/admin/digest?notice=digest_created&n=3");
    m.digest.adminCreateDraft.mockResolvedValue({ ok: true, draft: { kind: "skipped", reason: "No new published stories in the last 7 days, so there is no digest this week." } });
    expect(await redirected(() => digest.createDraftAction())).toBe("/admin/digest?error=digest_no_candidates");
    m.digest.approveDigest.mockResolvedValue({ ok: false, error: "Add at least one recipient (or set DIGEST_TO) before approving." });
    expect(await redirected(() => digest.approveAction(form({ id: "d1" })))).toBe("/admin/digest?error=digest_no_recipients");
    m.digest.sendDigestNow.mockResolvedValue({ ok: true, recipients: 12, batches: 2 });
    expect(await redirected(() => digest.sendNowAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/digest?notice=digest_sent&n=12&k=2");
    m.recipients.addRecipients.mockResolvedValue({ ok: true, added: 4, duplicates: 1, invalid: 2 });
    expect(await redirected(() => digest.addRecipientsAction(form({ emails: "x" })))).toBe("/admin/digest?notice=recipients_added&n=4&k=1&m=2");
    expect(await redirected(() => digest.sendNowAction(form({ id: "d1" })))).toBe("/admin/digest?error=digest_sending_needs_confirmation");
  });

  it("a failed send never puts the provider's message in the URL", async () => {
    m.digest.sendDigestNow.mockResolvedValue({ ok: false, error: "535 5.7.3 Authentication unsuccessful for user ada@company.com 1 of 3 batches had already been sent" });
    const url = await redirected(() => digest.sendNowAction(form({ id: "d1", confirm: "yes" })));
    expect(url).toBe("/admin/digest?error=send_failed");
    expect(url).not.toMatch(/@|535/);
  });
});

describe("ADM-01: sign out", () => {
  it("ends the Supabase session, clears the activity cookie and goes to the login page", async () => {
    expect(await redirected(() => review.signOutAction())).toBe("/admin/login");
    expect(m.signOut).toHaveBeenCalledTimes(1);
    expect(m.deleted).toEqual(["nr_admin_activity"]);
  });

  it("still clears the cookie and redirects if Supabase cannot be reached", async () => {
    m.signOut.mockRejectedValueOnce(new Error("network down"));
    expect(await redirected(() => review.signOutAction())).toBe("/admin/login");
    expect(m.deleted).toEqual(["nr_admin_activity"]);
  });
});

describe("BE-04: Raise today's limit", () => {
  it("goes back to the Pipeline tab with a fixed notice when it worked", async () => {
    m.budget.raiseTodaysLimit.mockResolvedValue({ ok: true, limit: 5, previous: 2 });
    const url = await redirected(() => review.raiseBudgetAction(form({ limit: "5", tab: "pipeline" })));
    expect(url).toBe("/admin/review?tab=pipeline&notice=budget_raised");
    expect(m.budget.raiseTodaysLimit).toHaveBeenCalledWith("5");
  });

  it("an expired session goes to the login page", async () => {
    m.budget.raiseTodaysLimit.mockResolvedValue({ ok: false, error: "Not authorised." });
    expect(await redirected(() => review.raiseBudgetAction(form({ limit: "5" })))).toBe("/admin/login?reason=expired");
  });

  it("a refused amount becomes a code, never the text", async () => {
    m.budget.raiseTodaysLimit.mockResolvedValue({ ok: false, error: "The new limit must be higher than today's limit ($2.00)." });
    const url = await redirected(() => review.raiseBudgetAction(form({ limit: "1", tab: "pipeline" })));
    expect(url).toBe("/admin/review?tab=pipeline&error=budget_not_higher");
    expect(url).not.toContain("2.00");
  });
});

describe("BE-03: Mark as failed and Retry", () => {
  it("Mark as failed needs the confirmation and does nothing without it", async () => {
    const url = await redirected(() => digest.markFailedAction(form({ id: "d1" })));
    expect(url).toContain("error=needs_confirmation");
    expect(m.digest.markDigestFailed).not.toHaveBeenCalled();
  });

  it("Mark as failed reports how long the digest had been stuck", async () => {
    m.digest.markDigestFailed.mockResolvedValue({ ok: true, minutes: 42 });
    expect(await redirected(() => digest.markFailedAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/digest?notice=digest_marked_failed&n=42");
    expect(m.digest.markDigestFailed).toHaveBeenCalledTimes(1);
  });

  it("Mark as failed answers a refusal with a code, and an expired session with the login page", async () => {
    m.digest.markDigestFailed.mockResolvedValue({ ok: false, error: "This digest has been sending for less than 15 minutes, so it is not stuck yet. Wait, then try again." });
    expect(await redirected(() => digest.markFailedAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/digest?error=digest_not_stuck");
    m.digest.markDigestFailed.mockResolvedValue({ ok: false, error: "Not authorised." });
    expect(await redirected(() => digest.markFailedAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/login?reason=expired");
  });

  it("Retry needs the confirmation, then sends and reports the counts like Send now", async () => {
    expect(await redirected(() => digest.retryAction(form({ id: "d1" })))).toContain("error=digest_sending_needs_confirmation");
    expect(m.digest.retryDigest).not.toHaveBeenCalled();
    m.digest.retryDigest.mockResolvedValue({ ok: true, recipients: 12, batches: 2, status: "sent" });
    expect(await redirected(() => digest.retryAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/digest?notice=digest_sent&n=12&k=2");
  });

  it("Retry answers a failed retry with the send_failed code, without the provider's text", async () => {
    m.digest.retryDigest.mockResolvedValue({ ok: false, error: "SMTP AUTH is disabled for this mailbox; ask IT to enable it, or use Download .eml", status: "failed" });
    expect(await redirected(() => digest.retryAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/digest?error=smtp_auth");
    m.digest.retryDigest.mockResolvedValue({ ok: false, error: "Only a failed digest can be retried (this one is sent).", status: "sent" });
    expect(await redirected(() => digest.retryAction(form({ id: "d1", confirm: "yes" })))).toBe("/admin/digest?error=digest_not_failed");
  });
});

describe("the Run-next-batch button", () => {
  it("passes 'Not authorised.' back so the browser can redirect to the login page", async () => {
    m.pipeline.runOneStage.mockResolvedValue({ ok: false, error: "Not authorised." });
    expect(await review.runStageAction("write")).toEqual({ ok: false, error: "Not authorised." });
    expect(await review.runStageAction("nonsense")).toEqual({ ok: false, error: "Unknown stage." });
  });
});
