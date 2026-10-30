import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { describePurgeError, formatPurge, parsePurge, publicPhotoOf, runPurgeSample, type PurgeRaw, type PurgeStore } from "./purge-sample";
import { cronUrl, parseStageArgs } from "./stage-args";

// `npm run stage -- purge-sample [--apply]`: clearing the test content before the pilot.

const PUBLIC = "https://abc.supabase.co/storage/v1/object/public/article-images/aaaa.webp";

const FOUND: PurgeRaw = {
  apply: false,
  articles: [
    { id: "a1", headline: "SAMPLE: Pilot line", status: "published", origin: "ai", image_url: "/images/defaults/ev.svg" },
    { id: "a2", headline: "Test story from Ada", status: "pending_review", origin: "employee", image_url: PUBLIC },
    { id: "a3", headline: "Another draft", status: "draft", origin: "ai", image_url: null },
  ],
  submissions: 1,
  raw_items: 42,
  sources: [
    { id: "s1", name: "EV source 1 (placeholder)", rss_url: "https://example.com/replace-me/ev-1.xml" },
    { id: "s2", name: "EV source 2 (placeholder)", rss_url: "https://example.com/replace-me/ev-2.xml" },
  ],
  photo_paths: ["p1.webp"],
  deleted: { articles: 0, raw_items: 0, sources: 0 },
};

function fakeStore(over: Partial<PurgeStore> = {}) {
  const purge = vi.fn<PurgeStore["purge"]>(async (apply) => (apply ? { ...FOUND, apply: true, deleted: { articles: 3, raw_items: 42, sources: 2 } } : FOUND));
  const removePhotos = vi.fn<PurgeStore["removePhotos"]>(async () => ({ failed: 0 }));
  return { store: { purge, removePhotos, ...over } as PurgeStore, purge, removePhotos };
}

describe("runPurgeSample", () => {
  it("is a dry run by default: it asks the database to look, never to delete, and touches no file", async () => {
    const { store, purge, removePhotos } = fakeStore();
    const r = await runPurgeSample({}, store);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(false);
    expect(removePhotos).not.toHaveBeenCalled();
    expect(r.apply).toBe(false);
    expect(r.articles).toHaveLength(3);
    expect(r.photos).toEqual({ private: 1, public: 1 });
  });

  it("with apply it removes the photo files in both buckets first, then deletes the rows", async () => {
    const order: string[] = [];
    const { store } = fakeStore({
      purge: async (apply) => {
        order.push(apply ? "delete-rows" : "look");
        return apply ? { ...FOUND, apply: true, deleted: { articles: 3, raw_items: 42, sources: 2 } } : FOUND;
      },
      removePhotos: async (bucket, paths) => {
        order.push(`remove ${bucket}: ${paths.join(",")}`);
        return { failed: 0 };
      },
    });
    const r = await runPurgeSample({ apply: true }, store);
    expect(order).toEqual(["look", "remove private: p1.webp", "remove public: aaaa.webp", "delete-rows"]);
    expect(r).toMatchObject({ apply: true, deleted: { articles: 3, raw_items: 42, sources: 2 }, photos: { private: 1, public: 1 } });
  });

  it("deletes nothing when a photo file cannot be removed", async () => {
    const { store, purge } = fakeStore({ removePhotos: async (bucket) => ({ failed: bucket === "private" ? 1 : 0 }) });
    await expect(runPurgeSample({ apply: true }, store)).rejects.toThrow(/could not be removed from storage, so nothing was deleted/);
    expect(purge).not.toHaveBeenCalledWith(true);
  });

  it("does not touch storage when there are no photos", async () => {
    const { store, removePhotos } = fakeStore({ purge: async (apply) => ({ ...FOUND, apply, articles: [FOUND.articles[2]], photo_paths: [] }) });
    await runPurgeSample({ apply: true }, store);
    expect(removePhotos).not.toHaveBeenCalled();
  });

  it("tells you which file to run when the function is missing", async () => {
    const { store } = fakeStore({ purge: async () => Promise.reject(new Error("Could not find the function public.purge_sample_data(p_apply) in the schema cache")) });
    await expect(runPurgeSample({}, store)).rejects.toThrow(/2026-10-20_privacy_and_hardening\.sql/);
    expect(describePurgeError("connection reset")).toBe("connection reset");
  });

  it("treats only a public article-images URL as a public photo", () => {
    expect(publicPhotoOf(PUBLIC)).toBe("aaaa.webp");
    for (const v of ["/images/defaults/ev.svg", "https://images.unsplash.com/photo-1", null, "", "nonsense"]) expect(publicPhotoOf(v)).toBeNull();
  });

  it("reads the database's answer whatever its shape", () => {
    expect(parsePurge(null)).toEqual({ apply: false, articles: [], submissions: 0, raw_items: 0, sources: [], photo_paths: [], deleted: { articles: 0, raw_items: 0, sources: 0 } });
    expect(parsePurge({ apply: true, raw_items: "x", photo_paths: ["a", 3, ""], deleted: { articles: 2 } })).toMatchObject({ apply: true, raw_items: 0, photo_paths: ["a"], deleted: { articles: 2, raw_items: 0, sources: 0 } });
  });
});

