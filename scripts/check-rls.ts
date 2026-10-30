// npm run check-rls: connects with the PUBLIC (anon) key and prints what it can read, table by table. It must be nothing except
// the published rows of `articles` (their granted columns only) and the department names. Read only; row contents are never printed.
// Run it after every migration and after the first deploy. Exit code 1 if the public key can read something it should not.
import { createClient } from "@supabase/supabase-js";
import { loadEnvConfig } from "@next/env";
import { formatRls, runRlsCheck, type RlsProbe } from "../lib/admin/rls-check";

loadEnvConfig(process.cwd(), true);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anon) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (.env.local).");
  process.exit(1);
}

const publicClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const probe: RlsProbe = {
  async select(table, columns) {
    const { data, error } = await publicClient.from(table).select(columns).limit(5);
    return { rows: (data ?? []) as unknown as Record<string, unknown>[], error: error ? { code: error.code, message: error.message } : null };
  },
  // Only to tell "protected by RLS" from "simply empty": a head count with the service role, nothing is changed.
  serviceCount: service
    ? async (table) => {
        const { count, error } = await service.from(table).select("*", { count: "exact", head: true });
        return error ? null : (count ?? 0);
      }
    : undefined,
};

async function main() {
  console.log(`Checking what the public key can read at ${new URL(url!).host}\n`);
  const { results, ok } = await runRlsCheck(probe);
  console.log(formatRls(results));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
