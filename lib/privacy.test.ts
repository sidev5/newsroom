import { describe, expect, it } from "vitest";
import { restoreNote } from "@/lib/admin/recover";
import { factcheckArticle } from "@/lib/pipeline/factcheck";
import { containsEmail, redactEmails } from "./privacy";

describe("redactEmails", () => {
  it("replaces every address, whatever its shape", () => {
    expect(redactEmails("Restored by (first.last+tag@Company-Mail.co.uk) and o'brien@x.io, a_b%c@sub.d.example.org.")).toBe(
      "Restored by (an editor) and an editor, an editor.",
    );
    expect(redactEmails("write to a@b.c or ab@cd.ef", "[email removed]")).toBe("write to a@b.c or [email removed]"); // a@b.c: one-letter TLD is not an address
  });

  it("leaves text without an address untouched, including @ signs that are not addresses", () => {
    for (const s of ["No address here.", "Price @ 5 dollars", "@handle on social media", "50% off @ noon"]) expect(redactEmails(s)).toBe(s);
  });

  it("detects addresses", () => {
    expect(containsEmail("mail me: x@y.com")).toBe(true);
    expect(containsEmail("nothing")).toBe(false);
    expect(containsEmail("x@y.com")).toBe(true); // repeatable: no sticky regex state
    expect(containsEmail("x@y.com")).toBe(true);
  });
});

describe("restore notes never carry an address (SEC-01)", () => {
  it("does not name the admin and says an editor restored it", () => {
    const note = restoreNote({ fact_check_notes: "- Wrong date", editor_reason: null });
    expect(note).toBe("Restored by an editor, fact-check had flagged: Wrong date");
    expect(containsEmail(note)).toBe(false);
  });

  it("blanks an address typed into an editor's reason or quoted in a fact-check claim", () => {
    const a = restoreNote({ fact_check_notes: null, editor_reason: "Ask jane.doe@company.com about this" });
    expect(a).toBe("Restored by an editor; it had been rejected by an editor: Ask an editor about this");
    const b = restoreNote({ fact_check_notes: "- The draft quotes press@vendor.example as the contact", editor_reason: null });
    expect(containsEmail(b)).toBe(false);
  });
});

describe("fact-check notes never carry an address", () => {
  it("redacts addresses in the issues the model lists", async () => {
    const findings = [
      { severity: "major", issue: "Quotes the contact press@vendor.example, which the source does not state" },
      { severity: "minor", issue: "Wrong date" },
    ];
    // The writer's repair fails, so the draft is rejected with the first findings.
    const agent = (async (p: { agent: string; schema: { parse: (v: unknown) => unknown } }) =>
      p.agent === "write"
        ? { ok: false, reason: "invalid_output", error: "no repair" }
        : { ok: true, data: p.schema.parse({ findings }), attempts: 1 }) as never;
    const d = await factcheckArticle(
      { id: "a1", raw_item_id: "r1", headline: "H", body: "B", source: { title: "T", content: "c", full_text: "text ".repeat(50), source_published_at: null } } as never,
      agent,
    );
    expect(d).toMatchObject({ kind: "update", update: { status: "rejected" } });
    const notes = (d as { update: { fact_check_notes: string } }).update.fact_check_notes;
    expect(notes).toBe("- Major: Quotes the contact [email removed], which the source does not state\n- Minor: Wrong date");
    expect(containsEmail(notes)).toBe(false);
  });
});
