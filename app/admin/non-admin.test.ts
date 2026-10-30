import { beforeEach, describe, expect, it, vi } from "vitest";

// Every server action and admin route must refuse a visitor who is not a signed-in admin, BEFORE it uses the service role.
// Unlike admin-actions.test.ts, which replaces the libraries, this runs the real ones with a signed-out session. The list of
// actions is checked for completeness: add an action without adding it here and this file fails.

const spy = vi.hoisted(() => ({ serviceRole: vi.fn(), supabaseServer: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn(), sent: vi.fn() }));

vi.mock("@/lib/admin/session", () => ({ currentAdminEmail: async () => null, currentUserEmail: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    spy.serviceRole();
    throw new Error("the service role was used by a visitor who is not an admin");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => {
    spy.supabaseServer();
    throw new Error("a Supabase session was used by a visitor who is not an admin");
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: spy.revalidatePath, revalidateTag: spy.revalidateTag }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: () => {}, get: () => undefined, set: () => {} }), headers: async () => new Headers() }));

import { resetEnvCache } from "@/lib/env";
import * as review from "./(protected)/actions";
import * as digest from "./(protected)/digest/actions";
import * as privacy from "./(protected)/privacy/actions";
import * as security from "./(protected)/security/actions";
import { GET as emlRoute } from "./(protected)/digest/eml/route";

const ID = "0b6f9a6e-2f4d-4d7e-9a53-3c1f0e8b7a11";
const LOGIN = "/admin/login?reason=expired";

const form = (fields: Record<string, string | string[]> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: "test-secret-0123456789abcdef",
    ADMIN_EMAILS: "editor@example.com",
    SITE_URL: "https://news.example.com",
  });
  delete process.env.EMAIL_PROVIDER;
  resetEnvCache();
  for (const fn of Object.values(spy)) fn.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/** Runs an action and reports how it refused: a redirect to the login page, or an error result. */
async function refusal(run: () => Promise<unknown>): Promise<{ via: "redirect"; url: string } | { via: "result"; error: string } | { via: "other"; value: unknown }> {
  try {
    const value = (await run()) as { ok?: boolean; error?: string; kind?: string } | undefined;
    if (value && value.ok === false && typeof value.error === "string") return { via: "result", error: value.error };
    return { via: "other", value };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("REDIRECT ")) return { via: "redirect", url: msg.slice("REDIRECT ".length) };
    throw err;
  }
}

type Call = () => Promise<unknown>;
const none = null as never;

/** Every admin server action, with the input a real admin would send (confirmations included, so only the admin check can stop it). */
const ACTIONS: Record<string, Record<string, Call>> = {
  "app/admin/(protected)/actions.ts": {
    approveAction: () => review.approveAction(form({ id: ID, headline: "H", body: "B" })),
    rejectAction: () => review.rejectAction(form({ id: ID, reason: "no" })),
    saveAction: () => review.saveAction(form({ id: ID, headline: "H", body: "B" })),
    unpublishAction: () => review.unpublishAction(form({ id: ID })),
    hideCommentAction: () => review.hideCommentAction(form({ id: ID, reason: "spam" })),
    unhideCommentAction: () => review.unhideCommentAction(form({ id: ID })),
    bulkApproveAction: () => review.bulkApproveAction(form({ ids: [ID], confirm: "yes" })),
    bulkRejectAction: () => review.bulkRejectAction(form({ ids: [ID], confirm: "yes", reason: "no" })),
    restoreAction: () => review.restoreAction(form({ id: ID })),
    bulkRestoreAction: () => review.bulkRestoreAction(form({ ids: [ID], confirm: "yes" })),
    markRelevantAction: () => review.markRelevantAction(form({ id: ID })),
    bulkMarkRelevantAction: () => review.bulkMarkRelevantAction(form({ ids: [ID], confirm: "yes" })),
    runStageAction: () => review.runStageAction("write"),
    raiseBudgetAction: () => review.raiseBudgetAction(form({ limit: "50" })),
  },
  "app/admin/(protected)/digest/actions.ts": {
    createDraftAction: () => digest.createDraftAction(),
    saveDigestAction: () => digest.saveDigestAction(form({ id: "d1", subject: "S", intro: "", ids: ["a1"] })),
    approveAction: () => digest.approveAction(form({ id: "d1" })),
    unapproveAction: () => digest.unapproveAction(form({ id: "d1" })),
    sendTestAction: () => digest.sendTestAction(form({ id: "d1" })),
    sendNowAction: () => digest.sendNowAction(form({ id: "d1", confirm: "yes" })),
    markFailedAction: () => digest.markFailedAction(form({ id: "d1", confirm: "yes" })),
    retryAction: () => digest.retryAction(form({ id: "d1", confirm: "yes" })),
    addRecipientsAction: () => digest.addRecipientsAction(form({ emails: "a@b.co" })),
    removeRecipientAction: () => digest.removeRecipientAction(form({ id: "r1", confirm: "yes" })),
    setRecipientActiveAction: () => digest.setRecipientActiveAction(form({ id: "r1", active: "false" })),
  },
  "app/admin/(protected)/privacy/actions.ts": {
    planPersonAction: () => privacy.planPersonAction(none, form({ email: "ada@example.com" })),
    erasePersonAction: () => privacy.erasePersonAction(none, form({ email: "ada@example.com", mode: "unpublish", confirm: "DELETE" })),
  },
  "app/admin/(protected)/security/actions.ts": {
    startMfaEnrolment: () => security.startMfaEnrolment(),
    finishMfaEnrolment: () => security.finishMfaEnrolment("factor-1", "123456"),
  },
};

