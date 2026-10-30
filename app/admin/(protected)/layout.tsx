import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/lib/admin/auth";
import { LOGIN_EXPIRED_PATH } from "@/lib/admin/messages";
import { hasVerifiedFactor, MFA_NOTE } from "@/lib/admin/mfa";
import { currentAdminEmail, currentUserEmail } from "@/lib/admin/session";
import { env } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { AlertBanners } from "./AlertBanners";
import { signOutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentAdminEmail();
  if (!admin) {
    const user = await currentUserEmail();
    if (!user) redirect("/admin/login");
    // A real admin whose session is past the idle or absolute limit signs in again; anyone else is told they may not enter.
    if (isAdminEmail(user, env().ADMIN_EMAILS)) redirect(LOGIN_EXPIRED_PATH);
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-xl font-semibold">Not authorised</h1>
        <p className="mt-2">Your account is not on the admin list.</p>
        <form action={signOutAction} className="mt-4">
          <button className="rounded border px-3 py-1.5 text-sm">Sign out</button>
        </form>
      </main>
    );
  }
  const mfa = await hasVerifiedFactor(await supabaseServer());
  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <nav className="mb-6 flex items-center gap-4 border-b pb-3 text-sm">
        <Link href="/admin/review">Review</Link>
        <Link href="/admin/digest">Digest</Link>
        <Link href="/admin/costs">Costs</Link>
        <Link href="/admin/privacy">Privacy</Link>
        <Link href="/admin/security">Security</Link>
        <span className="ml-auto text-zinc-500">{admin}</span>
        <form action={signOutAction}>
          <button className="rounded border px-3 py-1 text-sm">Sign out</button>
        </form>
      </nav>
      {mfa === false && (
        <p className="mb-6 rounded bg-amber-50 p-3 text-sm text-amber-900">
          {MFA_NOTE}{" "}
          <Link href="/admin/security" className="font-medium underline">
            Set it up
          </Link>
        </p>
      )}
      <div id="main-content" tabIndex={-1}>
        <AlertBanners />
        {children}
      </div>
    </div>
  );
}
