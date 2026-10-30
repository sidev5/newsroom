import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BlocksDoc } from "@/lib/stories/blocks";
import { BlocksView } from "./BlocksView";
import { COPIED_MS, copyText, createCopyAction, type CopyEnv, type CopyState } from "./copy";

// What the reader draws from a story: never raw HTML (a malicious block is shown as text), links that are safe, and the
// behaviour of the Copy button of a code block.

const SCRIPT = "<script>alert(1)</script>";
const IMG = '<img src=x onerror="alert(document.cookie)">';
const doc = (...blocks: unknown[]) => ({ v: 1, blocks }) as BlocksDoc;
const html = (d: BlocksDoc, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(BlocksView, { doc: d, ...props }));

describe("a malicious story is drawn as text, never as HTML", () => {
  const hostile = doc(
    { id: "a", type: "paragraph", text: `${SCRIPT} ${IMG}` },
    { id: "b", type: "heading", level: 2, text: `${SCRIPT}` },
    { id: "c", type: "heading", level: 3, text: IMG },
    { id: "d", type: "quote", text: SCRIPT, cite: IMG },
    { id: "e", type: "list", ordered: false, items: [SCRIPT, IMG] },
    { id: "f", type: "list", ordered: true, items: [IMG] },
    { id: "g", type: "code", language: "html", filename: `${SCRIPT}.html`, code: `${SCRIPT}\n${IMG}` },
    { id: "h", type: "code", language: "plain", code: `${IMG}` },
    { id: "i", type: "link", url: "https://example.com/a", title: SCRIPT, description: IMG },
    { id: "j", type: "image", src: "https://evil.example/x.png", alt: IMG, caption: SCRIPT },
  );

  it("escapes every piece of text: no script, img, iframe or event-handler attribute is created", () => {
    const out = html(hostile);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<img\b[^>]*\bonerror/i);
    expect(out).not.toMatch(/<img src="?x/i);
    expect(out).not.toMatch(/<iframe|<svg|<style|<object|<embed/i);
    // No tag has an event-handler attribute. (Only real tags, without their quoted values, are looked at: escaped text and values may still contain the words.)
    for (const tag of out.match(/<[a-z][^>]*>/gi) ?? []) expect(tag.replace(/="[^"]*"/g, "=")).not.toMatch(/\son[a-z]+=/i);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(document.cookie)&quot;&gt;");
  });

  it("every element that is drawn comes from a short list", () => {
    const tags = new Set([...html(hostile).matchAll(/<([a-z0-9]+)[\s>/]/g)].map((m) => m[1]));
    const allowed = new Set(["div", "p", "h2", "h3", "h4", "blockquote", "footer", "ul", "ol", "li", "figure", "figcaption", "span", "button", "pre", "code", "a", "hr", "img"]);
    expect([...tags].filter((t) => !allowed.has(t))).toEqual([]);
  });

  it("an image that is not in the public bucket is not requested: it shows a placeholder", () => {
    const out = html(hostile);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("Image not available");
    expect(html(doc({ id: "x", type: "image", src: "javascript:alert(1)", alt: "a", caption: "" }))).not.toContain("javascript:");
    expect(html(doc({ id: "x", type: "image", src: "data:image/svg+xml,<svg onload=alert(1)>", alt: "a", caption: "" }))).not.toContain("data:");
  });

  it("an admin preview image comes only from the addresses the server passes in", () => {
    const out = html(doc({ id: "x", type: "image", path: "a/x.webp", alt: "A chart", caption: "Q3" }), { images: { x: "https://p.supabase.co/storage/v1/object/sign/submission-images/a/x.webp?token=t" } });
    expect(out).toContain('src="https://p.supabase.co/storage/v1/object/sign/submission-images/a/x.webp?token=t"');
    expect(out).toContain('alt="A chart"');
    expect(out).toContain("Q3");
  });

  it("the code stays text, with its tabs and spaces", () => {
    const out = html(doc({ id: "c", type: "code", language: "python", code: "def f():\n\treturn  1" }));
    expect(out).toContain("def f():\n\treturn  1");
    expect(out).toContain("whitespace-pre");
    expect(out).toContain("overflow-x-auto"); // long lines scroll, they do not wrap
  });
});

