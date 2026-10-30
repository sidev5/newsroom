import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Anon-key client with no session and no cookies, for the public pages. Reading request cookies makes a page
 * dynamic, so the cached homepage and article pages (revalidate = 60) must not use `supabaseServer`.
 * It is subject to the same RLS and column grants: it sees published articles and department names only.
 */
export function supabasePublic() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
