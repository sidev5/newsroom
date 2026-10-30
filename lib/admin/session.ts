import "server-only";
import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { ADMIN_ACTIVITY_COOKIE, adminLimits, checkActivity, markerSecret } from "./activity";
import { isAdminEmail } from "./auth";
import { adminAllowed, adminNetwork } from "./network";

/** True when the admin activity marker is present, genuine and inside both limits (idle and absolute). */
async function activityIsCurrent(): Promise<boolean> {
  const value = (await cookies()).get(ADMIN_ACTIVITY_COOKIE)?.value;
  return (await checkActivity(markerSecret(), value, Date.now(), adminLimits())).ok;
}

/**
 * Email of the signed-in user if they are on ADMIN_EMAILS and their admin session is still within the idle
 * and absolute limits, else null. Uses getUser(), which asks Supabase to validate the token, not just decode
 * the cookie. The proxy enforces the same limits first; this is the second check inside every page and action.
 */
export async function currentAdminEmail(): Promise<string | null> {
  // Admin actions can be posted to any path, outside the proxy's matcher: the network rule is checked here too.
  if (adminNetwork() === "localhost" && !adminAllowed(await headers())) return null;
  const { data } = await (await supabaseServer()).auth.getUser();
  const email = data.user?.email ?? null;
  if (!isAdminEmail(email, env().ADMIN_EMAILS)) return null;
  return (await activityIsCurrent()) ? email : null;
}

/** Signed-in user's email regardless of admin status (to tell "not logged in" from "not an admin"). */
export async function currentUserEmail(): Promise<string | null> {
  const { data } = await (await supabaseServer()).auth.getUser();
  return data.user?.email ?? null;
}
