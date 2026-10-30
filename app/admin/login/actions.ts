"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_ACTIVITY_COOKIE, adminLimits, markerCookieOptions, markerSecret, signMarker } from "@/lib/admin/activity";
import { isAdminEmail } from "@/lib/admin/auth";
import { adminAllowed } from "@/lib/admin/network";
import { env } from "@/lib/env";
import { isHttps } from "@/lib/supabase/cookies";
import { supabaseServer } from "@/lib/supabase/server";

export type LoginState = { error: string } | null;

/**
 * Signs in on the server, so the session cookies are written by the server (HttpOnly, SameSite=Lax, Secure on
 * https, lifetime capped) and the activity marker starts here. Only addresses on ADMIN_EMAILS are let in.
 */
export async function loginAction(_previous: LoginState, form: FormData): Promise<LoginState> {
  // A server action can be posted to any path, so the proxy's /admin rule is checked again here.
  if (!adminAllowed(await headers())) return { error: "Sign-in is only available on the server PC." };
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const secret = markerSecret();
  if (!secret) return { error: "Sign-in is not available: the server has no session secret (CRON_SECRET must be at least 16 characters)." };

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "That email and password do not match." };

  if (!isAdminEmail(data.user.email, env().ADMIN_EMAILS)) {
    await supabase.auth.signOut();
    return { error: "This account is not an administrator." };
  }

  const now = Date.now();
  const limits = adminLimits();
  const secure = isHttps((await headers()).get("x-forwarded-proto"));
  (await cookies()).set(ADMIN_ACTIVITY_COOKIE, await signMarker(secret, { start: now, last: now }), markerCookieOptions(secure, limits));
  redirect("/admin/review");
}
