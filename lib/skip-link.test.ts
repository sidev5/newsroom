import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A skip-to-content link (the audit's accessibility note): the first focusable thing on every page, jumping to its main content.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("skip link", () => {
  const layout = read("app/layout.tsx");

  it("is the first element of the body, hidden until it has keyboard focus", () => {
    const body = layout.slice(layout.indexOf("<body"));
    expect(body.indexOf('href="#main-content"')).toBeGreaterThan(-1);
    expect(body.indexOf('href="#main-content"')).toBeLessThan(body.indexOf("{children}"));
    expect(layout).toMatch(/className="sr-only focus:not-sr-only/);
    expect(layout).toContain("Skip to content");
  });

  it("every kind of page has the target, which can take focus", () => {
    const targets: [string, string][] = [
      ["homepage (the feed)", "components/dashboard/FeedPanel.tsx"],
      ["article page", "app/article/[slug]/page.tsx"],
      ["/submit", "app/submit/page.tsx"],
      ["thanks page", "app/submit/thanks/page.tsx"],
      ["admin login", "app/admin/login/page.tsx"],
      ["admin pages", "app/admin/(protected)/layout.tsx"],
    ];
    for (const [name, file] of targets) {
      const text = read(file);
      expect(text, name).toContain('id="main-content"');
      expect(text, name).toContain("tabIndex={-1}"); // a plain element needs this to receive focus from the link
    }
  });

  it("each page has exactly one target", () => {
    for (const file of ["components/dashboard/FeedPanel.tsx", "app/article/[slug]/page.tsx", "app/submit/page.tsx", "app/admin/(protected)/layout.tsx"]) {
      expect(read(file).match(/id="main-content"/g), file).toHaveLength(1);
    }
  });
});
