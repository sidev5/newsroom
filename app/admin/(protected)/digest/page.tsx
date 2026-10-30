import { notFound } from "next/navigation";
import { bannerFromSearch } from "@/lib/admin/messages";
import { currentAdminEmail } from "@/lib/admin/session";
import { digestDeps, recipientDeps } from "@/lib/digest/runtime";
import { recipientCount, stuckMinutes } from "@/lib/digest/service";
import { DigestSchemaError } from "@/lib/digest/store";
import { windowStart, weekStart } from "@/lib/digest/week";
import type { DigestArticle, DigestRow } from "@/lib/digest/types";
import { env } from "@/lib/env";
import { emailProvider } from "@/lib/mail";
import { addRecipientsAction, createDraftAction, setRecipientActiveAction } from "./actions";
import { RemoveRecipient } from "./RemoveRecipient";
import { DigestEditor } from "./DigestEditor";

export const dynamic = "force-dynamic";

const PLACEHOLDER_SITE = "https://your-newsroom.example";
const btn = "rounded border px-3 py-1.5 text-sm";

export default async function DigestPage({ searchParams }: PageProps<"/admin/digest">) {
  // Layouts don't protect pages on their own: check again before using the service role.
  if (!(await currentAdminEmail())) notFound();
  // The URL carries codes only; the wording comes from lib/admin/messages.ts.
  const message = bannerFromSearch(await searchParams);

  const banner = (
    <>
      {message?.kind === "ok" && <p className="rounded bg-green-100 p-2 text-green-900">{message.text}</p>}
      {message?.kind === "problem" && <p role="alert" className="rounded bg-red-100 p-2 text-red-900">{message.text}</p>}
    </>
  );

  try {
    return await Content({ banner });
  } catch (err) {
    // A missing table gets a plain explanation, not a 500.
    if (err instanceof DigestSchemaError) {
      return (
        <main className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold">Weekly digest</h1>
          {banner}
          <p role="alert" className="rounded bg-yellow-100 p-3 text-yellow-900">{err.message}</p>
        </main>
      );
    }
    throw err;
  }
}

async function Content({ banner }: { banner: React.ReactNode }) {
  const deps = digestDeps();
  const e = env();
  const week = weekStart(deps.now());

  const digest: DigestRow | null = await deps.store.current(week);
  let articles: DigestArticle[] = [];
  if (digest && digest.status !== "skipped") {
    const used = await deps.store.usedArticleIds(digest.week_start);
    const candidates = (await deps.store.candidates(windowStart(deps.now()).toISOString())).filter((a) => !used.has(a.id));
    const own = await deps.store.articles(digest.article_ids);
    const seen = new Set(own.map((a) => a.id));
    articles = [...own, ...candidates.filter((a) => !seen.has(a.id))];
  }

  // How long a digest has been "sending" (if over 15 minutes it is stuck), and why an approved one is waiting again.
  const stuck = digest ? stuckMinutes(digest, deps.now()) : null;
  const lastFailure = digest && digest.status === "approved" ? ((await deps.store.lastFailure?.(digest.id)) ?? null) : null;
  const sendingFor = digest?.status === "sending" ? Math.max(0, Math.floor((deps.now().getTime() - new Date(digest.updated_at).getTime()) / 60_000)) : null;

  const recipients = await recipientDeps().recipients.list();
  const count = await recipientCount(deps);

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Weekly digest</h1>
        <form className="ml-auto">
          <button formAction={createDraftAction} className={`${btn} bg-zinc-900 text-white`}>Create this week&apos;s draft</button>
        </form>
      </div>
      {banner}

      {!digest && <p className="text-zinc-600">There is no digest yet. The draft is built every Monday, or use the button above.</p>}
      {digest?.status === "skipped" && (
        <p className="rounded bg-zinc-100 p-3 text-zinc-800">
          Week of {digest.week_start}: {digest.error ?? "skipped"}. Use the button above to check again.
        </p>
      )}
      {digest && digest.status !== "skipped" && (
        <DigestEditor
          // Remount when the saved digest changes, so the form starts from what is stored.
          key={`${digest.id}-${digest.updated_at}`}
          digest={digest}
          articles={articles}
          siteUrl={e.SITE_URL ?? PLACEHOLDER_SITE}
          siteUrlIsPlaceholder={!e.SITE_URL}
          contact={e.DIGEST_CONTACT ?? null}
          recipientCount={count}
          hasDistributionList={Boolean(e.DIGEST_TO)}
          providerName={safeProvider()}
          stuckMinutes={stuck}
          sendingMinutes={sendingFor}
          lastFailure={lastFailure}
        />
      )}

      <section className="flex max-w-3xl flex-col gap-3">
        <h2 className="text-lg font-semibold">Recipients</h2>
        <p className="text-sm text-zinc-600">
          {count} {count === 1 ? "address" : "addresses"} will receive the digest
          {e.DIGEST_TO ? " (one of them is the distribution list from DIGEST_TO)" : ""}. Recipients are sent as BCC in batches of 50.
        </p>
        <form className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Add addresses (paste a list: commas, semicolons or one per line)
            <textarea name="emails" rows={3} className="rounded border p-2" placeholder="name@company.com, other@company.com" />
          </label>
          <div>
            <button formAction={addRecipientsAction} className={btn}>Add</button>
          </div>
        </form>
        {recipients.length === 0 ? (
          <p className="text-sm text-zinc-500">No recipients yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded border">
            {recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                <span className={`min-w-0 flex-1 truncate ${r.active ? "" : "text-zinc-400 line-through"}`}>{r.email}</span>
                <form className="flex gap-2">
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="active" value={String(!r.active)} />
                  <button formAction={setRecipientActiveAction} className={btn}>{r.active ? "Deactivate" : "Activate"}</button>
                </form>
                {/* Its own form inside a dialog, so it cannot sit inside the form above. */}
                <RemoveRecipient id={r.id} email={r.email} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function safeProvider(): "smtp" | "graph" | "none" {
  try {
    return emailProvider();
  } catch {
    return "none";
  }
}
