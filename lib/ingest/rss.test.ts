import { describe, expect, it } from "vitest";
import { normalizeUrl, parseFeed, parseFeedDate } from "./rss";
import { capText, htmlToText } from "./text";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example</title>
    <item>
      <title>New &amp; improved battery cell</title>
      <link>https://news.example.com/a?utm_source=rss&amp;id=7#top</link>
      <pubDate>Sat, 10 Oct 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Short <b>summary</b>.</p><script>alert(1)</script>]]></description>
      <content:encoded><![CDATA[<p>First paragraph.</p><p>Second&nbsp;paragraph.</p>]]></content:encoded>
    </item>
    <item>
      <title>2024</title>
      <link>https://news.example.com/b</link>
      <description>Plain description</description>
    </item>
    <item>
      <title>No link here</title>
      <description>dropped</description>
    </item>
    <item>
      <title></title>
      <link>https://news.example.com/untitled</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom example</title>
  <entry>
    <title type="html">Defence &lt;em&gt;contract&lt;/em&gt; awarded</title>
    <link rel="self" href="https://atom.example.com/self/1"/>
    <link rel="alternate" href="https://atom.example.com/posts/1"/>
    <summary>Atom summary</summary>
    <published>2026-10-09T12:30:00Z</published>
    <updated>2026-10-11T00:00:00Z</updated>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS 2.0 items, preferring content:encoded and stripping HTML", () => {
    const items = parseFeed(RSS);
    expect(items[0]).toEqual({
      url: "https://news.example.com/a?id=7",
      title: "New & improved battery cell",
      content: "First paragraph.\nSecond paragraph.",
      publishedAt: "2026-10-10T08:00:00.000Z",
    });
  });

  it("keeps numeric-looking titles as text and falls back to description", () => {
    expect(parseFeed(RSS)[1]).toEqual({
      url: "https://news.example.com/b",
      title: "2024",
      content: "Plain description",
      publishedAt: null,
    });
  });

  it("drops entries with no link or no title", () => {
    expect(parseFeed(RSS).map((i) => i.url)).toEqual([
      "https://news.example.com/a?id=7",
      "https://news.example.com/b",
    ]);
  });

  it("handles a feed with a single item", () => {
    const one = `<rss><channel><item><title>Only</title><link>https://x.example.com/1</link></item></channel></rss>`;
    expect(parseFeed(one)).toHaveLength(1);
  });

  it("parses Atom entries using the alternate link", () => {
    expect(parseFeed(ATOM)).toEqual([
      { url: "https://atom.example.com/posts/1", title: "Defence contract awarded", content: "Atom summary", publishedAt: "2026-10-09T12:30:00.000Z" },
    ]);
  });

  describe("parseFeedDate", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    it("normalises RFC 822 and ISO dates", () => {
      expect(parseFeedDate("Sat, 10 Oct 2026 08:00:00 GMT", now)).toBe("2026-10-10T08:00:00.000Z");
      expect(parseFeedDate("2026-10-09T12:30:00+02:00", now)).toBe("2026-10-09T10:30:00.000Z");
    });
    it("returns null for empty, invalid or far-future dates", () => {
      expect(parseFeedDate("", now)).toBeNull();
      expect(parseFeedDate("last Tuesday-ish", now)).toBeNull();
      expect(parseFeedDate("2027-01-01T00:00:00Z", now)).toBeNull();
    });
  });

  it("resolves relative links against the feed URL", () => {
    const rel = `<rss><channel><item><title>Rel</title><link>/posts/9</link></item></channel></rss>`;
    expect(parseFeed(rel, "https://site.example.com/feed.xml")[0].url).toBe("https://site.example.com/posts/9");
  });

  it("returns no items for an empty channel", () => {
    expect(parseFeed(`<rss><channel><title>Empty</title></channel></rss>`)).toEqual([]);
  });

  it("throws on documents that are not feeds", () => {
    expect(() => parseFeed("<html><body>Not a feed</body></html>")).toThrow(/Not an RSS or Atom feed/);
  });
});

describe("normalizeUrl", () => {
  it("removes fragments and tracking parameters but keeps others", () => {
    expect(normalizeUrl("https://a.example.com/p?utm_medium=x&fbclid=y&page=2#c")).toBe(
      "https://a.example.com/p?page=2",
    );
  });

  it("rejects non-http schemes and garbage", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("htmlToText / capText", () => {
  it("removes scripts and styles", () => {
    expect(htmlToText("<style>p{}</style><p>Hi</p><script>x()</script>")).toBe("Hi");
  });

  it("caps long text at a word boundary", () => {
    const capped = capText("word ".repeat(10_000), 20_000);
    expect(capped.length).toBeLessThanOrEqual(20_000);
    expect(capped.endsWith("word")).toBe(true);
  });
});
