import { describe, expect, it } from "vitest";
import { STORY_LIMITS as L } from "@/lib/config";
import { blocksToPlainText, cleanCode, cleanText, firstParagraph, imageBlocks, parseStoredDoc, parseSubmittedDoc, proseLength, readingMinutes, type BlocksDoc } from "./blocks";
import { CODE_LANGUAGES } from "./languages";

const PROSE = "The pilot line reached its first production milestone this quarter, with output rising steadily while unit costs fell against the earlier plan. ".repeat(2);
const para = (id: string, text = PROSE) => ({ id, type: "paragraph", text });
const doc = (...blocks: unknown[]) => ({ v: 1, blocks });

const issuesOf = (input: unknown) => {
  const r = parseSubmittedDoc(input);
  if (r.ok) throw new Error("expected the story to be refused");
  return r.issues;
};
const accepted = (input: unknown) => {
  const r = parseSubmittedDoc(input);
  if (!r.ok) throw new Error(`expected the story to pass: ${JSON.stringify(r.issues)}`);
  return r.doc;
};

describe("a valid story", () => {
  it("accepts every block type", () => {
    const d = accepted(
      doc(
        para("a"),
        { id: "b", type: "heading", level: 2, text: "Why it matters" },
        { id: "c", type: "heading", level: 3, text: "Details" },
        { id: "d", type: "image", alt: "The line", caption: "Day one" },
        { id: "e", type: "code", language: "ts", filename: "line.ts", code: "const x = 1;\n\tconst y = 2;" },
        { id: "f", type: "quote", text: "Output doubled.", cite: "Plant manager" },
        { id: "g", type: "list", ordered: false, items: ["one", "two"] },
        { id: "h", type: "list", ordered: true, items: ["first", "second"] },
        { id: "i", type: "divider" },
        { id: "j", type: "link", url: "https://example.com/report", title: "The report", description: "Read more" },
      ),
    );
    expect(d.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "heading", "image", "code", "quote", "list", "list", "divider", "link"]);
    expect(d.v).toBe(1);
  });

  it("offers the twelve languages of the brief", () => {
    expect(CODE_LANGUAGES.map((l) => l.label)).toEqual(["JavaScript", "TypeScript", "Python", "SQL", "Bash", "JSON", "C/C++", "Java", "HTML", "CSS", "YAML", "Plain text"]);
    for (const l of CODE_LANGUAGES) expect(parseSubmittedDoc(doc(para("a"), { id: "c", type: "code", language: l.id, code: "x" })).ok, l.id).toBe(true);
  });

  it("drops unknown fields, on the story and on every block", () => {
    const d = accepted({ v: 1, evil: "x", blocks: [{ ...para("a"), onclick: "alert(1)", html: "<b>x</b>" }, { id: "i", type: "image", alt: "a", caption: "", src: "https://evil.example/x.png", path: "../../x" }] });
    expect(d).not.toHaveProperty("evil");
    expect(d.blocks[0]).not.toHaveProperty("onclick");
    expect(d.blocks[0]).not.toHaveProperty("html");
    // a visitor cannot choose where an image comes from: path and src are filled in by the server only
    expect(d.blocks[1]).not.toHaveProperty("src");
    expect(d.blocks[1]).not.toHaveProperty("path");
  });
});

