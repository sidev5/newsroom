import { describe, expect, it } from "vitest";
import { STORY_LIMITS as L } from "@/lib/config";
import { parseSubmittedDoc } from "./blocks";
import {
  cannotAdd, DRAFT_KEY, fitWithin, imageCount, insertAt, isEmptyDraft, MENU, moveBlock, newBlockId, parseDraft, removeAt, replaceAt, serializeDraft, toPreviewDoc, toSubmitDoc,
  type EditorBlock,
} from "./editor";

const make = (key: string, id: string) => MENU.find((m) => m.key === key)!.make(id);
const ids = (blocks: EditorBlock[]) => blocks.map((b) => b.id);
const NOW = new Date("2026-10-22T10:00:00Z");

describe("the + menu", () => {
  it("offers every block type of the brief, with both heading levels and both list kinds", () => {
    expect(MENU.map((m) => m.label)).toEqual(["Paragraph", "Heading (H2)", "Heading (H3)", "Image", "Code", "Quote", "Bulleted list", "Numbered list", "Divider", "Link"]);
    expect(make("h3", "x")).toMatchObject({ type: "heading", level: 3 });
    expect(make("ol", "x")).toMatchObject({ type: "list", ordered: true });
    expect(make("ul", "x")).toMatchObject({ type: "list", ordered: false });
  });

  it("every choice makes a block the schema knows (an empty one is refused for its content, not for its type)", () => {
    for (const m of MENU) expect(m.make("a1").type).toMatch(/^(paragraph|heading|image|code|quote|list|divider|link)$/);
  });

  it("stops offering blocks at 60, and images at 8", () => {
    const sixty = Array.from({ length: L.MAX_BLOCKS }, (_, i) => make("paragraph", `p${i}`));
    expect(cannotAdd(sixty, MENU[0])).toMatch(/at most 60 blocks/);
    expect(cannotAdd(sixty.slice(1), MENU[0])).toBeNull();
    const eight = Array.from({ length: L.MAX_IMAGES }, (_, i) => make("image", `i${i}`));
    expect(imageCount(eight)).toBe(8);
    expect(cannotAdd(eight, MENU.find((m) => m.key === "image")!)).toMatch(/at most 8 images/);
    expect(cannotAdd(eight, MENU[0])).toBeNull(); // other blocks are still allowed
  });

  it("makes ids that are valid and unique, and tries again when an id is taken", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newBlockId(taken);
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    // the first draw is taken: the second one is used
    const draws = [0.5, 0.5, 0.25];
    const first = newBlockId(new Set(), () => 0.5);
    expect(newBlockId(new Set([first]), () => draws.shift()!)).not.toBe(first);
  });
});
describe("adding, moving and deleting blocks, in any order", () => {
  const a = make("paragraph", "a");
  const b = make("code", "b");
  const c = make("quote", "c");

  it("adds at the start, between blocks and at the end", () => {
    const base = [a, b];
    expect(ids(insertAt(base, 0, c))).toEqual(["c", "a", "b"]);
    expect(ids(insertAt(base, 1, c))).toEqual(["a", "c", "b"]);
    expect(ids(insertAt(base, 2, c))).toEqual(["a", "b", "c"]);
    expect(ids(insertAt(base, 99, c))).toEqual(["a", "b", "c"]);
    expect(ids(insertAt(base, -5, c))).toEqual(["c", "a", "b"]);
    expect(ids(insertAt([], 0, c))).toEqual(["c"]);
    expect(base).toHaveLength(2); // the input is not changed
  });

  it("moves up and down, and does nothing past either end", () => {
    const base = [a, b, c];
    expect(ids(moveBlock(base, 1, -1))).toEqual(["b", "a", "c"]);
    expect(ids(moveBlock(base, 1, 1))).toEqual(["a", "c", "b"]);
    expect(ids(moveBlock(base, 0, -1))).toEqual(["a", "b", "c"]);
    expect(ids(moveBlock(base, 2, 1))).toEqual(["a", "b", "c"]);
    expect(ids(moveBlock(base, 7, 1))).toEqual(["a", "b", "c"]);
  });

  it("deletes and replaces one block", () => {
    expect(ids(removeAt([a, b, c], 1))).toEqual(["a", "c"]);
    expect(replaceAt([a, b], 0, { id: "a", type: "paragraph", text: "changed" })[0]).toMatchObject({ text: "changed" });
  });
});

