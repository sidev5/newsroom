import { headers } from "next/headers";
import { EXPIRED_MESSAGE } from "@/lib/admin/messages";
import { INSECURE_LAN_WARNING, insecureLanRequest } from "@/lib/admin/network";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function AdminLogin({ searchParams }: PageProps<"/admin/login">) {
  const { reason } = await searchParams;
  const insecure = insecureLanRequest(await headers());
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Admin sign in</h1>
      {insecure && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
          {INSECURE_LAN_WARNING}
        </p>
      )}
      <LoginForm notice={reason === "expired" ? EXPIRED_MESSAGE : null} />
    </main>
  );
}
