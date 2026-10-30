import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { ImageSearchError, type ImageProvider, type ImageResult } from "@/lib/images/types";
import { parseStoredDoc, type BlocksDoc } from "@/lib/stories/blocks";
import { fillImagePlaceholders, runImage, type ImageArticle, type ImageUpdate } from "./image";

// The image stage for an AI-written blocks story: the cover through the existing search, and every picture placeholder in the
// text through the same search, with the credit stored on the block as it is for a cover. No result: the block is dropped.

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: "test-secret-0123456789",
    BATCH_LIMIT: "10",
    STAGE_CHUNK_SIZE: "5",
    STAGE_DELAY_MS: "0",
  });
  resetEnvCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const photo = (n: number, credit = `Photographer ${n}`): ImageResult => ({
  url: `https://images.unsplash.com/photo-${n}?ixid=x`,
  credit,
  creditUrl: `https://unsplash.com/@p${n}?utm_source=ai_newsroom&utm_medium=referral`,
});

/** A provider that answers by query: a result, null (nothing found), or an error. */
function provider(answers: Record<string, ImageResult | null | "429" | "500">) {
  const searched: string[] = [];
  const p: ImageProvider = {
    name: "unsplash",
    async searchImage(query) {
      searched.push(query);
      const a = answers[query];
      if (a === "429") throw new ImageSearchError("HTTP 429", 429);
      if (a === "500") throw new ImageSearchError("HTTP 500", 500);
      return a ?? null;
    },
  };
  return { p, searched };
}

const text = { id: "t", type: "paragraph", text: "Some reading text for the story." };
const slot = (id: string, query: string, caption = `Caption ${id}`) => ({ id, type: "image", query, alt: `Alt text for ${id}`, caption });
const doc = (...blocks: unknown[]): BlocksDoc => ({ v: 1, blocks: [text, ...blocks] }) as BlocksDoc;
const imagesOf = (d: BlocksDoc) => d.blocks.filter((b) => b.type === "image");

function harness(articles: ImageArticle[], p: ImageProvider) {
  const saved: { id: string; update: ImageUpdate }[] = [];
  return {
    saved,
    deps: {
      loadArticles: async (n: number) => articles.slice(0, n),
      updateArticle: async (id: string, update: ImageUpdate) => void saved.push({ id, update }),
      provider: () => p,
    },
  };
}
const blocksArticle = (id: string, d: BlocksDoc, over: Partial<ImageArticle> = {}): ImageArticle => ({ id, image_query: "cover query", department_slug: "software", blocks: d, ...over });

describe("fillImagePlaceholders", () => {
  it("replaces each placeholder with the found photo, its address and its credit, and removes the search phrase", async () => {
    const { p, searched } = provider({ "server room": photo(1), "laptop code": photo(2) });
    const r = await fillImagePlaceholders(doc(slot("a", "server room"), { id: "m", type: "paragraph", text: "More reading text here." }, slot("b", "laptop code")), p);
    expect(searched).toEqual(["server room", "laptop code"]);
    expect(r).toMatchObject({ placed: 2, dropped: 0, rateLimited: false });
    expect(imagesOf(r.doc)).toEqual([
      { id: "a", type: "image", src: photo(1).url, alt: "Alt text for a", caption: "Caption a", credit: "Photographer 1", creditUrl: photo(1).creditUrl },
      { id: "b", type: "image", src: photo(2).url, alt: "Alt text for b", caption: "Caption b", credit: "Photographer 2", creditUrl: photo(2).creditUrl },
    ]);
    expect(r.doc.blocks.map((b) => b.id)).toEqual(["t", "a", "m", "b"]); // the order of the story is kept
    expect(parseStoredDoc(r.doc)).not.toBeNull();
  });

  it("drops a placeholder when nothing is found, and when a search fails for another reason", async () => {
    const { p } = provider({ none: null, broken: "500", ok: photo(3) });
    const r = await fillImagePlaceholders(doc(slot("a", "none"), slot("b", "broken"), slot("c", "ok")), p);
    expect(r).toMatchObject({ placed: 1, dropped: 2 });
    expect(imagesOf(r.doc).map((b) => b.id)).toEqual(["c"]);
  });

  it("drops a picture that repeats one already used in the story or as the cover", async () => {
    const { p } = provider({ one: photo(1), two: photo(1), three: photo(9) });
    const r = await fillImagePlaceholders(doc(slot("a", "one"), slot("b", "two"), slot("c", "three")), p, [photo(9).url]);
    expect(imagesOf(r.doc).map((b) => b.id)).toEqual(["a"]);
    expect(r).toMatchObject({ placed: 1, dropped: 2 });
  });

  it("cuts a very long credit instead of losing the picture", async () => {
    const { p } = provider({ q: photo(1, "N".repeat(300)) });
    const r = await fillImagePlaceholders(doc(slot("a", "q")), p);
    expect(r.placed).toBe(1);
    expect((imagesOf(r.doc)[0] as { credit: string }).credit).toHaveLength(200);
  });

  it("reports a 429 and changes nothing", async () => {
    const { p } = provider({ a: photo(1), b: "429" });
    const input = doc(slot("x", "a"), slot("y", "b"));
    const r = await fillImagePlaceholders(input, p);
    expect(r).toMatchObject({ rateLimited: true, placed: 0 });
    expect(r.doc).toBe(input);
  });

  it("leaves a story without placeholders alone, and does not search", async () => {
    const { p, searched } = provider({});
    const d = doc({ id: "a", type: "image", src: photo(1).url, alt: "Already placed", caption: "" });
    const r = await fillImagePlaceholders(d, p);
    expect(searched).toEqual([]);
    expect(imagesOf(r.doc)).toHaveLength(1);
  });
});

