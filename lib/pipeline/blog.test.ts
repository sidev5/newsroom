import { beforeEach, describe, expect, it, vi } from "vitest";

// The AI-written blocks blog: what the model may return, what the write stage does with it (retry once, then fail with the
// reason; never store what does not validate), what the departments that keep the plain format still get, and how the result is
// drawn. The real callAgent runs with a mocked Gemini SDK, so the schema conversion for the provider is exercised too.
const mocks = vi.hoisted(() => ({ generate: vi.fn(), inserted: [] as Record<string, unknown>[] }));

vi.mock("@google/genai", () => {
  class ApiError extends Error {
    status: number;
    constructor(o: { message: string; status: number }) {
      super(o.message);
      this.status = o.status;
    }
  }
  class GoogleGenAI {
    models = { generateContent: mocks.generate };
  }
  return { ApiError, GoogleGenAI };
});

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "agent_runs") mocks.inserted.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ApiError } from "@google/genai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { BlocksView } from "@/components/story/BlocksView";
import { BLOG_LIMITS, BLOG_WORDS } from "@/lib/config";
import { resetEnvCache } from "@/lib/env";
import { callAgent, resetProviderCache } from "@/lib/llm";
import { geminiJsonSchema } from "@/lib/llm/providers/gemini";
import { parseStoredDoc } from "@/lib/stories/blocks";
import { assembleBlog, blogSchema, blogWordRange, BLOG_SYSTEM, isBlogDepartment, proseProblem, toDoc, type BlogOutput } from "./blog";
import { isBlogItem, runWrite, writeItem, writeSchema, WRITE_SYSTEM, type NewArticle, type WriteItem } from "./write";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------
const sentence = (n: number) => `Section ${n} explains one part of the release in plain terms, says who it is for, and notes the limits the source gives for it.`;
/** A paragraph of exactly `n` words. */
const para =(n: number, seed = 0) => Array.from({ length: n }, (_, i) => `w${seed}x${i}`).join(" ");

type RawBlock = BlogOutput["blocks"][number];
const p = (text: string): RawBlock => ({ type: "paragraph", text });
/** Paragraph blocks of 100 words each (a paragraph block holds at most 5000 characters) that add up to exactly `n` words. */
const many = (n: number, seed = 9): RawBlock[] => Array.from({ length: Math.ceil(n / 100) }, (_, i) => p(para(Math.min(100, n - i * 100), seed * 100 + i)));
const h = (text: string, level: "h2" | "h3" = "h2"): RawBlock => ({ type: "heading", level, text });
const code = (language: BlogOutput["blocks"][number] extends infer B ? (B extends { type: "code"; language: infer L } ? L : never) : never, src: string, filename: string | null = null): RawBlock => ({ type: "code", language, filename, code: src });
const img = (query = "server room", caption = "A server room", alt = "Rows of servers in a data centre"): RawBlock => ({ type: "image", query, caption, alt });

/** 720 words of reading text in 8 paragraphs and 3 headings. */
function validBlocks(): RawBlock[] {
  return [p(`${sentence(0)} ${para(80)}`), h("What changed"), p(para(90, 1)), p(para(90, 2)), h("How it works"), p(para(90, 3)), img(), p(para(90, 4)), h("What to watch", "h3"), p(para(90, 5)), p(para(90, 6)), p(para(60, 7))];
}
const valid = (over: Partial<BlogOutput> = {}): BlogOutput => ({
  title: "A new release changes how the SDK handles retries",
  summary: "The release rewrites retry handling in the SDK and documents the new defaults and their limits.",
  country_code: null,
  image_query: "software developer laptop",
  image_alt: "A developer working at a laptop",
  blocks: validBlocks(),
  ...over,
});
const proseWords = (o: BlogOutput) => o.blocks.reduce((n, b) => n + (b.type === "paragraph" || b.type === "heading" ? b.text.split(/\s+/).length : b.type === "list" ? b.items.join(" ").split(/\s+/).length : 0), 0);

