import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../../test/fake-supabase";

// Approving a Write story: its images are copied from the private bucket to the public one and the blocks are rewritten, or the
// story stays pending. Runs the real code against an in-memory database and a stand-in for storage.

const world = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => world.db }));

import { approveArticle, saveArticleEdits, type ReviewDeps } from "@/lib/admin/review";
import { blockImageUrls, isBlocksArticle, publishPhotoPatch } from "@/lib/submissions/admin";
import { parseStoredDoc, type BlocksDoc } from "./blocks";

const PUBLIC = "https://proj.supabase.co/storage/v1/object/public/article-images/";
const PROSE = "The pilot line reached its first production milestone this quarter, with output rising steadily. ".repeat(3).trim();

type Storage = { private: Map<string, Uint8Array>; public: Map<string, Uint8Array>; removed: string[]; failUpload: boolean; failDownload: string | null };
let fake: FakeSupabase;
let storage: Storage;

function install(articles: Record<string, unknown>[], submitters: Record<string, unknown>[] = []) {
  fake = createFakeSupabase({ articles, article_submitters: submitters });
  storage = { private: new Map(), public: new Map(), removed: [], failUpload: false, failDownload: null };
  const bucket = (name: string) => ({
    async download(path: string) {
      const data = storage.private.get(path);
      if (name !== "submission-images" || !data || storage.failDownload === path) return { data: null, error: { message: "not found" } };
      return { data: { arrayBuffer: async () => data.buffer }, error: null };
    },
    async upload(path: string, body: Buffer) {
      if (storage.failUpload) return { error: { message: "storage down" } };
      storage.public.set(path, new Uint8Array(body));
      return { error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `${PUBLIC}${path}` } }),
    async remove(paths: string[]) {
      storage.removed.push(...paths);
      for (const p of paths) storage.public.delete(p);
      return { error: null };
    },
    async createSignedUrl(path: string) {
      return storage.private.has(path) ? { data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/submission-images/${path}?token=t` }, error: null } : { data: null, error: { message: "gone" } };
    },
  });
  world.db = { from: fake.client.from, storage: { from: bucket } };
}

const doc = (...extra: unknown[]): BlocksDoc => ({ v: 1, blocks: [{ id: "p", type: "paragraph", text: PROSE }, ...extra] }) as BlocksDoc;
const image = (id: string, path: string, over: Record<string, unknown> = {}) => ({ id, type: "image", path, alt: `alt ${id}`, caption: "", width: 800, height: 600, ...over });
const story = (blocks: BlocksDoc, over: Record<string, unknown> = {}) => ({ id: "a1", origin: "employee", status: "pending_review", body_format: "blocks", body_blocks: blocks, body: PROSE, summary: "Author summary", headline: "Headline", image_url: "/images/defaults/ev.svg", ...over });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co"; // the card's picture must be on the project's own public bucket
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("publishPhotoPatch for a Write story", () => {
  it("copies every private image to the public bucket, rewrites the blocks, and uses the first image on the card", async () => {
    install([story(doc(image("i1", "s/i1.webp"), image("i2", "s/i2.webp")))]);
    storage.private.set("s/i1.webp", new Uint8Array([1])).set("s/i2.webp", new Uint8Array([2]));
    const patch = await publishPhotoPatch("a1");
    expect(storage.public.size).toBe(2);
    const stored = parseStoredDoc(patch.body_blocks)!;
    const images = stored.blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    for (const b of images) {
      expect(b).not.toHaveProperty("path"); // the private path is gone from what the public can read
      expect((b as { src: string }).src.startsWith(PUBLIC)).toBe(true);
      expect((b as { src: string }).src).toMatch(/\.webp$/);
    }
    expect(patch).toMatchObject({ body_format: "blocks", image_url: (images[0] as { src: string }).src, image_alt: "alt i1" });
    expect(JSON.stringify(patch)).not.toContain("s/i1.webp");
    expect(images[0]).toMatchObject({ width: 800, height: 600, alt: "alt i1" }); // sizes and descriptions are kept
  });

  it("keeps a photo the story already has on its card, and does not copy an image that is already public", async () => {
    const publicUrl = `${PUBLIC}old.webp`;
    install([story(doc(image("i1", "s/i1.webp"), { id: "i2", type: "image", src: publicUrl, alt: "old", caption: "" }), { image_url: `${PUBLIC}card.webp` })]);
    storage.private.set("s/i1.webp", new Uint8Array([1]));
    const patch = await publishPhotoPatch("a1");
    expect(storage.public.size).toBe(1); // only the private one was copied
    expect(patch).not.toHaveProperty("image_url");
    const images = parseStoredDoc(patch.body_blocks)!.blocks.filter((b) => b.type === "image") as { src: string }[];
    expect(images[1].src).toBe(publicUrl);
  });

  it("a story without images changes nothing but is still written as blocks", async () => {
    install([story(doc())]);
    const patch = await publishPhotoPatch("a1");
    expect(patch).toEqual({ body_blocks: { v: 1, blocks: [{ id: "p", type: "paragraph", text: PROSE }] }, body_format: "blocks" });
  });

  it("throws when an image cannot be read, so the story stays pending", async () => {
    install([story(doc(image("i1", "s/i1.webp")))]);
    await expect(publishPhotoPatch("a1")).rejects.toThrow(/reading an image failed/);
    expect(storage.public.size).toBe(0);
  });

  it("throws when the copy fails and removes the images already copied", async () => {
    install([story(doc(image("i1", "s/i1.webp"), image("i2", "s/i2.webp")))]);
    storage.private.set("s/i1.webp", new Uint8Array([1])).set("s/i2.webp", new Uint8Array([2]));
    let n = 0;
    const real = (world.db as { storage: { from: (b: string) => { upload: (p: string, b: Buffer) => Promise<{ error: unknown }> } } }).storage.from;
    (world.db as { storage: { from: unknown } }).storage.from = (name: string) => {
      const b = real(name);
      const upload = b.upload;
      b.upload = async (p, body) => (++n === 2 ? { error: { message: "storage down" } } : upload(p, body));
      return b;
    };
    await expect(publishPhotoPatch("a1")).rejects.toThrow(/copying an image failed/);
    expect(storage.removed).toHaveLength(1);
    expect(storage.public.size).toBe(0);
  });

  it("an AI article, a plain employee story and a missing article are not touched", async () => {
    install([
      { id: "ai", origin: "ai", status: "pending_review" },
      { id: "plain", origin: "employee", status: "pending_review", body_format: "plain", image_url: "/images/defaults/ev.svg" },
    ]);
    expect(await publishPhotoPatch("ai")).toEqual({});
    expect(await publishPhotoPatch("plain")).toEqual({});
    expect(await publishPhotoPatch("nope")).toEqual({});
  });

  it("refuses a story whose stored blocks are not valid, rather than publishing something unknown", async () => {
    install([story({ v: 1, blocks: [{ id: "x", type: "script", src: "https://evil.example/a.js" }] } as unknown as BlocksDoc)]);
    await expect(publishPhotoPatch("a1")).rejects.toThrow(/could not be read/);
  });
});

describe("the admin's view of a pending Write story", () => {
  it("asks whether an article is a Write story, and says no on any error", async () => {
    install([story(doc()), { id: "ai", origin: "ai" }]);
    expect(await isBlocksArticle("a1")).toBe(true);
    expect(await isBlocksArticle("ai")).toBe(false);
    (world.db as { from: unknown }).from = () => {
      throw new Error("db down");
    };
    expect(await isBlocksArticle("a1")).toBe(false);
  });

  it("signs a link for each private image, by block id, and leaves out one that is gone", async () => {
    install([]);
    storage.private.set("s/i1.webp", new Uint8Array([1]));
    const urls = await blockImageUrls(doc(image("i1", "s/i1.webp"), image("i2", "s/missing.webp"), { id: "i3", type: "image", src: `${PUBLIC}x.webp`, alt: "a", caption: "" }));
    expect(Object.keys(urls)).toEqual(["i1"]);
    expect(urls.i1).toContain("/sign/submission-images/s/i1.webp");
  });
});

describe("approving and saving a Write story through the review code", () => {
  const deps = (over: Partial<ReviewDeps> = {}) => {
    const updates: { id: string; patch: Record<string, unknown> }[] = [];
    const d: ReviewDeps = {
      adminEmail: async () => "editor@example.com",
      update: async (id, patch) => {
        updates.push({ id, patch });
        return 1;
      },
      unpublish: async () => 1,
      log: async () => {},
      now: () => new Date("2026-10-22T10:00:00Z"),
      beforePublish: async () => ({}),
      isBlocks: async () => true,
      ...over,
    };
    return { d, updates };
  };

  it("approve with edits changes the headline only: the author's blocks, text and summary are left alone", async () => {
    const { d, updates } = deps();
    expect(await approveArticle("a1", { headline: "A better headline", body: "Some other text that the form posted" }, d)).toEqual({ ok: true });
    expect(updates[0].patch).toEqual({ status: "published", published_at: "2026-10-22T10:00:00.000Z", headline: "A better headline" });
  });

  it("approve of a plain story still saves the edited body and a new summary", async () => {
    const { d, updates } = deps({ isBlocks: async () => false });
    await approveArticle("a1", { headline: "H", body: "Edited body text" }, d);
    expect(updates[0].patch).toMatchObject({ headline: "H", body: "Edited body text", summary: "Edited body text" });
  });

  it("save changes only the headline of a Write story", async () => {
    const { d, updates } = deps();
    await saveArticleEdits("a1", { headline: "Only this", body: "ignored" }, d);
    expect(updates[0].patch).toEqual({ headline: "Only this" });
  });

  it("the blocks, the format and the image columns from the copy are written together with the status", async () => {
    const { d, updates } = deps({ beforePublish: async () => ({ body_blocks: { v: 1, blocks: [] }, body_format: "blocks", image_url: `${PUBLIC}x.webp` }) });
    await approveArticle("a1", { headline: "H", body: "b" }, d);
    expect(updates[0].patch).toMatchObject({ status: "published", body_format: "blocks", image_url: `${PUBLIC}x.webp`, body_blocks: { v: 1, blocks: [] } });
  });

  it("when the images cannot be copied the story is not published", async () => {
    const { d, updates } = deps({ beforePublish: async () => { throw new Error("storage down"); } });
    const r = await approveArticle("a1", { headline: "H", body: "b" }, d);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("not published because its photo") });
    expect(updates).toEqual([]);
  });

  it("a non-admin changes nothing and asks nothing", async () => {
    const isBlocks = vi.fn(async () => true);
    const { d, updates } = deps({ adminEmail: async () => null, isBlocks });
    expect(await approveArticle("a1", { headline: "H", body: "b" }, d)).toEqual({ ok: false, error: "Not authorised." });
    expect(updates).toEqual([]);
    expect(isBlocks).not.toHaveBeenCalled();
  });
});

describe("publishing an AI-written blocks story", () => {
  const ai = (blocks: BlocksDoc, over: Record<string, unknown> = {}) => ({ id: "a1", origin: "ai", status: "pending_review", body_format: "blocks", body_blocks: blocks, body: PROSE, image_url: "https://images.unsplash.com/photo-cover", ...over });
  const unsplash = (id: string) => ({ id, type: "image", src: `https://images.unsplash.com/photo-${id}`, alt: `alt ${id}`, caption: "", credit: "Ada", creditUrl: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral" });

  it("drops a picture that was never placed, keeps the placed ones as they are, copies nothing and leaves the card picture to the image stage", async () => {
    install([ai(doc(unsplash("p1"), { id: "x", type: "image", query: "never found", alt: "Never found", caption: "" }), { image_url: "/images/defaults/software.svg" })]);
    const patch = await publishPhotoPatch("a1");
    const stored = parseStoredDoc(patch.body_blocks)!;
    expect(stored.blocks.filter((b) => b.type === "image").map((b) => b.id)).toEqual(["p1"]);
    expect(stored.blocks[1]).toMatchObject({ credit: "Ada", src: "https://images.unsplash.com/photo-p1" });
    expect(storage.public.size).toBe(0);
    expect(patch).not.toHaveProperty("image_url"); // an AI story's cover and its credit come from the image stage
  });

  it("an AI blocks story with nothing to drop is rewritten unchanged, and a plain AI article is not touched", async () => {
    install([ai(doc(unsplash("p1"))), { id: "plain", origin: "ai", status: "pending_review", body_format: "plain" }]);
    expect(parseStoredDoc((await publishPhotoPatch("a1")).body_blocks)!.blocks).toHaveLength(2);
    expect(await publishPhotoPatch("plain")).toEqual({});
  });

  it("the editor can change the headline only: the blocks, text and summary of an AI blocks story are left alone", async () => {
    const updates: Record<string, unknown>[] = [];
    const deps = { adminEmail: async () => "editor@example.com", update: async (_id: string, patch: Record<string, unknown>) => (updates.push(patch), 1), unpublish: async () => 1, log: async () => {}, now: () => new Date("2026-10-23T10:00:00Z"), beforePublish: publishPhotoPatch, isBlocks: isBlocksArticle };
    install([ai(doc(unsplash("p1")))]);
    await approveArticle("a1", { headline: "Better headline", body: "ignored" }, deps);
    expect(updates[0]).toMatchObject({ status: "published", headline: "Better headline", body_format: "blocks" });
    expect(updates[0]).not.toHaveProperty("body");
    expect(updates[0]).not.toHaveProperty("summary");
  });
});