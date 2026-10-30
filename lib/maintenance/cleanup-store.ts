import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { STORAGE_BUCKETS } from "@/lib/config";
import { parseCounts, parsePrivacy, type CleanupStore } from "./cleanup";

/** Calls public.run_retention with the service role (the function is not granted to anyone else). */
export function supabaseCleanupStore(): CleanupStore {
  return {
    async retention({ apply, fullTextDays, rawItemDays, runLogMonths, now }) {
      const { data, error } = await supabaseAdmin().rpc("run_retention", {
        p_apply: apply,
        p_full_text_days: fullTextDays,
        p_raw_item_days: rawItemDays,
        p_run_months: runLogMonths,
        p_now: now.toISOString(),
      });
      if (error) throw new Error(error.message);
      return parseCounts(data);
    },

    async privacy({ apply, ipDays, emailDays, now }) {
      const { data, error } = await supabaseAdmin().rpc("run_privacy_retention", {
        p_apply: apply,
        p_ip_days: ipDays,
        p_email_days: emailDays,
        p_now: now.toISOString(),
      });
      if (error) throw new Error(error.message);
      return parsePrivacy(data);
    },

    async removePrivatePhotos(paths) {
      let removed = 0;
      let failed = 0;
      // in batches: the storage API takes a list, and one bad batch should not hide the others
      for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100);
        const { data, error } = await supabaseAdmin().storage.from(STORAGE_BUCKETS.submissions).remove(batch);
        if (error) failed += batch.length;
        else removed += data?.length ?? batch.length; // a path that is already gone is not an error
      }
      return { removed, failed };
    },
  };
}
