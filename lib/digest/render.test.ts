import { describe, expect, it } from "vitest";
import { article } from "./memory-store";
import { esc, LEAD_IMAGE, renderDigest, safeUrl, sizedImageUrl, storyUrl, THUMB_IMAGE, type RenderInput } from "./render";

const SITE = "https://newsroom.example.com";
const lead = article("a1", { headline: "Nordic charging network adds 400 chargers", department: { name: "EV", slug: "ev" } });
const others = [
  article("b2", { headline: "Solid-state pilot line starts", department: { name: "Batteries", slug: "batteries" }, image_url: null }),
  article("c3", { headline: "Ministry orders drones", department: { name: "Defence", slug: "defence" } }),
];

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  subject: "Company Newsroom weekly: Nordic charging network adds 400 chargers",
  intro: "Here is the week.",
  weekStart: "2026-10-12",
  siteUrl: SITE,
  articles: [lead, ...others],
  contact: "newsroom@example.com",
  ...over,
});

describe("renderDigest structure", () => {
  const { html, subject } = renderDigest(input());

  it("is table based, 600px wide (fluid below that), with every style inline", () => {
    // Outlook desktop ignores max-width, so it gets a fixed 600px table through a conditional comment;
    // every other client gets a fluid table that stops at 600px (no horizontal scroll on a phone).
    expect(html).toContain('<!--[if mso]><table role="presentation" width="600" align="center"');
    expect(html).toContain('<![endif]-->');
    expect(html).toMatch(/<table role="presentation" width="100%"[^>]*style="width:100%;max-width:600px;"/);
    expect(html).not.toMatch(/<style[\s>]/i); // no style block: all CSS is inline
    expect(html).not.toMatch(/display:\s*(flex|grid)|flex-|grid-|position:\s*(absolute|fixed)/i);
    expect(html).not.toMatch(/<script|javascript:|@import|@font-face|<link/i);
    expect(html).not.toMatch(/<(div|p)[^>]*style="[^"]*float/i);
  });

  it("uses bgcolor attributes as well as CSS backgrounds, and the palette", () => {
    expect(html).toContain('bgcolor="#FAF7F0"');
    expect(html).toContain("background-color:#FAF7F0");
    expect(html).toContain('bgcolor="#FFFFFF"');
    expect(html).toContain("color:#2C352F"); // ink
    expect(html).toContain("color:#657166"); // sage meta text
  });

  it("uses Georgia for headlines and Arial for body text, no web fonts", () => {
    expect(html).toContain("font-family:Georgia");
    expect(html).toContain("font-family:Arial");
    expect(html).not.toMatch(/fonts\.googleapis|font-family:\s*['"]?(Newsreader|Hanken)/i);
  });

  it("has a white header with the name and the week", () => {
    expect(html).toContain("Company Newsroom</div>");
    expect(html).toContain("Week of 12 October 2026");
  });

  it("puts the subject in the title and the intro in the body", () => {
    expect(subject).toBe("Company Newsroom weekly: Nordic charging network adds 400 chargers");
    expect(html).toContain(`<title>${subject}</title>`);
    expect(html).toContain("Here is the week.");
  });

  it("shows the lead: image with absolute https URL and explicit size, tag, headline, summary, button, source, date, credit", () => {
    expect(html).toMatch(/<img src="https:\/\/images\.unsplash\.com\/photo-a1\?[^"]*" alt="Alt for a1" width="600" height="338"/);
    expect(html).toContain(`width="${LEAD_IMAGE.width}" height="${LEAD_IMAGE.height}"`);
    expect(html).toContain(">EV</td>"); // the department tag
    expect(html).toContain("Nordic charging network adds 400 chargers");
    expect(html).toContain("First sentence of the story. Second sentence adds detail. Third sentence closes it.");
    expect(html).not.toContain("Fourth is cut"); // 2-3 sentences
    expect(html).toContain(`href="${SITE}/?story=slug-a1"`);
    expect(html).toContain("Source: <a");
    expect(html).toContain(">example.com</a>");
    expect(html).toContain("Source published 12 October 2026");
    expect(html).toContain("Photo: <a");
    expect(html).toContain("Ada Photographer");
  });

  it("makes the Read more button a table cell, so Outlook keeps its colour and padding", () => {
    expect(html).toMatch(/<td align="center" bgcolor="#657166" style="[^"]*padding:12px 26px[^"]*"><a href="[^"]+\?story=slug-a1"[^>]*>[\s\S]*Read more/);
  });

  it("lists the other stories with a thumbnail, headline, one line and a link", () => {
    expect(html).toContain("Also this week");
    expect(html).toContain("Solid-state pilot line starts");
    expect(html).toContain("Ministry orders drones");
    expect(html).toContain(`width="${THUMB_IMAGE.width}" height="${THUMB_IMAGE.height}"`);
    expect(html).toContain(`href="${SITE}/?story=slug-b2"`);
    expect(html).toContain("First sentence of the story."); // the one-liner
    // a story without a photo gets a coloured block instead of a broken image
    expect(html.match(/<img /g)).toHaveLength(2); // lead + c3; b2 has no photo
  });

  it("ends with the AI note, the dashboard link and a contact line", () => {
    expect(html).toContain("AI-generated summaries, reviewed by an editor before circulation.");
    expect(html).toContain(`href="${SITE}/"`); // the dashboard link
    expect(html).toContain('href="mailto:newsroom@example.com"');
  });

  it("falls back to a reply line when there is no contact address", () => {
    expect(renderDigest(input({ contact: null })).html).toContain("Reply to this email to reach the editors.");
  });
});

describe("images", () => {
  it("asks Unsplash for crops at 2x the displayed size, keeping its other parameters", () => {
    const url = sizedImageUrl("https://images.unsplash.com/photo-1?ixid=abc&w=1080&q=80", 600, 338);
    const u = new URL(url);
    expect(u.searchParams.get("w")).toBe("1200");
    expect(u.searchParams.get("h")).toBe("676");
    expect(u.searchParams.get("fit")).toBe("crop");
    expect(u.searchParams.get("ixid")).toBe("abc");
    expect(sizedImageUrl("https://cdn.example.com/x.jpg", 600, 338)).toBe("https://cdn.example.com/x.jpg");
  });

  it("references the lead image by cid when one is attached", () => {
    const { html } = renderDigest(input({ leadImageCid: "lead-image@company-newsroom" }));
    expect(html).toContain('<img src="cid:lead-image@company-newsroom"');
    expect(html).toContain('alt="Alt for a1"');
  });

  it("never uses a department default SVG or a relative path as an image", () => {
    const { html } = renderDigest(input({ articles: [{ ...lead, image_url: "/images/defaults/ev.svg" }] }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/images/defaults");
  });

  it("falls back to the headline as alt text", () => {
    const { html } = renderDigest(input({ articles: [{ ...lead, image_alt: null }] }));
    expect(html).toContain('alt="Nordic charging network adds 400 chargers"');
  });
});

describe("single-story digest", () => {
  const out = renderDigest(input({ articles: [lead] }));
  it("has no 'Also this week' section", () => {
    expect(out.html).not.toContain("Also this week");
    expect(out.text).not.toContain("ALSO THIS WEEK");
    expect(out.html).toContain("Nordic charging network adds 400 chargers");
  });
  it("still has the full lead and footer", () => {
    expect(out.html).toContain("Read more");
    expect(out.html).toContain("AI-generated summaries");
  });
});

describe("plain-text version", () => {
  const { text } = renderDigest(input());
  it("is always generated and carries the same content", () => {
    expect(text).toContain("COMPANY NEWSROOM - Weekly digest");
    expect(text).toContain("Week of 12 October 2026");
    expect(text).toContain("Here is the week.");
    expect(text).toContain("NORDIC CHARGING NETWORK ADDS 400 CHARGERS");
    expect(text).toContain(`Read more: ${SITE}/?story=slug-a1`);
    expect(text).toContain("Source: example.com (https://www.example.com/news/a1) - published 12 October 2026");
    expect(text).toContain("Photo: Ada Photographer");
    expect(text).toContain("ALSO THIS WEEK");
    expect(text).toContain(`${SITE}/?story=slug-c3`);
    expect(text).toContain("AI-generated summaries, reviewed by an editor before circulation.");
    expect(text).toContain("Contact: newsroom@example.com");
  });
  it("has no HTML in it", () => {
    expect(text).not.toMatch(/<[a-z/][^>]*>/i);
  });
});

describe("escaping", () => {
  const evil = '<script>alert(1)</script> "quoted" & \'single\'';
  const bad = article("x9", {
    headline: evil,
    body: `Body with ${evil}. Second sentence <b>bold</b>.`,
    department: { name: evil, slug: "ev" },
    image_alt: evil,
    image_credit: evil,
    source_urls: ["javascript:alert(1)"],
    image_credit_url: "javascript:alert(2)",
    slug: 'a"b<c>&d e',
  });
  const out = renderDigest(
    input({ subject: `Subject ${evil}\r\nBcc: attacker@example.com`, intro: evil, contact: 'evil"@example.com', articles: [bad, { ...bad, id: "y8" }] }),
  );

  it("escapes every piece of text and attribute", () => {
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<b>bold</b>");
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;single&#39;");
    expect(out.html).not.toMatch(/alt="[^"]*"[^>]*"quoted"/); // no attribute break-out
  });

  it("drops non-web links instead of emitting them", () => {
    expect(out.html).not.toMatch(/href="javascript:/i);
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
  });

  it("encodes the slug in the story link", () => {
    expect(out.html).toContain(`${SITE}/?story=a%22b%3Cc%3E%26d%20e`);
    expect(storyUrl(`${SITE}/`, "a b")).toBe(`${SITE}/?story=a%20b`);
  });

  it("keeps the subject on one line, so it cannot add a header", () => {
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).not.toMatch(/<title>[^<]*[\r\n]/);
  });

  it("esc handles the five special characters", () => {
    expect(esc(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("does not put unescaped markup in the text version's links", () => {
    expect(out.text).not.toContain("javascript:");
  });
});

describe("snapshot", () => {
  it("full HTML for a lead and two others", () => {
    expect(renderDigest(input()).html).toMatchSnapshot();
  });
  it("plain text for a lead and two others", () => {
    expect(renderDigest(input()).text).toMatchSnapshot();
  });
  it("full HTML for a single story with an inline lead image", () => {
    expect(renderDigest(input({ articles: [lead], leadImageCid: "lead-image@company-newsroom", contact: null })).html).toMatchSnapshot();
  });
});
