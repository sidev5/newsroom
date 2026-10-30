import "server-only";
import { STORAGE_BUCKETS } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parsePurge, type PurgeStore } from "./purge-sample";

/** Calls public.purge_sample_data with the service role (the function is not granted to anyone else). */
export function supabasePurgeStore(): PurgeStore {
  return {
    async purge(apply) {
      const { data, error } = await supabaseAdmin().rpc("purge_sample_data", { p_apply: apply });
      if (error) throw new Error(error.message);
      return parsePurge(data);
    },

    async removePhotos(bucket, paths) {
      const name = bucket === "private" ? STORAGE_BUCKETS.submissions : STORAGE_BUCKETS.published;
      let failed = 0;
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await supabaseAdmin().storage.from(name).remove(paths.slice(i, i + 100));
        if (error) failed += Math.min(100, paths.length - i);
      }
      return { failed };
    },
  };
}