describe("formatPurge", () => {
  const result = (over: Partial<Parameters<typeof formatPurge>[0]> = {}) => ({ ...FOUND, photos: { private: 1, public: 1 }, ...over });

  it("a dry run says nothing was deleted and how to do it, and lists everything that would go", () => {
    const text = formatPurge(result());
    expect(text).toMatch(/DRY RUN: nothing was deleted\)\. Run again with --apply/);
    expect(text).toContain("Articles: 3 (1 published, 1 pending review, 1 draft), 1 employee submission");
    expect(text).toContain("[published] SAMPLE: Pilot line");
    expect(text).toContain("[pending review, employee] Test story from Ada");
    expect(text).toContain("Test submissions: 1 submitter record");
    expect(text).toContain("Placeholder sources: 2");
    expect(text).toContain("EV source 1 (placeholder)  https://example.com/replace-me/ev-1.xml");
    expect(text).toContain("Raw items from example.com / placeholder sources: 42");
    expect(text).toContain("Photos in storage: 1 private, 1 public");
    expect(text).toMatch(/Selection rules:/);
  });

  it("after --apply it says what was deleted and what is kept", () => {
    const text = formatPurge(result({ apply: true, deleted: { articles: 3, raw_items: 42, sources: 2 } }));
    expect(text).toMatch(/^Sample data DELETED\./);
    expect(text).toContain("Deleted: 3 articles, 42 raw items, 2 sources, 2 photo files.");
    expect(text).toMatch(/Kept: departments, real sources/);
    expect(text).not.toMatch(/DRY RUN/);
  });

  it("a long list is cut, with the rest counted", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, headline: `SAMPLE ${i}`, status: "draft", origin: "ai" as const, image_url: null }));
    const text = formatPurge(result({ articles: many }));
    expect(text).toContain("... and 15 more");
    expect(text.split("\n").length).toBeLessThan(60);
  });

  it("says plainly when there is nothing", () => {
    const text = formatPurge({ ...FOUND, articles: [], submissions: 0, raw_items: 0, sources: [], photo_paths: [], photos: { private: 0, public: 0 } });
    expect(text).toContain("Articles: 0");
    expect(text).toContain("Placeholder sources: 0");
  });
});

describe("the command line and the route", () => {
  const STAGES = ["health", "cleanup", "purge-sample", "ingest"];
  const argv = (...a: string[]) => ["node", "run-stage.ts", ...a];

  it("purge-sample is a dry run without --apply and real with it", () => {
    expect(parseStageArgs(argv("purge-sample"), STAGES)).toEqual({ ok: true, stage: "purge-sample", apply: false });
    expect(parseStageArgs(argv("purge-sample", "--apply"), STAGES)).toEqual({ ok: true, stage: "purge-sample", apply: true });
    expect(parseStageArgs(argv("purge-sample", "--force"), STAGES)).toMatchObject({ ok: false });
    expect(parseStageArgs(argv("ingest", "--apply"), STAGES)).toMatchObject({ ok: false, error: expect.stringContaining("only for cleanup and purge-sample") });
  });

  it("only an applied purge-sample calls the route with ?apply=true", () => {
    expect(cronUrl("http://localhost:3000", "purge-sample", false)).toBe("http://localhost:3000/api/cron/purge-sample");
    expect(cronUrl("http://localhost:3000", "purge-sample", true)).toBe("http://localhost:3000/api/cron/purge-sample?apply=true");
    expect(cronUrl("http://localhost:3000", "ingest", true)).toBe("http://localhost:3000/api/cron/ingest");
  });

  it("the route is not scheduled: it is run by hand", () => {
    expect(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")).not.toContain("purge-sample");
    for (const f of ["pipeline.yml", "digest.yml"]) {
      expect(readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8")).not.toMatch(/purge-sample/);
    }
  });
});

describe("the SQL", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const files = ["supabase/migrations/2026-10-20_privacy_and_hardening.sql", "supabase/schema.sql"].map((p) => ({ p, text: read(p) }));

  it.each(files)("$p: purge_sample_data defaults to a dry run and only the service role may call it", ({ text }) => {
    expect(text).toMatch(/create or replace function public\.purge_sample_data\(p_apply boolean default false\)/);
    expect(text).toMatch(/revoke all on function public\.purge_sample_data\(boolean\) from public, anon, authenticated;/);
    expect(text).toMatch(/grant execute on function public\.purge_sample_data\(boolean\) to service_role;/);
  });

  it.each(files)("$p: the selection covers sample articles, example.com sources and test-address submissions, and spares anonymized people", ({ text }) => {
    expect(text).toContain("a.headline ilike 'sample%'");
    expect(text).toContain("a.slug ilike 'sample-%'");
    expect(text).toContain("example\\.(com|org|net)");
    expect(text).toContain("rss_url ilike 'https://example.com/replace-me/%'");
    expect(text).toMatch(/s\.anonymized_at is null and s\.email not like 'anonymized-%'/);
  });

  it("the seed inserts the placeholder sources inactive and the real world feeds active", () => {
    const seed = read("supabase/seed.sql");
    expect(seed).toMatch(/select s\.name, s\.rss_url, d\.id, false\nfrom \(values\n  \('EV source 1 \(placeholder\)'/);
    expect(seed).toMatch(/select s\.name, s\.rss_url, d\.id, true, null/);
    expect(seed).not.toMatch(/select s\.name, s\.rss_url, d\.id, true\nfrom \(values\n  \('EV source 1/);
  });
});