describe("links", () => {
  it("open in a new tab with rel noopener noreferrer nofollow, only for http and https", () => {
    const out = html(doc({ id: "l", type: "link", url: "https://www.example.com/report", title: "The report", description: "Read it" }));
    expect(out).toContain('href="https://www.example.com/report"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain("example.com");
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "vbscript:x", "//evil.example"])("%s is never a link, even if it got into the stored JSON", (url) => {
    const out = html(doc({ id: "l", type: "link", url, title: "Click me" }));
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
    expect(out).toContain("Click me");
  });

  it("every link that is drawn has the three rel values", () => {
    const out = html(doc({ id: "l", type: "link", url: "http://example.com", title: "t" }, { id: "m", type: "link", url: "https://example.org", title: "u" }));
    for (const a of out.match(/<a [^>]*>/g) ?? []) expect(a).toMatch(/rel="noopener noreferrer nofollow"/);
  });
});

describe("layout", () => {
  it("is a 680 px column in the serif body face, with every block type drawn", () => {
    const out = html(
      doc(
        { id: "a", type: "paragraph", text: "Body text." },
        { id: "b", type: "heading", level: 2, text: "Big" },
        { id: "c", type: "heading", level: 3, text: "Small" },
        { id: "d", type: "quote", text: "Said.", cite: "Someone" },
        { id: "e", type: "list", ordered: false, items: ["one"] },
        { id: "f", type: "list", ordered: true, items: ["first"] },
        { id: "g", type: "divider" },
      ),
    );
    expect(out).toContain("max-w-[680px]");
    expect(out).toContain("font-headline");
    for (const part of ["<p ", "<h2 ", "<h3 ", "<blockquote", "border-l-[3px]", "<ul ", "<ol ", "<hr "]) expect(out).toContain(part);
  });

  it("heading levels follow the page: <h2> on the article page, <h3> inside the reader", () => {
    const d = doc({ id: "b", type: "heading", level: 2, text: "Big" }, { id: "c", type: "heading", level: 3, text: "Small" });
    expect(html(d, { headingOffset: 0 })).toMatch(/<h2 [^>]*>Big<\/h2>[\s\S]*<h3 [^>]*>Small<\/h3>/);
    expect(html(d, { headingOffset: 1 })).toMatch(/<h3 [^>]*>Big<\/h3>[\s\S]*<h4 [^>]*>Small<\/h4>/);
  });

  it("a code block has a header bar with the language, the file name and a Copy button", () => {
    const out = html(doc({ id: "c", type: "code", language: "cpp", filename: "main.cpp", code: "int main() {}" }));
    expect(out).toContain("C/C++");
    expect(out).toContain("main.cpp");
    expect(out).toMatch(/<button[^>]*type="button"[^>]*>Copy<\/button>/);
    expect(out).toContain('aria-label="Copy the C/C++ code from main.cpp"');
  });
});

describe("the Copy button", () => {
  const code = "if (x) {\n\treturn  `a\tb`;\n}\n";

  it("copies the exact text, tabs and all, with the clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyText(code, { clipboard: { writeText } })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it("falls back to the old way when the clipboard API refuses or is missing", async () => {
    const legacy = vi.fn(() => true);
    expect(await copyText(code, { clipboard: { writeText: async () => { throw new Error("denied"); } }, legacyCopy: legacy })).toBe(true);
    expect(legacy).toHaveBeenCalledWith(code);
    expect(await copyText(code, { clipboard: null, legacyCopy: legacy })).toBe(true);
  });

  it("reports failure when nothing could copy", async () => {
    expect(await copyText(code, { clipboard: null })).toBe(false);
    expect(await copyText(code, { clipboard: null, legacyCopy: () => false })).toBe(false);
    expect(await copyText(code, { clipboard: null, legacyCopy: () => { throw new Error("no"); } })).toBe(false);
  });

  describe("the 'Copied' message", () => {
    const setup = (env: CopyEnv) => {
      const states: CopyState[] = [];
      const action = createCopyAction(() => env, (s) => states.push(s));
      return { states, action };
    };

    it("shows Copied, and goes back to Copy after two seconds", async () => {
      vi.useFakeTimers();
      try {
        const { states, action } = setup({ clipboard: { writeText: async () => {} } });
        await action.copy(code);
        expect(states).toEqual(["copied"]);
        vi.advanceTimersByTime(COPIED_MS - 1);
        expect(states).toEqual(["copied"]);
        vi.advanceTimersByTime(1);
        expect(states).toEqual(["copied", "idle"]);
        expect(COPIED_MS).toBe(2000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a second click inside the two seconds starts them again", async () => {
      vi.useFakeTimers();
      try {
        const { states, action } = setup({ clipboard: { writeText: async () => {} } });
        await action.copy(code);
        vi.advanceTimersByTime(1500);
        await action.copy(code);
        vi.advanceTimersByTime(1500);
        expect(states).toEqual(["copied", "copied"]); // not reset yet: 1.5 s since the second click
        vi.advanceTimersByTime(500);
        expect(states.at(-1)).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("says 'Copy failed' for two seconds when copying is not possible, and can be cancelled when the block goes away", async () => {
      vi.useFakeTimers();
      try {
        const { states, action } = setup({ clipboard: null });
        await action.copy(code);
        expect(states).toEqual(["failed"]);
        action.cancel();
        vi.advanceTimersByTime(5000);
        expect(states).toEqual(["failed"]); // the reset was cancelled: no state change after the component is gone
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("the story components never put text into the page as HTML", () => {
  const dirs = ["components/story", "components/write", "app/submit"];
  const files = dirs.flatMap((d) => {
    try {
      return readdirSync(new URL(`../../${d}/`, import.meta.url), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
        .map((e) => `${d}/${e.parentPath.replace(/\\/g, "/").split(`${d}`).pop()?.replace(/^\//, "") ?? ""}/${e.name}`.replace(/\/\//g, "/"));
    } catch {
      return [];
    }
  });

  it("finds the files to check", () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it.each(files)("%s has no dangerouslySetInnerHTML, innerHTML, eval or inline style attribute", (f) => {
    // Comments may name what the code avoids; only the code is checked.
    const source = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\b|\binsertAdjacentHTML\b|\beval\(|new Function\(|document\.write/);
    // The CSP needs no 'unsafe-inline' for these components' styles: they use classes. (A Turnstile / progress width would need one.)
    expect(source).not.toMatch(/\sstyle=\{/);
  });
});
