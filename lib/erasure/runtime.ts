import "server-only";
import { currentAdminEmail } from "@/lib/admin/session";
import { env } from "@/lib/env";
import { defaultImagePath } from "@/lib/news/departments";
import type { EraseDeps } from "./erase";
import { supabaseEraseStore } from "./store";

/** The real dependencies of the "Delete a person's data" tool. Throws if the environment is invalid. */
export function eraseDeps(): EraseDeps {
  const e = env();
  return {
    store: supabaseEraseStore(),
    adminEmail: currentAdminEmail,
    // The same secret as the stored IP hashes, so no new secret has to be managed.
    secret: e.SUBMISSION_HASH_SALT ?? e.CRON_SECRET,
    defaultImage: (slug) => defaultImagePath(slug ?? undefined),
  };
}