describe("runImage with blocks stories", () => {
  it("fills the cover and the pictures in the text, and saves them together in one update", async () => {
    const { p } = provider({ "cover query": photo(10), "server room": photo(11), "laptop code": null });
    const h = harness([blocksArticle("a1", doc(slot("a", "server room"), slot("b", "laptop code")))], p);
    const counts = await runImage(h.deps);
    expect(counts).toEqual({ processed: 1, found: 1, fallback: 0, failed: 0, deferred: 0, blockImages: { placed: 1, dropped: 1 } });
    expect(h.saved).toHaveLength(1);
    const u = h.saved[0].update;
    expect(u).toMatchObject({ image_url: photo(10).url, image_credit: "Photographer 10", image_credit_url: photo(10).creditUrl });
    const stored = parseStoredDoc(u.body_blocks)!;
    expect(imagesOf(stored)).toEqual([expect.objectContaining({ id: "a", src: photo(11).url, credit: "Photographer 11" })]);
    expect(JSON.stringify(stored)).not.toContain('"query"'); // no placeholder is left
  });

  it("when the cover is not found the department default is used, and the pictures in the text are still placed", async () => {
    const { p } = provider({ "cover query": null, "server room": photo(11) });
    const h = harness([blocksArticle("a1", doc(slot("a", "server room")))], p);
    const counts = await runImage(h.deps);
    expect(counts).toMatchObject({ processed: 1, found: 0, fallback: 1, blockImages: { placed: 1, dropped: 0 } });
    expect(h.saved[0].update).toMatchObject({ image_url: "/images/defaults/software.svg", image_credit: null });
    expect(imagesOf(h.saved[0].update.body_blocks!)).toHaveLength(1);
  });

  it("a story whose pictures are all dropped is still saved, with its text, and leaves the queue", async () => {
    const { p } = provider({ "cover query": photo(10), a: null, b: null });
    const h = harness([blocksArticle("a1", doc(slot("x", "a"), slot("y", "b")))], p);
    expect(await runImage(h.deps)).toMatchObject({ processed: 1, blockImages: { placed: 0, dropped: 2 } });
    expect(imagesOf(h.saved[0].update.body_blocks!)).toEqual([]);
    expect(h.saved[0].update.body_blocks!.blocks[0]).toMatchObject({ type: "paragraph" });
  });

  it("a blocks story without placeholders gets only its cover, with no change to its blocks", async () => {
    const { p, searched } = provider({ "cover query": photo(10) });
    const h = harness([blocksArticle("a1", doc())], p);
    await runImage(h.deps);
    expect(searched).toEqual(["cover query"]);
    expect(h.saved[0].update).not.toHaveProperty("body_blocks");
  });

  it("on a 429 in the text pictures the story stays queued (it is not saved, not given a default), and the run stops", async () => {
    const { p } = provider({ "cover query": photo(10), "server room": "429" });
    const report = { rateLimited: false };
    const h = harness([blocksArticle("a1", doc(slot("a", "server room")))], p);
    const counts = await runImage(h.deps, {}, report);
    expect(counts).toMatchObject({ processed: 0, deferred: 1, failed: 0 });
    expect(h.saved).toEqual([]);
    expect(report.rateLimited).toBe(true);
  });

  it("on a 429 in the cover search a blocks story with pictures to find is deferred too, while a plain article takes its default as before", async () => {
    const { p, searched } = provider({ "cover query": "429", "plain query": photo(5) });
    const h = harness(
      [blocksArticle("a1", doc(slot("a", "server room"))), { id: "p1", image_query: "plain query", department_slug: "ev" }, blocksArticle("a2", doc(slot("b", "laptop code")))],
      p,
    );
    const counts = await runImage(h.deps);
    expect(counts).toMatchObject({ processed: 1, fallback: 1, deferred: 2 });
    expect(h.saved.map((s) => s.id)).toEqual(["p1"]);
    expect(h.saved[0].update).toMatchObject({ image_url: "/images/defaults/ev.svg" });
    expect(searched).toEqual(["cover query"]); // nothing else was searched after the 429
  });

  it("a plain article is unchanged: no blocks in its update", async () => {
    const { p } = provider({ q: photo(1) });
    const h = harness([{ id: "p1", image_query: "q", department_slug: "ev" }], p);
    expect(await runImage(h.deps)).toMatchObject({ processed: 1, found: 1, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(h.saved[0].update).toEqual({ image_url: photo(1).url, image_credit: "Photographer 1", image_credit_url: photo(1).creditUrl });
  });
});
