"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isNotAuthorised, LOGIN_EXPIRED_PATH } from "@/lib/admin/messages";
import { finishMfaEnrolment, startMfaEnrolment } from "./actions";

type Step = { kind: "idle" } | { kind: "scan"; factorId: string; qr: string; secret: string } | { kind: "done" };

const btn = "rounded border px-3 py-1.5 text-sm";

export function EnrollMfa({ alreadyEnrolled }: { alreadyEnrolled: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(alreadyEnrolled ? { kind: "done" } : { kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** An expired session goes to the login page, like every other admin action. */
  function expired(message: string) {
    if (isNotAuthorised(message)) router.push(LOGIN_EXPIRED_PATH);
  }

  async function start() {
    setBusy(true);
    setError(null);
    const r = await startMfaEnrolment();
    setBusy(false);
    if (!r.ok) {
      expired(r.error);
      setError(r.error);
      return;
    }
    setStep({ kind: "scan", factorId: r.factorId, qr: r.qr, secret: r.secret });
  }

  async function finish(form: FormData) {
    if (step.kind !== "scan") return;
    setBusy(true);
    setError(null);
    const r = await finishMfaEnrolment(step.factorId, String(form.get("code") ?? ""));
    setBusy(false);
    if (!r.ok) {
      expired(r.error);
      setError(r.error);
      return;
    }
    setStep({ kind: "done" });
  }

  if (step.kind === "done") {
    return <p className="rounded bg-green-50 p-3 text-sm text-green-900">An authenticator app is set up for your account.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {step.kind === "idle" && (
        <button type="button" onClick={start} disabled={busy} className={`${btn} w-fit bg-zinc-900 text-white disabled:opacity-50`}>
          {busy ? "Starting…" : "Set up an authenticator app"}
        </button>
      )}
      {step.kind === "scan" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">Scan this code with an authenticator app (for example Microsoft Authenticator or Google Authenticator), then type the 6 digits it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={step.qr} alt="QR code for the authenticator app" width={192} height={192} className="rounded border bg-white p-2" />
          <p className="text-sm">
            Cannot scan? Type this key into the app: <code className="select-all break-all rounded bg-zinc-100 px-1">{step.secret}</code>
          </p>
          <form action={finish} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              6-digit code
              <input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required className="w-32 rounded border p-2 font-mono" />
            </label>
            <button disabled={busy} className={`${btn} bg-zinc-900 text-white disabled:opacity-50`}>
              {busy ? "Checking…" : "Confirm"}
            </button>
          </form>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
