import { notFound } from "next/navigation";
import { adminLimits } from "@/lib/admin/activity";
import { hasVerifiedFactor } from "@/lib/admin/mfa";
import { currentAdminEmail } from "@/lib/admin/session";
import { supabaseServer } from "@/lib/supabase/server";
import { EnrollMfa } from "./EnrollMfa";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  // Layouts don't protect pages on their own.
  if (!(await currentAdminEmail())) notFound();
  const limits = adminLimits();
  const enrolled = await hasVerifiedFactor(await supabaseServer());

  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Security</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Session limits</h2>
        <p className="text-sm text-zinc-700">
          You are signed out after {limits.idleMs / 60_000} minutes without using an admin page, and at most {limits.absoluteMs / 3_600_000} hours after signing in,
          whichever comes first. Both limits are set by <code>ADMIN_IDLE_MINUTES</code> and <code>ADMIN_SESSION_HOURS</code>.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Second factor (optional)</h2>
        <p className="text-sm text-zinc-700">
          An authenticator app adds a one-time code to your account. It is not required yet. Having one set up means a stolen password alone is not enough once the
          newsroom starts to require it.
        </p>
        {enrolled === null ? (
          <p className="text-sm text-zinc-500">The status could not be read right now.</p>
        ) : (
          <EnrollMfa alreadyEnrolled={enrolled} />
        )}
      </section>
    </main>
  );
}
