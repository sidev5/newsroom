import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * Service-role client. Bypasses RLS, so it must only run on the server
 * (cron routes, server actions after an admin check). `server-only` makes
 * importing this from a client component a build error.
 */
export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    const e = env();
    client = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
