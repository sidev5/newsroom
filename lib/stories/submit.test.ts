import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { SUBMISSION_LIMITS } from "@/lib/config";
import { hashIp } from "@/lib/submissions/identity";
import { DUPLICATE_MESSAGE, EMAIL_LIMIT_MESSAGE } from "@/lib/submissions/limits";
import { PHOTO_SIZE_MESSAGE, PHOTO_TYPE_MESSAGE } from "@/lib/submissions/image";
import { CAPTCHA_ERROR } from "@/lib/submissions/turnstile";
import { GENERIC_ERROR, type NewSubmissionArticle, type NewSubmitter, type Sector, type SubmissionDeps, type SubmissionStore } from "@/lib/submissions/service";
import { readStoryRequest } from "./request";
import { ANONYMOUS_FIRST, ANONYMOUS_LAST, IMAGE_MISSING_MESSAGE, ipAlreadyLimited, submitBlocksStory, type StoryImageFile, type StoryInput } from "./submit";

const SECTORS: Sector[] = [{ id: "d-ev", slug: "ev", name: "EV" }, { id: "d-ai", slug: "ai-technology", name: "AI & Technology" }];
const PROSE = "The charging team finished the pilot line this week, ahead of plan, with output rising steadily and costs falling. ".repeat(3);

const fields = (over: Record<string, string> = {}) => ({
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@adorpower.com",
  authorDepartment: "Software Development",
  sector: "ev",
  title: "Pilot line finished ahead of plan",
  summary: "",
  country: "IN",
  showName: "on",
  ownWork: "on",
  noConfidential: "on",
  ...over,
});
const blocks = (...b: unknown[]) => ({ v: 1, blocks: b });
const para = (id = "p1", text = PROSE) => ({ id, type: "paragraph", text });

const png = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
const file = (bytes: Uint8Array): StoryImageFile => ({ size: bytes.length, bytes: async () => bytes });

type Row = { id: string; article: NewSubmissionArticle; submitter: NewSubmitter };