describe("what is refused", () => {
  it("an unknown block type, with a message for that block", () => {
    const issues = issuesOf(doc(para("a"), { id: "x", type: "script", src: "https://evil.example/a.js" }));
    expect(issues.some((i) => i.blockId === "x" && /does not know|type/i.test(i.message))).toBe(true);
  });

  it("more than 60 blocks", () => {
    const blocks = Array.from({ length: L.MAX_BLOCKS + 1 }, (_, i) => para(`b${i}`));
    expect(issuesOf(doc(...blocks)).map((i) => i.message).join(" ")).toMatch(/at most 60 blocks/);
    expect(parseSubmittedDoc(doc(...blocks.slice(0, L.MAX_BLOCKS))).ok).toBe(true);
  });

  it("more than 8 images", () => {
    const images = Array.from({ length: L.MAX_IMAGES + 1 }, (_, i) => ({ id: `i${i}`, type: "image", alt: "a", caption: "" }));
    expect(issuesOf(doc(para("a"), ...images)).some((i) => /at most 8 images/.test(i.message))).toBe(true);
    expect(parseSubmittedDoc(doc(para("a"), ...images.slice(0, 8))).ok).toBe(true);
  });

  it("an image without a description (alt text)", () => {
    expect(issuesOf(doc(para("a"), { id: "i", type: "image", alt: "  ", caption: "x" })).some((i) => i.blockId === "i" && /alt text/.test(i.message))).toBe(true);
  });

  it("code over 20,000 characters, and an empty code block", () => {
    expect(issuesOf(doc(para("a"), { id: "c", type: "code", language: "js", code: "x".repeat(L.CODE_MAX + 1) })).some((i) => i.blockId === "c" && /too long/.test(i.message))).toBe(true);
    expect(parseSubmittedDoc(doc(para("a"), { id: "c", type: "code", language: "js", code: "x".repeat(L.CODE_MAX) })).ok).toBe(true);
    expect(issuesOf(doc(para("a"), { id: "c", type: "code", language: "js", code: "  \n " })).some((i) => i.blockId === "c" && /empty/.test(i.message))).toBe(true);
  });

  it("a language that is not in the list", () => {
    expect(issuesOf(doc(para("a"), { id: "c", type: "code", language: "cobol", code: "x" })).some((i) => i.blockId === "c")).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "//example.com/x",
    "/relative/path",
    "example.com",
    "https://user:secret@example.com/x",
    "",
    `https://example.com/${"a".repeat(L.URL_MAX)}`,
  ])("a link to %s", (u) => {
    expect(issuesOf(doc(para("a"), { id: "l", type: "link", url: u, title: "t" })).some((i) => i.blockId === "l")).toBe(true);
  });

  it("accepts http and https links, and normalises them", () => {
    const d = accepted(doc(para("a"), { id: "l", type: "link", url: " http://Example.com/a b ", title: "t" }));
    expect(d.blocks[1]).toMatchObject({ url: "http://example.com/a%20b" });
    expect(parseSubmittedDoc(doc(para("a"), { id: "l", type: "link", url: "https://example.com", title: "t" })).ok).toBe(true);
  });

  it("text over the limit of its block, and empty text blocks", () => {
    expect(issuesOf(doc(para("a"), para("b", "x".repeat(L.PARAGRAPH_MAX + 1)))).some((i) => i.blockId === "b" && /too long/.test(i.message))).toBe(true);
    expect(issuesOf(doc(para("a"), { id: "h", type: "heading", level: 2, text: "x".repeat(L.HEADING_MAX + 1) })).some((i) => i.blockId === "h")).toBe(true);
    expect(issuesOf(doc(para("a"), { id: "e", type: "paragraph", text: "   " })).some((i) => i.blockId === "e" && /Write something/.test(i.message))).toBe(true);
    expect(issuesOf(doc(para("a"), { id: "g", type: "list", ordered: true, items: ["", " "] })).some((i) => i.blockId === "g")).toBe(true);
    expect(issuesOf(doc(para("a"), { id: "g", type: "list", ordered: true, items: Array(L.LIST_ITEMS_MAX + 1).fill("x") })).some((i) => i.blockId === "g")).toBe(true);
  });

  it("a heading level that is not 2 or 3", () => {
    expect(issuesOf(doc(para("a"), { id: "h", type: "heading", level: 1, text: "x" })).some((i) => i.blockId === "h")).toBe(true);
  });

  it("duplicate or malformed block ids", () => {
    expect(issuesOf(doc(para("a"), para("a"))).some((i) => /same id/.test(i.message))).toBe(true);
    expect(issuesOf(doc(para("a"), para("bad id with spaces"))).length).toBeGreaterThan(0);
    expect(issuesOf(doc(para("a"), para('x"><script>'))).length).toBeGreaterThan(0);
  });

  it("a story with too little text, or no blocks, or a wrong version, or not an object", () => {
    expect(issuesOf(doc(para("a", "Too short."))).some((i) => i.blockId === null && /at least 200 characters/.test(i.message))).toBe(true);
    expect(issuesOf(doc()).length).toBeGreaterThan(0);
    expect(issuesOf({ v: 2, blocks: [para("a")] }).length).toBeGreaterThan(0);
    for (const bad of [null, undefined, "x", 5, [], { blocks: "x" }]) expect(parseSubmittedDoc(bad).ok).toBe(false);
  });

  it("code and images do not count towards the minimum reading text", () => {
    expect(issuesOf(doc(para("a", "Short."), { id: "c", type: "code", language: "js", code: "x".repeat(5000) })).some((i) => /at least 200/.test(i.message))).toBe(true);
  });

  it("more than 100,000 characters in all", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, type: "code", language: "js", code: "x".repeat(L.CODE_MAX) }));
    expect(issuesOf(doc(para("a"), ...blocks)).some((i) => /too long \(more than 100,000/.test(i.message))).toBe(true);
  });
});

