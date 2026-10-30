import { createClient } from "@supabase/supabase-js";
import { checkSchema, type SchemaProbe } from "@/lib/admin/schema-check";
import { rejectUnlessCron } from "@/lib/cron-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function probe(): SchemaProbe {
  const db = supabaseAdmin();
  return {
    async table(table) {
      const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
      return { error, count };
    },
    async columns(table, columns) {
      const { error } = await db.from(table).select(columns.join(", ")).limit(0);
      return { error };
    },
    async bucket(id) {
      const { data, error } = await db.storage.getBucket(id);
      // A bucket that does not exist comes back as an error with status 404 / "not found".
      if (error && /not found|does not exist|404/i.test(`${error.message} ${(error as { status?: number }).status ?? ""}`)) {
        return { error: null, found: false, isPublic: false };
      }
      return { error, found: Boolean(data), isPublic: data?.public ?? false };
    },
    async anonArticleColumns(columns) {
      // A client with the PUBLIC key, exactly what a visitor of the REST API has.
      const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
      const { error } = await anon.from("articles").select(columns.join(", ")).limit(0);
      return { error };
    },
    async department(slug) {
      const { data, error } = await db.from("departments").select("id").eq("slug", slug).limit(1);
      return { error, found: (data?.length ?? 0) > 0 };
    },
  };
}

/**
 * Setup check: confirms the cron secret, the service-role connection, that every table and the newer
 * columns exist, that both storage buckets exist with the right visibility, and that the AI & Technology
 * department is there. Anything missing is reported with the file that creates it (HTTP 200, ok: false);
 * only an unexpected database error is a 500. Not scheduled.
 */
export async function GET(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  const report = await checkSchema(probe());
  return Response.json(
    {
      ok: report.ok,
      counts: report.counts,
      ...(report.message ? { message: report.message } : {}),
      ...(report.missingTables.length ? { missing: report.missingTables } : {}),
      ...(report.missingColumns.length ? { missingColumns: report.missingColumns } : {}),
      ...(report.bucketProblems.length ? { bucketProblems: report.bucketProblems } : {}),
      ...(report.missingRows.length ? { missingRows: report.missingRows } : {}),
      ...(report.grantProblems.length ? { grantProblems: report.grantProblems } : {}),
      ...(report.failed ? { failed: true } : {}),
    },
    { status: report.failed ? 500 : 200 },
  );
}
