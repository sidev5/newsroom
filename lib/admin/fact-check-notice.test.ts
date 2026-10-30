import { describe, expect, it } from "vitest";
import { formatFindings } from "@/lib/pipeline/factcheck";
import { factCheckNotice } from "./review-view";

// The fact-check box on a pending card: passed, passed with minor wording warnings, or flagged claims kept from before a restore.

describe("factCheckNotice", () => {
  it("no notes: passed", () => {
    expect(factCheckNotice(null)).toEqual({ kind: "passed" });
    expect(factCheckNotice("  \n ")).toEqual({ kind: "passed" });
  });

  it("only minor findings, as the fact-check stores them: a warning that lists them without the label", () => {
    const notes = formatFindings([
      { severity: "minor", issue: "Says 'plain-text' where the source says 'TXT'." },
      { severity: "minor", issue: "Calls the release an update." },
    ]);
    expect(factCheckNotice(notes)).toEqual({ kind: "minor", items: ["Says 'plain-text' where the source says 'TXT'.", "Calls the release an update."] });
  });

  it("any major finding on a pending story: the restored-article notes, as before", () => {
    const notes = formatFindings([
      { severity: "minor", issue: "Wording." },
      { severity: "major", issue: "Invented quote." },
    ]);
    expect(notes).toBe("- Major: Invented quote.\n- Minor: Wording.");
    expect(factCheckNotice(notes)).toEqual({ kind: "restored", items: ["Major: Invented quote.", "Minor: Wording."] });
  });

  it("notes from before severities existed (no label) are treated as restored claims", () => {
    expect(factCheckNotice("- Wrong date\n- Invented quote")).toEqual({ kind: "restored", items: ["Wrong date", "Invented quote"] });
  });
});
