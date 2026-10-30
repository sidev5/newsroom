import { describe, expect, it } from "vitest";

// A policy without 'unsafe-eval' must not be tripped by the form's own validation: with the Write form's setting, parsing a story
// never constructs a function from a string.

describe("the browser-side validation of a story", () => {
  it("does not evaluate strings as code (no `new Function`), so it works under a CSP without 'unsafe-eval'", async () => {
    await import("./csp-safe-zod");
    const constructed: string[] = [];
    const RealFunction = globalThis.Function;
    // Anything that builds code from a string goes through the Function constructor; record it.
    const Spy = new Proxy(RealFunction, {
      construct(target, args) {
        constructed.push(String(args.at(-1)).slice(0, 40));
        return Reflect.construct(target, args);
      },
    });
    globalThis.Function = Spy as FunctionConstructor;
    try {
      const { parseSubmittedDoc } = await import("@/lib/stories/blocks");
      const { storyFieldsSchema } = await import("@/lib/stories/fields");
      const prose = "The pilot line reached its first production milestone this quarter, with output rising steadily. ".repeat(3);
      const r = parseSubmittedDoc({ v: 1, blocks: [{ id: "a", type: "paragraph", text: prose }, { id: "b", type: "code", language: "js", code: "x" }, { id: "c", type: "list", ordered: true, items: ["a"] }] });
      expect(r.ok).toBe(true);
      expect(parseSubmittedDoc({ v: 1, blocks: [{ id: "a", type: "script" }] }).ok).toBe(false);
      expect(storyFieldsSchema({ allowedDomains: [], sectors: ["ev"] }).safeParse({ firstName: "A", lastName: "B", email: "a@b.co", authorDepartment: "x", sector: "ev", title: "A title", summary: "", country: "", showName: "on", ownWork: "on", noConfidential: "on" }).success).toBe(false); // wrong department, but it parsed
    } finally {
      globalThis.Function = RealFunction;
    }
    expect(constructed).toEqual([]);
  });
});