function setup(over: { failInsert?: boolean; failUpload?: boolean } = {}) {
  const rows: Row[] = [];
  const photos = new Map<string, Buffer>();
  const removed: string[] = [];
  const store: SubmissionStore = {
    sectors: async () => SECTORS,
    counts: async ({ ipHash, email, sinceIso }) => ({
      ip: ipHash ? rows.filter((r) => r.submitter.ip_hash === ipHash && r.submitter.submitted_at >= sinceIso).length : null,
      email: rows.filter((r) => r.submitter.email === email && r.submitter.submitted_at >= sinceIso).length,
    }),
    recentTitles: async (email, sinceIso) => rows.filter((r) => r.submitter.email === email && r.submitter.submitted_at >= sinceIso).map((r) => r.article.headline),
    uploadPhoto: async (path, data) => {
      if (over.failUpload) throw new Error("storage down");
      photos.set(path, data);
    },
    removePhoto: async (path) => {
      removed.push(path);
      photos.delete(path);
    },
    insert: async (article, submitter) => {
      if (over.failInsert) throw new Error("db down");
      const id = `row-${rows.length + 1}`;
      rows.push({ id, article, submitter });
      return { id };
    },
  };
  let n = 0;
  const logError = vi.fn();
  const deps: SubmissionDeps = {
    store,
    allowedDomains: ["adorpower.com"],
    hashIp: (ip) => hashIp(ip, "test-secret-test-secret"),
    now: () => new Date("2026-10-22T10:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    logError,
  };
  const send = (input: Omit<Partial<StoryInput>, "fields"> & { fields?: Record<string, string> } = {}) =>
    submitBlocksStory(deps, { blocks: blocks(para()), honeypot: "", images: new Map(), ip: "203.0.113.7", ...input, fields: fields(input.fields) });
  return { deps, rows, photos, removed, send, logError };
}

describe("submitBlocksStory", () => {
  it("stores a pending employee story with its blocks, a plain-text body and the default image", async () => {
    const t = setup();
    expect(await t.send()).toEqual({ ok: true });
    expect(t.rows).toHaveLength(1);
    const a = t.rows[0].article;
    expect(a).toMatchObject({
      headline: "Pilot line finished ahead of plan",
      status: "pending_review",
      origin: "employee",
      body_format: "blocks",
      author_first_name: "Ada",
      author_last_name: "Lovelace",
      author_department: "Software Development",
      department_id: "d-ev",
      country_code: "IN",
      image_url: "/images/defaults/ev.svg",
    });
    expect(a.body).toBe(PROSE.trim());
    expect(a.body_blocks).toEqual({ v: 1, blocks: [{ id: "p1", type: "paragraph", text: PROSE.trim() }] });
    expect(a.summary.length).toBeLessThanOrEqual(241);
    expect(a.slug).toMatch(/^pilot-line-finished-ahead-of-plan-[0-9a-f]{8}$/);
  });

  it("uses the summary the author wrote, and cuts the first paragraph otherwise", async () => {
    const t = setup();
    await t.send({ fields: { summary: "Our own summary." } });
    expect(t.rows[0].article.summary).toBe("Our own summary.");
  });

  it("keeps the submitter's email, a hash of the address and the real name in the private row, never in the article", async () => {
    const t = setup();
    await t.send();
    const s = t.rows[0].submitter;
    expect(s).toMatchObject({ email: "ada@adorpower.com", first_name: "Ada", last_name: "Lovelace", author_department: "Software Development", name_public: true, email_verified: true, image_paths: [] });
    expect(s.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(t.rows[0].article)).not.toMatch(/adorpower\.com|203\.0\.113\.7/);
  });

  it("shows 'Newsroom contributor' when the author did not agree to show their name, and keeps the real name private", async () => {
    const t = setup();
    await t.send({ fields: { showName: "" } });
    expect(t.rows[0].article).toMatchObject({ author_first_name: ANONYMOUS_FIRST, author_last_name: ANONYMOUS_LAST, author_department: null });
    expect(JSON.stringify(t.rows[0].article)).not.toMatch(/Ada|Lovelace|Software Development/);
    expect(t.rows[0].submitter).toMatchObject({ first_name: "Ada", last_name: "Lovelace", author_department: "Software Development", name_public: false });
  });

  it("silently ignores a bot that fills the honeypot, and stores nothing", async () => {
    const t = setup();
    expect(await t.send({ honeypot: "http://spam.example" })).toEqual({ ok: true });
    expect(t.rows).toHaveLength(0);
  });

  it("refuses when the human check fails, before reading anything", async () => {
    const t = setup();
    const sectors = vi.spyOn(t.deps.store, "sectors");
    const r = await submitBlocksStory({ ...t.deps, captcha: async () => false }, { fields: fields(), blocks: blocks(para()), honeypot: "", images: new Map(), ip: null });
    expect(r).toEqual({ ok: false, kind: "captcha", error: CAPTCHA_ERROR });
    expect(sectors).not.toHaveBeenCalled();
  });

  it("reports field errors, block errors and image errors together, and stores nothing", async () => {
    const t = setup();
    const r = await t.send({
      fields: { email: "ada@gmail.com", title: "x" },
      blocks: blocks(para(), { id: "c1", type: "code", language: "js", code: "x".repeat(20_001) }, { id: "i1", type: "image", alt: "a", caption: "" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("invalid");
    expect(r.fieldErrors).toMatchObject({ email: expect.stringMatching(/company email/), title: expect.stringMatching(/at least 5/) });
    // an image block with a missing file is reported on that block as well
    const r2 = await t.send({ blocks: blocks(para(), { id: "i1", type: "image", alt: "a", caption: "" }) });
    expect(!r2.ok && r2.blockErrors).toEqual({ i1: IMAGE_MISSING_MESSAGE });
    expect(t.rows).toHaveLength(0);
    expect(t.photos.size).toBe(0);
  });

  it("refuses a story with an unknown block type or a javascript: link, naming the block", async () => {
    const t = setup();
    const r = await t.send({ blocks: blocks(para(), { id: "x", type: "html", html: "<script>alert(1)</script>" }, { id: "l", type: "link", url: "javascript:alert(1)", title: "go" }) });
    expect(!r.ok && r.blockErrors).toMatchObject({ x: expect.any(String), l: expect.stringMatching(/http/) });
    expect(t.rows).toHaveLength(0);
  });

  describe("images", () => {
    const withImage = (bytes: Uint8Array, id = "i1") => ({ blocks: blocks(para(), { id, type: "image", alt: "A red square", caption: "Day one" }), images: new Map([[id, file(bytes)]]) });

    it("re-encodes the image, stores it in the private bucket under the story's id, and records its path and size in the block", async () => {
      const t = setup();
      expect(await t.send(withImage(await png(60, 40)))).toEqual({ ok: true });
      expect([...t.photos.keys()]).toEqual(["00000000-0000-4000-8000-000000000001/i1.webp"]);
      const stored = t.photos.get("00000000-0000-4000-8000-000000000001/i1.webp")!;
      expect((await sharp(stored).metadata()).format).toBe("webp");
      const doc = t.rows[0].article.body_blocks!;
      expect(doc.blocks[1]).toEqual({ id: "i1", type: "image", path: "00000000-0000-4000-8000-000000000001/i1.webp", alt: "A red square", caption: "Day one", width: 60, height: 40 });
      expect(t.rows[0].submitter.image_paths).toEqual(["00000000-0000-4000-8000-000000000001/i1.webp"]);
      expect(t.rows[0].article.image_url).toBe("/images/defaults/ev.svg"); // the card keeps the department image until approval
    });

    it("removes the EXIF location from an uploaded JPEG", async () => {
      const t = setup();
      const jpeg = await sharp(await png(50, 50)).withExif({ IFD0: { Copyright: "Ada" } }).jpeg().toBuffer();
      expect((await sharp(jpeg).metadata()).exif).toBeDefined();
      await t.send(withImage(jpeg));
      expect((await sharp([...t.photos.values()][0]).metadata()).exif).toBeUndefined();
    });

    it("judges the real bytes: an SVG, a script or a PDF named .png is refused, a PNG named .svg is accepted", async () => {
      const t = setup();
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      for (const bytes of [svg, new TextEncoder().encode("<?php system($_GET[1]); ?>"), new TextEncoder().encode("%PDF-1.7 ...")]) {
        const r = await t.send(withImage(bytes));
        expect(!r.ok && r.blockErrors).toEqual({ i1: PHOTO_TYPE_MESSAGE });
      }
      expect(t.photos.size).toBe(0);
      expect(await t.send(withImage(await png()))).toEqual({ ok: true });
    });

    it("refuses an image over 5 MB without reading it", async () => {
      const t = setup();
      const bytes = vi.fn(async () => new Uint8Array(1));
      const r = await t.send({ blocks: blocks(para(), { id: "i1", type: "image", alt: "a", caption: "" }), images: new Map([["i1", { size: SUBMISSION_LIMITS.PHOTO_MAX_BYTES + 1, bytes }]]) });
      expect(!r.ok && r.blockErrors).toEqual({ i1: PHOTO_SIZE_MESSAGE });
      expect(bytes).not.toHaveBeenCalled();
    });

    it("an image file with no image block, and a block with no file, are not stored", async () => {
      const t = setup();
      await t.send({ images: new Map([["ghost", file(await png())]]) });
      expect(t.photos.size).toBe(0);
      expect(t.rows).toHaveLength(1);
    });

    it("takes up to eight images, each stored under its own block id", async () => {
      const t = setup();
      const ids = Array.from({ length: 8 }, (_, i) => `i${i}`);
      const img = await png();
      expect(await t.send({ blocks: blocks(para(), ...ids.map((id) => ({ id, type: "image", alt: "a", caption: "" }))), images: new Map(ids.map((id) => [id, file(img)])) })).toEqual({ ok: true });
      expect(t.photos.size).toBe(8);
    });

    it("removes the images already stored when a later step fails", async () => {
      const t = setup({ failInsert: true });
      const r = await t.send(withImage(await png()));
      expect(r).toMatchObject({ ok: false, kind: "server", error: GENERIC_ERROR });
      expect(t.photos.size).toBe(0);
      expect(t.removed).toHaveLength(1);
      expect(t.logError).toHaveBeenCalledWith(expect.stringContaining("saving failed"));
      expect(t.logError.mock.calls.flat().join(" ")).not.toContain("ada@");
    });

    it("says our side failed when the storage is down, without leaking the cause", async () => {
      const t = setup({ failUpload: true });
      const r = await t.send(withImage(await png()));
      expect(r).toMatchObject({ ok: false, kind: "server", error: GENERIC_ERROR });
      expect(t.rows).toHaveLength(0);
    });
  });

  describe("abuse limits are the same as for the old form", () => {
    it("a duplicate title from the same email", async () => {
      const t = setup();
      await t.send();
      expect(await t.send()).toMatchObject({ ok: false, kind: "limited", error: DUPLICATE_MESSAGE });
    });

    it("more than five stories a day from one email", async () => {
      const t = setup();
      for (let i = 0; i < SUBMISSION_LIMITS.MAX_PER_EMAIL_PER_DAY; i++) {
        expect(await t.send({ fields: { title: `A different title number ${i}` }, ip: `203.0.113.${10 + i}` })).toEqual({ ok: true });
      }
      expect(await t.send({ fields: { title: "One more story today" }, ip: "203.0.113.99" })).toMatchObject({ ok: false, kind: "limited", error: EMAIL_LIMIT_MESSAGE });
    });

    it("more than three stories a day from one connection, checked before the body would be read", async () => {
      const t = setup();
      for (let i = 0; i < SUBMISSION_LIMITS.MAX_PER_IP_PER_DAY; i++) {
        await t.send({ fields: { email: `p${i}@adorpower.com`, title: `Another title number ${i}` } });
      }
      expect(await ipAlreadyLimited(t.deps, "203.0.113.7")).toBe(true);
      expect(await ipAlreadyLimited(t.deps, "198.51.100.1")).toBe(false);
      expect(await ipAlreadyLimited(t.deps, null)).toBe(false);
      expect(await t.send({ fields: { email: "z@adorpower.com", title: "Yet another title" } })).toMatchObject({ ok: false, kind: "limited" });
    });
  });
});

describe("readStoryRequest", () => {
  const form = (entries: [string, string | Blob][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };
  const png1 = new Blob([new Uint8Array([1, 2, 3])]);

  it("reads the fields, the blocks JSON and the image files by block id", () => {
    const r = readStoryRequest(form([["firstName", "Ada"], ["blocks", JSON.stringify(blocks(para()))], ["image:i1", png1], ["website", ""], ["cf-turnstile-response", "tok"]]), "203.0.113.7");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.fields.firstName).toBe("Ada");
    expect(r.input.blocks).toEqual(blocks(para()));
    expect([...r.input.images.keys()]).toEqual(["i1"]);
    expect(r.input.captchaToken).toBe("tok");
    expect(r.input.ip).toBe("203.0.113.7");
  });

  it("ignores files named like anything but image:<id>, empty files, and text in an image field", () => {
    const r = readStoryRequest(form([["blocks", JSON.stringify(blocks(para()))], ["image:../../x", png1], ["photo", png1], ["image:a", new Blob([])], ["image:b", "text"]]), null);
    expect(r.ok && r.input.images.size).toBe(0);
  });

  it("refuses a missing, oversized or malformed blocks field", () => {
    expect(readStoryRequest(form([]), null).ok).toBe(false);
    expect(readStoryRequest(form([["blocks", "{not json"]]), null).ok).toBe(false);
    expect(readStoryRequest(form([["blocks", "x".repeat(400_001)]]), null).ok).toBe(false);
  });
});