const problems = (o: unknown) => {
  const r = blogSchema.safeParse(o);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

// ---------------------------------------------------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------------------------------------------------
describe("blogSchema: acceptance", () => {
  it("accepts a valid blog", () => {
    expect(proseWords(valid())).toBeGreaterThanOrEqual(BLOG_WORDS.min);
    expect(problems(valid())).toEqual([]);
  });

  it("accepts every block type, including up to two short code blocks and quotes and lists", () => {
    const blocks: RawBlock[] = [
      ...validBlocks(),
      { type: "list", ordered: true, items: ["First step as the source describes it", "Second step"] },
      { type: "quote", text: "a few exact words", cite: null },
      code("python", "def add(a, b):\n    return a + b\n", "add.py"),
      code("json", '{"retries": 3}'),
    ];
    expect(problems(valid({ blocks }))).toEqual([]);
  });

  it("accepts the word-count range with the 10% tolerance, and nothing outside it", () => {
    const range = blogWordRange();
    expect(range).toEqual({ min: 540, max: 1320 });
    const sized = (n: number) => valid({ blocks: [...many(n), h("A"), h("B")] });
    expect(problems(sized(range.min - 2))).toEqual([]); // two headings are two words
    expect(problems(sized(range.min - 3)).join()).toMatch(/words; it must have 600-1200/);
    expect(problems(sized(range.max - 2))).toEqual([]);
    expect(problems(sized(range.max))).toHaveLength(1);
  });

  it("strips unknown fields on the story and on every block", () => {
    const r = blogSchema.safeParse({ ...valid(), evil: "x", blocks: valid().blocks.map((b) => ({ ...b, onclick: "alert(1)" })) });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty("evil");
      expect(r.data.blocks[0]).not.toHaveProperty("onclick");
    }
  });
});

