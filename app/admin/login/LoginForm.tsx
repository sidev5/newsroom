"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ notice }: { notice: string | null }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      {notice && (
        <p role="status" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
          {notice}
        </p>
      )}
      <input name="email" type="email" required autoComplete="email" placeholder="Email" className="rounded border p-2" />
      <input name="password" type="password" required autoComplete="current-password" placeholder="Password" className="rounded border p-2" />
      <button disabled={pending} className="rounded bg-black px-3 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black">
        {pending ? "Signing in..." : "Sign in"}
      </button>
      {state?.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
    </form>
  );
}
