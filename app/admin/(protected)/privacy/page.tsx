import { notFound } from "next/navigation";
import { currentAdminEmail } from "@/lib/admin/session";
import { formatUtc } from "@/lib/admin/review-view";
import { recentErasures, type PrivacyLogRow } from "@/lib/erasure/store";
import { PrivacyTool } from "./PrivacyTool";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  // Layouts don't protect pages on their own: check again before using the service role.
  if (!(await currentAdminEmail())) notFound();

  let log: PrivacyLogRow[] = [];
  let logError: string | null = null;
  try {
    log = await recentErasures();
  } catch {
    logError = "The deletion log could not be read. Has supabase/migrations/2026-10-20_privacy_and_hardening.sql been run?";
  }

  return (
    <main className="flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Delete a person&apos;s data</h1>
        <p className="text-sm text-zinc-600">
          For a request to be forgotten. Search by the email address the person used. You see exactly what would be removed before anything is
          changed. Stories sent from that address lose their byline; the submitter record (email, hashed network address, photo reference), their photo
          files and any digest subscription are deleted.
        </p>
        <p className="text-sm text-zinc-600">
          Submitter details are also anonymized automatically: the hashed network address after a week, the email 90 days after the story was published or rejected
          (the cleanup job; periods in the environment settings).
        </p>
      </section>

      <PrivacyTool />

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Deletion log</h2>
        {logError && <p role="alert" className="text-sm text-amber-800">{logError}</p>}
        {!logError && log.length === 0 && <p className="text-sm text-zinc-500">Nothing has been deleted with this tool yet.</p>}
        {log.length > 0 && (
          <ul className="flex flex-col divide-y rounded border text-sm">
            {log.map((l, i) => {
              const d = (l.detail ?? {}) as Record<string, unknown>;
              return (
                <li key={i} className="flex flex-wrap gap-x-4 gap-y-1 p-2">
                  <span>{formatUtc(l.created_at)}</span>
                  <span>by {l.admin_email}</span>
                  <span className="text-zinc-600">
                    {String(d.mode ?? "")}: {String(d.articles ?? 0)} stories, {String(d.submitterRows ?? 0)} records, {String(d.photos ?? 0)} photos, {String(d.recipients ?? 0)} subscriptions
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-zinc-500">The log has no email addresses: only a one-way hash of each address is stored with its entry.</p>
      </section>
    </main>
  );
}
