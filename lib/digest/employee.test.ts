import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { article, createMemoryStore } from "./memory-store";
import { fetchInlineImage, LEAD_CID } from "./prepare";
import { footerNote, renderDigest } from "./render";
import { selectStories } from "./select";
import { createDraft, type DigestDeps } from "./service";
import { DEFAULT_INTRO, DEFAULT_INTRO_WITH_EMPLOYEES } from "./types";

// Employee stories in the weekly digest: byline and tag like on the dashboard, no source lines, and the
// footer's "AI-generated summaries" wording only when there is an AI story to describe.

const SITE = "https://newsroom.example.com";
const employee = (id: string, over: Parameters<typeof article>[1] = {}) =>
  article(id, {
    headline: `Colleague story ${id}`,
    origin: "employee",
    author_first_name: "Ada",
    author_last_name: "Lovelace",
    author_department: "Software Development",
    source_urls: [],
    source_published_at: null,
    image_credit: null,
    image_credit_url: null,
    department: { name: "AI & Technology", slug: "ai-technology" },
    ...over,
  });
const ai = (id: string) => article(id, { headline: `AI story ${id}` });

const render = (articles: ReturnType<typeof article>[]) =>
  renderDigest({ subject: "S", intro: "Intro.", weekStart: "2026-10-12", siteUrl: SITE, articles, contact: null });

describe("employee stories in the digest email", () => {
  it("shows the byline and the Employee contribution tag, and no source lines, on the lead", () => {
    const { html, text } = render([employee("e1")]);
    expect(html).toContain("By Ada Lovelace · Software Development");
    expect(html).toContain(">Employee contribution</td>");
    expect(html).toContain(">AI &amp; Technology</td>"); // the department tag is still there
    expect(html).not.toContain("Source:");
    expect(html).not.toContain("Source published");
    expect(html).not.toContain("Source date unknown");
    expect(text).toContain("By Ada Lovelace · Software Development");
    expect(text).toContain("[AI & Technology | Employee contribution]");
    expect(text).not.toContain("Source:");
  });

  it("shows them in the 'Also this week' list too", () => {
    const { html, text } = render([ai("a1"), employee("e1")]);
    expect(html).toContain("AI &amp; Technology &middot; Employee contribution");
    expect(html).toContain("By Ada Lovelace · Software Development");
    expect(text).toContain("1. Colleague story e1 [AI & Technology | Employee contribution]");
    expect(text).toContain("   By Ada Lovelace · Software Development");
  });

  it("leaves AI stories exactly as before: source lines, no byline, no employee tag", () => {
    const { html, text } = render([ai("a1"), ai("a2")]);
    expect(html).toContain("Source: <a");
    expect(html).not.toContain("Employee contribution");
    expect(html).not.toContain("By Ada");
    expect(text).toContain("Source: example.com");
  });

  it("escapes the author's name and department", () => {
    const evil = employee("e1", { author_first_name: "<script>alert(1)</script>", author_department: '"><img src=x onerror=1>' });
    const { html } = render([evil]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows an employee's photo credit as plain text", () => {
    const { html } = render([employee("e1", { image_credit: "Ada L." })]);
    expect(html).toContain("Photo: Ada L.");
  });
});

describe("the footer wording", () => {
  it("keeps the AI wording for AI stories only", () => {
    expect(footerNote([ai("a1"), ai("a2")])).toBe("AI-generated summaries, reviewed by an editor before circulation.");
    expect(render([ai("a1")]).html).toContain("AI-generated summaries, reviewed by an editor before circulation.");
  });

  it("says Employee contributions when every story is one, with no AI wording", () => {
    expect(footerNote([employee("e1"), employee("e2")])).toBe("Employee contributions, reviewed by an editor before circulation.");
    const out = render([employee("e1"), employee("e2")]);
    expect(out.html).not.toContain("AI-generated");
    expect(out.text).not.toContain("AI-generated");
    expect(out.html).toContain("Employee contributions, reviewed by an editor before circulation.");
  });

  it("names both when the digest mixes them", () => {
    const note = "AI-generated summaries and employee contributions, reviewed by an editor before circulation.";
    expect(footerNote([ai("a1"), employee("e1")])).toBe(note);
    const out = render([ai("a1"), employee("e1")]);
    expect(out.html).toContain(note);
    expect(out.text).toContain(note);
  });
});

describe("choosing and drafting", () => {
  it("treats an employee story like any other when choosing: newest with a photo leads, departments are spread", () => {
    const picked = selectStories([ai("a1"), employee("e1", { published_at: "2026-10-15T08:00:00.000Z" }), article("b1", { department: { name: "Batteries", slug: "batteries" } })], 3);
    expect(picked[0].id).toBe("e1");
    expect(picked.map((a) => a.id).sort()).toEqual(["a1", "b1", "e1"]);
  });

  const NOW = new Date("2026-10-19T03:00:00.000Z");
  const setup = (articles: ReturnType<typeof article>[]) => {
    const mem = createMemoryStore({ articles });
    const deps: DigestDeps = { store: mem.store, adminEmail: async () => "editor@example.com", now: () => NOW, maxStories: 6, distributionList: null };
    return { mem, deps };
  };

  it("uses the AI-only intro when no employee story is chosen", async () => {
    const { deps } = setup([article("a1", { published_at: "2026-10-18T08:00:00.000Z" })]);
    expect((await createDraft(deps, "cron")).digest.intro).toBe(DEFAULT_INTRO);
  });

  it("uses an intro that is true for both kinds when an employee story is chosen", async () => {
    const { deps } = setup([article("a1", { published_at: "2026-10-18T08:00:00.000Z" }), employee("e1", { published_at: "2026-10-17T08:00:00.000Z" })]);
    const draft = (await createDraft(deps, "cron")).digest;
    expect(draft.article_ids).toContain("e1");
    expect(draft.intro).toBe(DEFAULT_INTRO_WITH_EMPLOYEES);
    expect(draft.intro).toMatch(/contributions from colleagues/);
  });
});

describe("the lead image of an employee story", () => {
  it("is sent as a JPEG when the stored photo is WebP, which Outlook for Windows cannot show", async () => {
    const webp = await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 10, g: 120, b: 200 } } }).webp().toBuffer();
    const fetchImpl = (async () => new Response(webp, { headers: { "content-type": "image/webp" } })) as typeof fetch;
    const inline = await fetchInlineImage("https://abc.supabase.co/storage/v1/object/public/article-images/x.webp", fetchImpl);
    expect(inline).toMatchObject({ cid: LEAD_CID, filename: "lead.jpg", contentType: "image/jpeg" });
    expect([...inline!.content.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("falls back to no inline image when the WebP is broken", async () => {
    const fetchImpl = (async () => new Response(Buffer.from("not a webp"), { headers: { "content-type": "image/webp" } })) as typeof fetch;
    expect(await fetchInlineImage("https://abc.supabase.co/x.webp", fetchImpl)).toBeNull();
  });
});
