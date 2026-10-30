import { describe, expect, it, vi } from "vitest";
import type { CallAgentParams, CallAgentResult } from "@/lib/llm";
import { FACTCHECK_BLOG_NOTE, FACTCHECK_SYSTEM, factcheckArticle, type FactcheckArticle, type FactcheckOutput } from "./factcheck";

// The fact-check of an AI-written blocks story runs over its text blocks (the plain body: no code, no pictures, no sources
// section), with the same strictness and the same stored result as for a plain article.

const source = { title: "SDK release", content: "Short.", full_text: "The release rewrites retry handling and documents new defaults.", source_published_at: "2026-10-10T08:00:00Z" };
const article = (over: Partial<FactcheckArticle> = {}): FactcheckArticle => ({ id: "a1", raw_item_id: "r1", headline: "SDK retries", body: "The release rewrites retry handling.", source, ...over });
const NONE: FactcheckOutput = { findings: [] };

function stub(data: FactcheckOutput) {
  const seen: CallAgentParams<unknown>[] = [];
  const agent = (async <T,>(params: CallAgentParams<T>): Promise<CallAgentResult<T>> => {
    seen.push(params as CallAgentParams<unknown>);
    return { ok: true, data: data as T, attempts: 1 };
  }) as Parameters<typeof factcheckArticle>[1];
  return { seen, agent };
}

describe("factcheckArticle for a blocks story", () => {
  it("adds the note about the longer explainer, with its code removed, to the system prompt", async () => {
    const s = stub(NONE);
    await factcheckArticle(article({ blocks: true }), s.agent);
    expect(s.seen[0].system).toBe(FACTCHECK_SYSTEM + FACTCHECK_BLOG_NOTE);
    expect(FACTCHECK_BLOG_NOTE).toContain("code samples and images were removed");
    expect(FACTCHECK_BLOG_NOTE).toContain("every claim, number, date, name, version and quote must be in the source");
  });

  it("checks the plain text of the blocks against the source, and keeps the strict rules", async () => {
    const s = stub(NONE);
    await factcheckArticle(article({ blocks: true, body: "Heading\n\nA paragraph of the post." }), s.agent);
    expect(s.seen[0].prompt).toContain("Body: Heading\n\nA paragraph of the post.");
    expect(s.seen[0].system).toContain("Any claim not directly stated in the source");
    expect(s.seen[0].articleId).toBe("a1");
  });

  it("stores the result as for a plain article: minor findings go to review as a warning, major ones reject with the notes", async () => {
    expect(await factcheckArticle(article({ blocks: true }), stub(NONE).agent)).toEqual({ kind: "update", update: { status: "pending_review", fact_check_notes: null } });
    expect(await factcheckArticle(article({ blocks: true }), stub({ findings: [{ severity: "minor", issue: "Calls it a rewrite of retries." }] }).agent)).toEqual({
      kind: "update",
      update: { status: "pending_review", fact_check_notes: "- Minor: Calls it a rewrite of retries." },
    });
    const failed = await factcheckArticle(
      article({ blocks: true }),
      stub({ findings: [{ severity: "major", issue: "Version 3.0 is not in the source." }, { severity: "major", issue: "Mail ada@example.com" }] }).agent,
    );
    expect(failed).toEqual({ kind: "update", update: { status: "rejected", fact_check_notes: "- Major: Version 3.0 is not in the source.\n- Major: Mail [email removed]" } });
  });

  it("is not sent to the writer for a repair: its blocks can't be rebuilt from the checked text", async () => {
    const s = stub({ findings: [{ severity: "major", issue: "Invented version." }] });
    const d = await factcheckArticle(article({ blocks: true }), s.agent);
    expect(d).toMatchObject({ kind: "update", update: { status: "rejected" } });
    expect(d).not.toHaveProperty("repaired");
    expect(s.seen.map((p) => p.agent)).toEqual(["factcheck"]);
  });

  it("a plain article gets the original prompt, unchanged", async () => {
    const s = stub(NONE);
    await factcheckArticle(article(), s.agent);
    expect(s.seen[0].system).toBe(FACTCHECK_SYSTEM);
    expect(s.seen[0].system).not.toContain("code samples");
  });

  it("without the source nothing is let through, blocks or not", async () => {
    const agent = vi.fn();
    const d = await factcheckArticle(article({ blocks: true, source: null }), agent as never);
    expect(d).toMatchObject({ kind: "update", update: { status: "rejected" } });
    expect(agent).not.toHaveBeenCalled();
  });
});
