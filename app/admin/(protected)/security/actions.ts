"use server";

import { revalidatePath } from "next/cache";
import { NOT_AUTHORISED } from "@/lib/admin/messages";
import { currentAdminEmail } from "@/lib/admin/session";
import { supabaseServer } from "@/lib/supabase/server";

// Optional two-factor sign-in (authenticator app). Every action re-checks the admin first.

export type StartResult = { ok: true; factorId: string; qr: string; secret: string } | { ok: false; error: string };
export type FinishResult = { ok: true } | { ok: false; error: string };

/** Starts enrolling an authenticator app: returns the QR code and the secret to type in by hand. */
export async function startMfaEnrolment(): Promise<StartResult> {
  if (!(await currentAdminEmail())) return { ok: false, error: NOT_AUTHORISED };
  const supabase = await supabaseServer();
  try {
    // Leftovers of an earlier, unfinished attempt would otherwise pile up.
    const existing = await supabase.auth.mfa.listFactors();
    for (const f of existing.data?.all ?? []) {
      if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "Company Newsroom", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (error || !data) return { ok: false, error: "Could not start the setup. Please try again." };
    return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
  } catch (err) {
    console.error(`mfa enrol failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "Could not start the setup. Please try again." };
  }
}

/** Confirms the enrolment with the 6-digit code from the app. */
export async function finishMfaEnrolment(factorId: string, code: string): Promise<FinishResult> {
  if (!(await currentAdminEmail())) return { ok: false, error: NOT_AUTHORISED };
  if (!/^\d{6}$/.test(code.trim())) return { ok: false, error: "Enter the 6 digits shown in your authenticator app." };
  const supabase = await supabaseServer();
  try {
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) return { ok: false, error: "Could not check the code. Start the setup again." };
    const verified = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: code.trim() });
    if (verified.error) return { ok: false, error: "That code is not right. Check the time on your phone and try the next code." };
    revalidatePath("/admin/security");
    return { ok: true };
  } catch (err) {
    console.error(`mfa verify failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "Could not check the code. Please try again." };
  }
}