describe("blogSchema: rejection of malformed output, with a message the model can act on", () => {
  it.each([
    ["not an object", "text"],
    ["null", null],
    ["an empty object", {}],
    ["blocks that are not an array", { ...valid(), blocks: "x" }],
    ["a block of an unknown type", { ...valid(), blocks: [...validBlocks(), { type: "script", src: "https://evil.example/a.js" }] }],
    ["a divider (not a type the model may use)", { ...valid(), blocks: [...validBlocks(), { type: "divider" }] }],
    ["a heading level of h1", { ...valid(), blocks: [...validBlocks(), { type: "heading", level: "h1", text: "x" }] }],
    ["a language that is not in the list", { ...valid(), blocks: [...validBlocks(), { type: "code", language: "cobol", filename: null, code: "x" }] }],
    ["a missing field (summary)", (({ title, image_query, image_alt, country_code, blocks }) => ({ title, image_query, image_alt, country_code, blocks }))(valid())],
    ["text that is not a string", { ...valid(), blocks: [{ type: "paragraph", text: 5 }] }],
  ])("%s", (_name, output) => {
    expect(blogSchema.safeParse(output).success).toBe(false);
  });

  it("an empty paragraph, naming the block", () => {
    const blocks = [...validBlocks()];
    blocks[2] = p("   ");
    expect(problems(valid({ blocks }))).toContain("block 3 (paragraph): Write something in the paragraph, or delete it.");
  });

  it("too few or too many words, saying how many it has", () => {
    expect(problems(valid({ blocks: [p(para(200)), h("A"), h("B")] })).join()).toMatch(/has 202 words; it must have 600-1200/);
    expect(problems(valid({ blocks: [...many(1500), h("A"), h("B")] })).join()).toMatch(/has 1502 words/);
  });

  it("a story that does not start with a paragraph, or has fewer than two headings", () => {
    expect(problems(valid({ blocks: [h("First"), ...validBlocks().slice(1)] })).join()).toMatch(/first block must be a paragraph/);
    expect(problems(valid({ blocks: [p(para(700)), h("Only one")] })).join()).toMatch(/at least 2 heading blocks/);
  });

  it("more than two code blocks, and code that is not short", () => {
    const three = [...validBlocks(), code("js", "a()"), code("js", "b()"), code("js", "c()")];
    expect(problems(valid({ blocks: three })).join()).toMatch(/at most 2 code blocks \(there are 3\)/);
    const long = [...validBlocks(), code("js", Array.from({ length: BLOG_LIMITS.CODE_MAX_LINES + 1 }, (_, i) => `a${i}();`).join("\n"))];
    expect(problems(valid({ blocks: long })).join()).toMatch(/is too long \(31 lines/);
    const wide = [...validBlocks(), code("js", `const x = "${"a".repeat(BLOG_LIMITS.CODE_MAX_CHARS)}";`)];
    expect(problems(valid({ blocks: wide })).join()).toMatch(/is too long/);
  });

  it("more than three images, and images without a query", () => {
    const many = [...validBlocks(), img("a b"), img("c d"), img("e f")];
    expect(problems(valid({ blocks: many })).join()).toMatch(/at most 3 image blocks/);
    const blocks = [...validBlocks()];
    blocks[6] = { type: "image", query: "", caption: "c", alt: "alt text here" };
    expect(problems(valid({ blocks })).length).toBeGreaterThan(0);
  });

  it.each([
    ["HTML", "Use the <b>new</b> option."],
    ["a script tag", "Run <script>alert(1)</script> first."],
    ["an HTML entity", "Fish &amp; chips"],
    ["markdown bold", "This is **important** news."],
    ["a backtick", "Call `retry()` twice."],
    ["a markdown heading", "# A heading in a paragraph"],
    ["a markdown link", "See [the docs](https://example.com)."],
    ["a bullet marker", "- first\n- second"],
    ["a URL", "Read more at https://example.com/post."],
    ["a www address", "Go to www.example.com for details."],
  ])("reading text with %s", (_name, text) => {
    const blocks = [...validBlocks()];
    blocks[2] = p(text);
    const msgs = problems(valid({ blocks }));
    expect(msgs.some((m) => m.startsWith("block 3 (paragraph) "))).toBe(true);
  });

  it("the same rule applies to headings, list items, captions and alt text", () => {
    for (const bad of [h("A <i>heading</i>"), { type: "list", ordered: false, items: ["fine", "see https://x.example"] } as RawBlock, { type: "image", query: "a b", caption: "**bold**", alt: "ok alt text" } as RawBlock]) {
      const blocks = [...validBlocks(), bad];
      expect(problems(valid({ blocks })).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("text over the limit of its block, and hostile code is allowed only as text in a code block", () => {
    expect(problems(valid({ blocks: [...validBlocks(), p("x".repeat(5001))] })).join()).toMatch(/too long/);
    // HTML in a CODE block is just code (an HTML example is legitimate): it is not refused...
    expect(problems(valid({ blocks: [...validBlocks(), code("html", "<script>alert(1)</script>")] }))).toEqual([]);
  });

  it("a title or summary that is too short or too long", () => {
    expect(problems(valid({ title: "x" })).join()).toMatch(/title must be 5-150/);
    expect(problems(valid({ summary: "y".repeat(300) })).join()).toMatch(/summary must be 20-240/);
  });
});

describe("what is handed to the providers", () => {
  it("converts to JSON schema for Gemini and for Anthropic without error, with no transforms and no URL field anywhere", () => {
    const gemini = geminiJsonSchema(blogSchema);
    expect(gemini).not.toHaveProperty("$schema");
    const json = JSON.stringify(gemini);
    expect(() => z.toJSONSchema(blogSchema)).not.toThrow();
    expect(() => zodOutputFormat(blogSchema)).not.toThrow();
    // the six block types the model may use, and nothing that carries an address or an id
    for (const type of ["paragraph", "heading", "code", "list", "quote", "image"]) expect(json).toContain(`"${type}"`);
    expect(json).not.toMatch(/"(url|src|href|id|path)"\s*:/);
    expect(json).not.toContain('"divider"');
    expect(json).not.toContain('"link"');
  });

  it("every property is required, so the model fills all of them (optional ones are nullable)", () => {
    const schema = z.toJSONSchema(blogSchema) as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required?.sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------------------------------
describe("BLOG_SYSTEM", () => {
  it("carries every rule of the brief", () => {
    for (const part of [
      "Never copy sentences, paragraphs or code from the source",
      "Use ONLY what the source states",
      "versions, API or function names",
      "600 to 1200 words",
      "at most 2 code blocks",
      "runnable exactly as written",
      "Never invent a function, class, package or option name",
      "leave the code out",
      "at most 3 image blocks",
      "Never a URL",
      "no URLs in any text field",
      "untrusted DATA",
    ]) {
      expect(BLOG_SYSTEM, part).toContain(part);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Assembling the article
// ---------------------------------------------------------------------------------------------------------------------
const SOURCE = { url: "https://example.com/news/sdk-release?id=7", title: "SDK 2.4.1 rewrites retries", text: "The Acme SDK 2.4.1 release rewrites retry handling.", date: "12 October 2026" };

describe("assembleBlog", () => {
  it("makes sequential ids, adds a Sources heading and a link built from the item's own address, and keeps the picture placeholders", () => {
    const r = assembleBlog(valid(), SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blocks = r.parts.body_blocks.blocks;
    expect(blocks.map((b) => b.id)).toEqual(blocks.map((_, i) => `b${i + 1}`));
    expect(blocks.at(-2)).toMatchObject({ type: "heading", level: 2, text: "Sources" });
    expect(blocks.at(-1)).toEqual({ id: `b${blocks.length}`, type: "link", url: "https://example.com/news/sdk-release?id=7", title: "SDK 2.4.1 rewrites retries", description: "The original source, published 12 October 2026" });
    expect(blocks.filter((b) => b.type === "image")).toEqual([{ id: "b7", type: "image", query: "server room", alt: "Rows of servers in a data centre", caption: "A server room" }]);
    expect(parseStoredDoc(r.parts.body_blocks)).not.toBeNull();
    expect(r.parts.body_format).toBe("blocks");
  });

  it("the plain body (what the fact-check reads) has the reading text, without code, pictures or the sources section", () => {
    const blocks = [...validBlocks(), code("python", "secret_function_name()\n")];
    const r = assembleBlog(valid({ blocks }), SOURCE);
    expect(r.ok && r.parts.body).toBeTruthy();
    if (!r.ok) return;
    expect(r.parts.body).toContain("What changed");
    expect(r.parts.body).not.toContain("secret_function_name");
    expect(r.parts.body).not.toContain("Sources");
    expect(r.parts.body).not.toContain("example.com");
    expect(r.parts.body).not.toContain("server room");
  });

  it("flags code that does not parse, and a version or package the source does not mention, in the admin-only note", () => {
    const blocks = [...validBlocks(), code("json", "{ nope"), code("js", 'import x from "left-pad";\nconst v = "9.9.9";')];
    const r = assembleBlog(valid({ blocks }), SOURCE);
    expect(r.ok && r.parts.review_note).toMatch(/^Code check: code block 1 \(JSON\) is not valid JSON/);
    if (!r.ok) return;
    expect(r.parts.review_note).toContain('code block 2 (JavaScript) imports "left-pad", which the source does not mention');
    expect(r.parts.review_note).toContain("mentions version 9.9.9, which the source does not");
    expect(r.parts.review_note).toContain("The code was not run");
    // flagged, not removed: the code is still in the story for the admin to judge
    expect(r.parts.body_blocks.blocks.filter((b) => b.type === "code")).toHaveLength(2);
  });

  it("has no note when the code is fine", () => {
    const r = assembleBlog(valid({ blocks: [...validBlocks(), code("python", "print('hi')")] }), SOURCE);
    expect(r.ok && r.parts.review_note).toBeNull();
  });

  it("leaves out the sources section when the item's address is not an http(s) one, rather than invent one", () => {
    const r = assembleBlog(valid(), { ...SOURCE, url: "javascript:alert(1)" });
    expect(r.ok && r.parts.body_blocks.blocks.some((b) => b.type === "link" || (b.type === "heading" && b.text === "Sources"))).toBe(false);
  });

  it("never returns what does not validate", () => {
    const bad = { ...valid(), blocks: [{ ...p("x"), type: "paragraph" as const, text: "   " }] };
    expect(assembleBlog(bad, SOURCE).ok).toBe(false);
    expect(assembleBlog(valid({ blocks: toDoc([]).blocks as never }), SOURCE).ok).toBe(false);
  });

  it("uses the model's summary, cleaned, and the title", () => {
    const r = assembleBlog(valid({ title: "  A   spaced   title ", summary: " One\n two  three four five six seven eight nine ten. " }), SOURCE);
    expect(r.ok && [r.parts.headline, r.parts.summary]).toEqual(["A spaced title", "One two three four five six seven eight nine ten."]);
  });
});

describe("proseProblem", () => {
  it("finds the first problem, or none for plain text", () => {
    expect(proseProblem("A plain sentence, with commas; and a colon: fine. Costs 5 dollars (about).")).toBeNull();
    expect(proseProblem("a < b and b > c")).toBeNull(); // comparison signs are not tags
    expect(proseProblem("<div>")).toMatch(/HTML/);
    expect(proseProblem("**x**")).toMatch(/markdown/);
    expect(proseProblem("https://x.example")).toMatch(/URL/);
  });
});

describe("departments", () => {
  it("Software Development and AI & Technology get blogs, every other department does not", () => {
    expect(isBlogDepartment("software")).toBe(true);
    expect(isBlogDepartment("ai-technology")).toBe(true);
    for (const slug of ["ev", "batteries", "defence", "sales-marketing", "world", "", null, undefined]) expect(isBlogDepartment(slug as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The write stage
// ---------------------------------------------------------------------------------------------------------------------
beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: "test-secret-0123456789",
    GEMINI_API_KEY: "gemini-test",
    LLM_PROVIDER: "gemini",
    BATCH_LIMIT: "5",
    MIN_SOURCE_WORDS: "120",
    LLM_TIMEOUT_MS: "45000",
  });
  resetEnvCache();
  resetProviderCache();
  mocks.generate.mockReset();
  mocks.inserted.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const reply = (body: unknown) => ({ text: typeof body === "string" ? body : JSON.stringify(body), modelVersion: "gemini-served", usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 2500 } });
const agent = <T>(params: Parameters<typeof callAgent<T>>[0]) => callAgent(params, { sleep: async () => {} });

const softwareItem: WriteItem = {
  id: "11111111-2222-3333-4444-555555555555",
  url: "https://example.com/story",
  title: "SDK release",
  content: "Short RSS summary.",
  full_text: words(500),
  source_published_at: "2026-10-10T08:00:00.000Z",
  department_id: "d-sw",
  department_slug: "software",
  place: null,
  lat: null,
  lon: null,
};

describe("writeItem: blogs", () => {
  it("writes a blog for a Software Development item, stores validated blocks and logs the tokens of the call", async () => {
    mocks.generate.mockResolvedValueOnce(reply(valid()));
    const d = await writeItem(softwareItem, { minSourceWords: 120 }, agent);
    expect(d.kind).toBe("write");
    if (d.kind !== "write") return;
    const a = d.article;
    expect(a).toMatchObject({ body_format: "blocks", status: "draft", source_urls: ["https://example.com/story"], department_id: "d-sw", headline: "A new release changes how the SDK handles retries", image_query: "software developer laptop", review_note: null });
    expect(parseStoredDoc(a.body_blocks)).not.toBeNull();
    expect(a.slug).toMatch(/^a-new-release-changes-how-the-sdk-handles-retries-11111111$/);
    expect(a.summary).toContain("retry handling");
    expect(a.body).not.toContain("Sources");
    expect(mocks.inserted).toEqual([expect.objectContaining({ agent: "write", raw_item_id: softwareItem.id, input_tokens: 1000, output_tokens: 2500 })]);
  });

  it("sends the structured-output schema and the blog prompt, not the plain ones", async () => {
    mocks.generate.mockResolvedValueOnce(reply(valid()));
    await writeItem(softwareItem, { minSourceWords: 120 }, agent);
    const config = mocks.generate.mock.calls[0][0].config;
    expect(config.systemInstruction).toBe(BLOG_SYSTEM);
    expect(config.responseMimeType).toBe("application/json");
    expect(JSON.stringify(config.responseJsonSchema)).toContain('"heading"');
    expect(mocks.generate.mock.calls[0][0].contents).toContain("<article>");
  });

  it("retries once with the validation error in the prompt, then succeeds", async () => {
    mocks.generate.mockResolvedValueOnce(reply(valid({ blocks: [p(para(100)), h("A"), h("B")] }))).mockResolvedValueOnce(reply(valid()));
    const d = await writeItem(softwareItem, { minSourceWords: 120 }, agent);
    expect(d.kind).toBe("write");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    const retryPrompt = String(mocks.generate.mock.calls[1][0].contents);
    expect(retryPrompt).toContain("was rejected");
    expect(retryPrompt).toMatch(/the reading text .* has 102 words; it must have 600-1200/);
    expect(mocks.inserted).toHaveLength(2); // both responses are logged
  });

  it("after two invalid answers marks the item failed with the reason, and stores nothing", async () => {
    mocks.generate.mockResolvedValue(reply(valid({ blocks: [...validBlocks(), { type: "paragraph", text: "See https://x.example" }] })));
    const d = await writeItem(softwareItem, { minSourceWords: 120 }, agent);
    expect(d).toMatchObject({ kind: "mark", update: { status: "failed", classify_reason: expect.stringMatching(/^write_invalid_output: [\s\S]*contains a URL/) } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.inserted).toHaveLength(2);
  });

  it("an answer that is not JSON at all fails the same way", async () => {
    mocks.generate.mockResolvedValue(reply("Sorry, I cannot do that."));
    const d = await writeItem(softwareItem, { minSourceWords: 120 }, agent);
    expect(d).toMatchObject({ kind: "mark", update: { status: "failed", classify_reason: expect.stringContaining("not valid JSON") } });
  });

  it("a 429 leaves the item queued: it is not failed", async () => {
    mocks.generate.mockRejectedValue(new ApiError({ message: "quota", status: 429 }));
    expect(await writeItem(softwareItem, { minSourceWords: 120 }, agent)).toEqual({ kind: "leave", reason: "rate_limited", error: expect.stringMatching(/HTTP 429: quota$/) });
  });

  it("a code block that does not parse still gets the story written, with a note for the admin", async () => {
    mocks.generate.mockResolvedValueOnce(reply(valid({ blocks: [...validBlocks(), code("json", "{ nope")] })));
    const d = await writeItem(softwareItem, { minSourceWords: 120 }, agent);
    expect(d.kind === "write" && d.article.review_note).toMatch(/code block 1 \(JSON\) is not valid JSON/);
  });
});

describe("the other departments keep the plain format", () => {
  const plain = { headline: "Battery plant opens in Ohio", body: words(200), image_query: "battery factory", image_alt: "A battery factory floor" };

  it.each(["ev", "batteries", "defence", "sales-marketing", "world", null, undefined])("%s: the plain schema, prompt and article, with no blocks", async (slug) => {
    mocks.generate.mockResolvedValueOnce(reply(plain));
    const seen: unknown[] = [];
    const watch = <T>(params: Parameters<typeof callAgent<T>>[0]) => (seen.push(params), callAgent(params, { sleep: async () => {} }));
    const d = await writeItem({ ...softwareItem, department_slug: slug as string }, { minSourceWords: 120 }, watch);
    expect(d.kind).toBe("write");
    if (d.kind !== "write") return;
    expect(d.article).not.toHaveProperty("body_blocks");
    expect(d.article).not.toHaveProperty("body_format");
    expect(d.article).not.toHaveProperty("review_note");
    expect(d.article.body).toBe(plain.body);
    expect((seen[0] as { schema: unknown; system: string }).schema).toBe(writeSchema);
    expect((seen[0] as { system: string }).system).toBe(WRITE_SYSTEM);
  });

  it("a Software Development source that is too thin for 600 words is written in the plain format too", async () => {
    mocks.generate.mockResolvedValueOnce(reply(plain));
    const thin = { ...softwareItem, full_text: words(BLOG_LIMITS.MIN_SOURCE_WORDS - 1) };
    expect(isBlogItem(thin)).toBe(false);
    expect(isBlogItem({ ...softwareItem, full_text: words(BLOG_LIMITS.MIN_SOURCE_WORDS) })).toBe(true);
    const d = await writeItem(thin, { minSourceWords: 120 }, agent);
    expect(d.kind === "write" && d.article.body_format).toBeUndefined();
  });
});

describe("runWrite with blogs", () => {
  function harness(items: WriteItem[]) {
    const articles: NewArticle[] = [];
    const updates: Record<string, unknown> = {};
    return { articles, updates, deps: { loadItems: async (n: number) => items.slice(0, n), insertArticle: async (a: NewArticle) => void articles.push(a), updateItem: async (id: string, u: unknown) => void (updates[id] = u), agent } };
  }
  const item = (id: string, over: Partial<WriteItem> = {}): WriteItem => ({ ...softwareItem, id, ...over });

  it("writes a mix of blogs and plain articles in one run", async () => {
    mocks.generate.mockResolvedValueOnce(reply(valid())).mockResolvedValueOnce(reply({ headline: "Battery plant opens in Ohio", body: words(200), image_query: "battery factory", image_alt: "A battery factory floor" }));
    const h = harness([item("a1111111"), item("b2222222", { department_slug: "batteries", department_id: "d-bat" })]);
    const counts = await runWrite(h.deps);
    expect(counts).toMatchObject({ processed: 2, written: 2, failed: 0, stopped: null });
    expect(h.articles.map((a) => a.body_format)).toEqual(["blocks", undefined]);
  });

  it("respects BATCH_LIMIT", async () => {
    process.env.BATCH_LIMIT = "2";
    resetEnvCache();
    mocks.generate.mockResolvedValue(reply(valid()));
    const h = harness([item("a1111111"), item("b2222222"), item("c3333333")]);
    const counts = await runWrite(h.deps);
    expect(counts.processed).toBe(2);
    expect(h.articles).toHaveLength(2);
  });

  it("marks an item failed (not the whole run) when the blog never validates, and goes on", async () => {
    mocks.generate.mockResolvedValueOnce(reply("nope")).mockResolvedValueOnce(reply("nope")).mockResolvedValueOnce(reply(valid())).mockResolvedValueOnce(reply(valid()));
    const h = harness([item("a1111111"), item("b2222222")]);
    const counts = await runWrite(h.deps);
    expect(counts).toMatchObject({ processed: 2, written: 1, failed: 1 });
    expect(h.updates["a1111111"]).toMatchObject({ status: "failed" });
    expect(h.updates["b2222222"]).toEqual({ status: "written" });
  });

  it("stops on a 429 and leaves the blogs queued", async () => {
    mocks.generate.mockRejectedValue(new ApiError({ message: "quota", status: 429 }));
    const h = harness([item("a1111111"), item("b2222222")]);
    const counts = await runWrite(h.deps);
    expect(counts).toMatchObject({ processed: 0, failed: 0, unprocessed: 2, stopped: "rate_limited" });
    expect(h.updates).toEqual({});
  });

  it("does not start a blog when less time is left than one LLM call may take: it stays queued, a plain article still goes", async () => {
    mocks.generate.mockResolvedValue(reply(valid()));
    const h = harness([item("a1111111")]);
    // 10 s left of the stage's budget, LLM_TIMEOUT_MS is 45 s
    const counts = await runWrite(h.deps, { deadlineAt: 10_000, now: () => 0 });
    expect(counts).toMatchObject({ processed: 0, unprocessed: 1, stopped: "time_budget" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(h.updates).toEqual({});

    mocks.generate.mockResolvedValueOnce(reply({ headline: "Battery plant opens in Ohio", body: words(200), image_query: "battery factory", image_alt: "A battery factory floor" }));
    const plainRun = harness([item("p1111111", { department_slug: "ev" })]);
    expect(await runWrite(plainRun.deps, { deadlineAt: 10_000, now: () => 0 })).toMatchObject({ processed: 1, written: 1 });
    // and with enough time, the blog is written
    const enough = harness([item("a1111111")]);
    expect(await runWrite(enough.deps, { deadlineAt: 100_000, now: () => 0 })).toMatchObject({ processed: 1, written: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// What a reader sees
// ---------------------------------------------------------------------------------------------------------------------
describe("no raw HTML is rendered from an AI-written story", () => {
  const html = (doc: unknown) => renderToStaticMarkup(createElement(BlocksView, { doc: doc as never }));

  it("the schema refuses HTML in reading text, so a model that returns it never reaches storage", () => {
    const blocks = [...validBlocks()];
    blocks[2] = p('<img src=x onerror="alert(1)"> and <script>alert(1)</script>');
    expect(problems(valid({ blocks })).length).toBeGreaterThan(0);
  });

  it("and if such text were stored anyway, or sits in code or a source title, it is drawn as text", () => {
    const hostile = { v: 1, blocks: [
      { id: "b1", type: "paragraph", text: '<script>alert(1)</script><img src=x onerror="alert(1)">' },
      { id: "b2", type: "code", language: "html", filename: "<b>x</b>.html", code: '</code></pre><script>alert(1)</script>' },
      { id: "b3", type: "link", url: "javascript:alert(1)", title: "<script>x</script>" },
      { id: "b4", type: "image", src: "https://images.unsplash.com/photo-1", alt: '"><script>alert(1)</script>', caption: "<i>caption</i>", credit: "<script>a</script>", creditUrl: "javascript:alert(1)" },
    ] };
    const out = html(hostile);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<img[^>]*onerror/i);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("a stock photo shows its credit with links that carry rel=noopener, and a placeholder that was never filled shows nothing", () => {
    const out = html({ v: 1, blocks: [
      { id: "b1", type: "image", src: "https://images.unsplash.com/photo-1", alt: "A server room", caption: "Racks", credit: "Ada Lovelace", creditUrl: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral" },
      { id: "b2", type: "image", query: "never found", alt: "Never found", caption: "should not show" },
    ] });
    expect(out).toContain("Photo by");
    expect(out).toContain("Ada Lovelace");
    expect(out).toMatch(/rel="noopener noreferrer"/);
    expect(out).not.toContain("should not show");
    expect(out).not.toContain("Image not available");
  });
});