/** Exported actions that are open to everyone on purpose, and why. */
const PUBLIC_ON_PURPOSE: Record<string, string[]> = {
  "app/admin/(protected)/actions.ts": ["signOutAction"], // signing out must work for any signed-in user
  "app/admin/login/actions.ts": ["loginAction"], // it is the login
};

const MODULES: Record<string, Record<string, unknown>> = {
  "app/admin/(protected)/actions.ts": review,
  "app/admin/(protected)/digest/actions.ts": digest,
  "app/admin/(protected)/privacy/actions.ts": privacy,
  "app/admin/(protected)/security/actions.ts": security,
};

describe("the list of admin actions is complete", () => {
  it("every exported function of every admin actions file is either tested below or public on purpose", () => {
    for (const [file, mod] of Object.entries(MODULES)) {
      const exported = Object.keys(mod).filter((k) => typeof mod[k] === "function").sort();
      const covered = [...Object.keys(ACTIONS[file] ?? {}), ...(PUBLIC_ON_PURPOSE[file] ?? [])].sort();
      expect(exported, `${file}: a server action was added or removed; list it in ACTIONS (or in PUBLIC_ON_PURPOSE with a reason)`).toEqual(covered);
    }
  });

  it("covers every actions.ts file under app/", async () => {
    const { readdirSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");
    const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const found: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name === "actions.ts") found.push(relative(join(root, ".."), join(entry.parentPath, entry.name)).split(sep).join("/"));
    }
    const known = new Set([...Object.keys(ACTIONS), ...Object.keys(PUBLIC_ON_PURPOSE)]);
    expect([...known].sort()).toEqual(found.sort());
  });
});

describe("a visitor who is not an admin is refused by every server action", () => {
  for (const [file, actions] of Object.entries(ACTIONS)) {
    describe(file, () => {
      for (const [name, call] of Object.entries(actions)) {
        it(`${name} refuses, and does not reach the service role`, async () => {
          const r = await refusal(call);
          if (r.via === "redirect") expect(r.url).toBe(LOGIN);
          else if (r.via === "result") expect(r.error).toBe("Not authorised.");
          else throw new Error(`${name} did not refuse: it returned ${JSON.stringify(r.value)}`);
          expect(spy.serviceRole, "the service role was touched").not.toHaveBeenCalled();
          expect(spy.revalidateTag, "the public site was revalidated").not.toHaveBeenCalled();
        });
      }
    });
  }
});

describe("the admin routes", () => {
  it("the .eml download answers 403 and reads nothing", async () => {
    const res = await emlRoute(new Request("https://news.example.com/admin/digest/eml?id=d1"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Not authorised.");
    expect(spy.serviceRole).not.toHaveBeenCalled();
  });
});

describe("what the refusal does not do", () => {
  it("an erase request from a non-admin leaves no trace of the address in the logs", async () => {
    await refusal(() => privacy.erasePersonAction(none, form({ email: "ada.lovelace@example.com", mode: "unpublish", confirm: "DELETE" })));
    const logged = [...(console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls, ...(console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls].flat().join(" ");
    expect(logged).not.toContain("ada.lovelace");
  });
});