describe("cleaning", () => {
  it("removes control, zero-width and bidi characters from text", () => {
    expect(cleanText("a\u0000b​c‮d\u0007e")).toBe("abcde");
    expect(cleanText("  one   two  \n\n\n\n three ")).toBe("one two\n\nthree");
  });

  it("keeps tabs and spaces in code, drops hidden characters and normalises line endings", () => {
    expect(cleanCode("if (x) {\r\n\treturn  1;\r\n}\r\n\r\n")).toBe("if (x) {\n\treturn  1;\n}");
    expect(cleanCode("access‮ = 1​")).toBe("access = 1"); // Trojan Source characters
    expect(cleanCode("a\u0000b")).toBe("ab");
  });

  it("applies to every field when a story is parsed", () => {
    const d = accepted(doc(para("a"), { id: "c", type: "code", language: "python", code: "def f():\n\treturn 1‮" }));
    expect(d.blocks[1]).toMatchObject({ code: "def f():\n\treturn 1" });
  });
});

describe("stored blocks", () => {
  const stored = (blocks: unknown[]) => parseStoredDoc({ v: 1, blocks });

  it("accept images with a private path or a public https src", () => {
    const d = stored([para("a"), { id: "i", type: "image", path: "abc/def.webp", alt: "a", caption: "", width: 800, height: 600 }, { id: "j", type: "image", src: "https://x.supabase.co/storage/v1/object/public/article-images/a.webp", alt: "a", caption: "" }]);
    expect(d && imageBlocks(d)).toHaveLength(2);
  });

  it("refuse a src that is not https, and a path that tries to leave its folder", () => {
    expect(stored([para("a"), { id: "i", type: "image", src: "http://x.example/a.webp", alt: "a", caption: "" }])).toBeNull();
    expect(stored([para("a"), { id: "i", type: "image", src: "javascript:alert(1)", alt: "a", caption: "" }])).toBeNull();
    expect(stored([para("a"), { id: "i", type: "image", path: "../../secret", alt: "a", caption: "" }])).toBeNull();
  });

  it("return null for anything that is not a v1 document, instead of throwing", () => {
    for (const bad of [null, "x", { v: 1 }, { v: 1, blocks: [{ id: "a", type: "iframe" }] }]) expect(parseStoredDoc(bad)).toBeNull();
  });
});

describe("derived values", () => {
  const d = accepted(
    doc(
      para("a", `First paragraph. ${PROSE}`),
      { id: "b", type: "heading", level: 2, text: "A heading" },
      { id: "c", type: "code", language: "js", code: "secret();" },
      { id: "d", type: "quote", text: "Quoted.", cite: "Someone" },
      { id: "e", type: "list", ordered: true, items: ["x", "y"] },
      { id: "f", type: "list", ordered: false, items: ["p"] },
      { id: "g", type: "image", alt: "alt", caption: "cap" },
      { id: "h", type: "link", url: "https://example.com", title: "Link title" },
      { id: "i", type: "divider" },
    ),
  ) as BlocksDoc;

  it("plain text keeps the words and leaves out code, images and dividers", () => {
    const text = blocksToPlainText(d);
    expect(text).toContain("First paragraph.");
    expect(text).toContain("A heading");
    expect(text).toContain('"Quoted." (Someone)');
    expect(text).toContain("1. x\n2. y");
    expect(text).toContain("- p");
    expect(text).toContain("Link title");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("alt");
    expect(text).not.toContain("<");
  });

  it("the first paragraph, the prose length and the reading time", () => {
    expect(firstParagraph(d)).toMatch(/^First paragraph\./);
    expect(proseLength(d)).toBeGreaterThan(200);
    expect(readingMinutes(d)).toBe(1);
    const long = accepted(doc(...Array.from({ length: 40 }, (_, i) => para(`p${i}`, "word ".repeat(100).trim())))) as BlocksDoc;
    expect(readingMinutes(long)).toBe(20); // 4000 words at 200 a minute
  });
});
