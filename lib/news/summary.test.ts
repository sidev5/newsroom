import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeSummary, SUMMARY_CHARS, summarize } from "./format";

describe("makeSummary (the stored articles.summary)", () => {
  it("is 240 characters, as the audit asked", () => {
    expect(SUMMARY_CHARS).toBe(240);
  });

  it("leaves a short body as it is, with whitespace collapsed", () => {
    expect(makeSummary("Short story.")).toBe("Short story.");
    expect(makeSummary("  Two\n\nparagraphs\there.  ")).toBe("Two paragraphs here.");
    const exactly = "a".repeat(240);
    expect(makeSummary(exactly)).toBe(exactly);
  });

  it("cuts a long body at a word boundary, drops trailing punctuation and adds an ellipsis", () => {
    const body = "alpha beta gamma, ".repeat(40);
    const s = makeSummary(body);
    expect(s.length).toBeLessThanOrEqual(241);
    expect(s.endsWith("…")).toBe(true);
    expect(s.slice(0, -1)).not.toMatch(/[\s,;:.-]$/);
    // never ends in half a word
    expect(body.replace(/\s+/g, " ")).toContain(s.slice(0, -1) + " ");
  });

  it("cuts in the middle of a very long word when there is no space late enough", () => {
    const s = makeSummary("x".repeat(500));
    expect(s).toBe("x".repeat(240) + "…");
  });

  it("is the same rule as the card summary used before the column existed", () => {
    const body = "word ".repeat(100);
    expect(makeSummary(body)).toBe(summarize(body, 240));
  });
});

// The SQL backfill (supabase/migrations/2026-10-18_article_summary.sql) is written in regexp_replace / left() and
// cannot run here. This is the same steps in JavaScript, compared with makeSummary on many bodies.
function backfill(body: string): string {
  const n = body.replace(/\s+/g, " ").trim(); // btrim(regexp_replace(body, '\s+', ' ', 'g'))
  if (n.length <= 240) return n;
  const cut = n.slice(0, 240); // left(n, 240)
  const head = cut.replace(/ [^ ]*$/, ""); // regexp_replace(cut, ' [^ ]*$', '')
  const chosen = cut.includes(" ") && head.length > 144 ? head : cut;
  return chosen.replace(/[\s,;:.-]+$/, "") + "…";
}

describe("the SQL backfill gives the same summary as makeSummary", () => {
  const words = ["battery", "plant", "opens", "in", "Ohio,", "after", "a", "long", "delay.", "Officials", "said", "the", "line", "- ready;", "supercalifragilisticexpialidocious", "x"];
  const bodies: string[] = [];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rand() * 90);
    bodies.push(Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(rand() < 0.2 ? "\n\n" : " "));
  }
  bodies.push("", " ", "x".repeat(239), "x".repeat(240), "x".repeat(241), "a ".repeat(120), "a ".repeat(121), "ab ".repeat(100), "word. ".repeat(60));

  it.each(bodies.map((b, i) => [i, b] as const))("body #%i", (_i, body) => {
    expect(backfill(body)).toBe(makeSummary(body));
  });

  it("the SQL file uses the same constants as the JavaScript port above", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/2026-10-18_article_summary.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(sql).toContain("length(n) <= 240");
    expect(sql).toContain("left(n, 240)");
    expect(sql).toContain("> 144"); // 60 % of 240
    expect(sql).toContain("regexp_replace(cut, ' [^ ]*$', '')");
    expect(sql).toContain("'[\\s,;:.-]+$'");
    expect(sql).toContain("|| '…'");
    expect(sql).toContain("btrim(regexp_replace(body, '\\s+', ' ', 'g'))");
  });
});