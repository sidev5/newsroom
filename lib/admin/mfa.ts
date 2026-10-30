// Optional second factor (TOTP authenticator app) for admins. Not required yet: the admin pages only show a note
// while no verified factor is enrolled.

type FactorLists = { data: { totp?: { status?: string }[]; all?: { status?: string; factor_type?: string; id?: string }[] } | null; error: unknown };

export type MfaClient = { auth: { mfa: { listFactors: () => Promise<FactorLists> } } };

/** True if the signed-in user has a verified TOTP factor, false if not, null if Supabase could not say. */
export async function hasVerifiedFactor(client: MfaClient): Promise<boolean | null> {
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error || !data) return null;
    // listFactors().data.totp holds only verified factors; fall back to `all` for older shapes.
    const verified = (data.totp ?? data.all?.filter((f) => f.factor_type === "totp") ?? []).filter((f) => f.status === "verified");
    return verified.length > 0;
  } catch {
    return null;
  }
}

export const MFA_NOTE =
  "No second factor is set up for your account. Adding an authenticator app protects the admin area if your password is ever stolen. It is optional for now.";