describe("what is sent and what is previewed", () => {
  const blocks: EditorBlock[] = [
    { id: "p", type: "paragraph", text: "The pilot line reached its first production milestone this quarter, with output rising steadily while unit costs fell against the earlier plan. ".repeat(2) },
    { id: "l", type: "list", ordered: true, itemsText: "one\n\n two \nthree" },
    { id: "i", type: "image", alt: "A chart", caption: "", fileName: "chart.png" },
    { id: "c", type: "code", language: "python", filename: "a.py", code: "def f():\n\treturn 1" },
  ];

  it("the submitted document passes the server's schema, one list item per line, and carries no file names", () => {
    const sent = toSubmitDoc(blocks);
    expect(JSON.stringify(sent)).not.toContain("chart.png");
    const parsed = parseSubmittedDoc(sent);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.doc.blocks[1]).toMatchObject({ type: "list", items: ["one", "two", "three"] });
  });

  it("the preview leaves out blocks that are still empty, and keeps the code exactly", () => {
    const empty: EditorBlock = { id: "e", type: "paragraph", text: "  " };
    const preview = toPreviewDoc([...blocks, empty, { id: "h", type: "heading", level: 2, text: "" }]);
    expect(preview.blocks.map((b) => b.id)).toEqual(["p", "l", "i", "c"]);
    expect(preview.blocks[3]).toMatchObject({ code: "def f():\n\treturn 1" });
  });
});

describe("the draft in the browser", () => {
  const blocks: EditorBlock[] = [
    { id: "p", type: "paragraph", text: "Hello" },
    { id: "i", type: "image", alt: "A chart", caption: "Q3", fileName: "secret-name.png" },
    { id: "c", type: "code", language: "sql", filename: "q.sql", code: "select\t1" },
  ];

  it("round-trips the story, drops the file name, and keeps no name, email or address", () => {
    const raw = serializeDraft({ title: "My story", summary: "Short", sector: "ev", blocks }, NOW);
    expect(raw).not.toContain("secret-name.png");
    const d = parseDraft(raw)!;
    expect(d.title).toBe("My story");
    expect(d.sector).toBe("ev");
    expect(d.savedAt).toBe(NOW.toISOString());
    expect(d.blocks.map((b) => b.id)).toEqual(["p", "i", "c"]);
    expect(d.blocks[1]).toMatchObject({ alt: "A chart", caption: "Q3", fileName: "" });
    expect(d.blocks[2]).toMatchObject({ code: "select\t1", language: "sql" });
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["blocks", "savedAt", "sector", "summary", "title"]);
  });

  it("uses a key that names its version", () => {
    expect(DRAFT_KEY).toMatch(/-v1$/);
  });

  it.each([null, undefined, "", "not json", "[]", "null", '{"blocks":"x"}', "x".repeat(2_000_001)])("a draft that is not usable (%#) gives null", (raw) => {
    expect(parseDraft(raw as string | null)).toBeNull();
  });

  it("drops blocks it does not understand, bad ids, repeated ids and anything beyond 60, and fixes unknown languages and levels", () => {
    const raw = JSON.stringify({
      title: 5,
      blocks: [
        { id: "a", type: "paragraph", text: "ok" },
        { id: "a", type: "paragraph", text: "repeated id" },
        { id: "bad id!", type: "paragraph", text: "bad id" },
        { id: "s", type: "script", text: "<script>" },
        { id: "h", type: "heading", level: 9, text: "H" },
        { id: "c", type: "code", language: "cobol", code: "x" },
        null,
        "x",
        ...Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, type: "divider" })),
      ],
    });
    const d = parseDraft(raw)!;
    expect(d.title).toBe("");
    expect(d.blocks.length).toBeLessThanOrEqual(L.MAX_BLOCKS);
    expect(d.blocks.slice(0, 3).map((b) => b.id)).toEqual(["a", "h", "c"]);
    expect(d.blocks[1]).toMatchObject({ level: 2 });
    expect(d.blocks[2]).toMatchObject({ language: "plain" });
  });

  it("an empty draft is not offered back", () => {
    expect(isEmptyDraft({ title: "", summary: "", blocks: [] })).toBe(true);
    expect(isEmptyDraft({ title: " ", summary: "", blocks: [{ id: "p", type: "paragraph", text: "  " }, { id: "d", type: "divider" }] })).toBe(true);
    expect(isEmptyDraft({ title: "T", summary: "", blocks: [] })).toBe(false);
    expect(isEmptyDraft({ title: "", summary: "", blocks: [{ id: "p", type: "paragraph", text: "x" }] })).toBe(false);
    expect(isEmptyDraft({ title: "", summary: "", blocks: [{ id: "c", type: "code", language: "js", filename: "", code: "x" }] })).toBe(false);
  });
});

describe("scaling an image before it is sent", () => {
  it("keeps the proportions, never enlarges, and limits the longest side", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(fitWithin(10_000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });
});
