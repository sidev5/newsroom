import { XMLParser } from "fast-xml-parser";
import { capText, htmlToText, MAX_SUMMARY_CHARS } from "./text";

export type FeedItem = {
  url: string;
  title: string;
  /** Plain-text summary from the feed (HTML stripped). */
  content: string;
  /** ISO 8601 publication date from the feed, or null if missing or unparseable. */
  publishedAt: string | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep "2024" as a string, not a number
  isArray: (name) => name === "item" || name === "entry",
});

/** Text of a node that may be a string, a {#text, @_attr} object, or missing. */
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "object" && "#text" in node) return textOf((node as Record<string, unknown>)["#text"]);
  return "";
}

/** RSS <link>text</link>, or Atom <link href rel="alternate"/> (possibly several). */
function linkOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  const links = (Array.isArray(node) ? node : [node]) as Array<Record<string, unknown> | string>;
  const alternate =
    links.find((l) => typeof l === "object" && (l["@_rel"] ?? "alternate") === "alternate") ?? links[0];
  if (typeof alternate === "string") return alternate;
  return textOf(alternate?.["@_href"]) || textOf(alternate);
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Canonical form for dedupe: http(s) only, no fragment, no tracking params. Null if unusable. */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** RSS pubDate / dc:date / Atom published|updated -> ISO string. Null when absent, invalid, or more than a day in the future. */
export function parseFeedDate(raw: string, now: Date = new Date()): string | null {
  const value = raw.trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return null;
  return date.toISOString();
}

/** Parse RSS 2.0 or Atom XML into items. Entries without a usable link or title are dropped. */
export function parseFeed(xml: string, feedUrl?: string): FeedItem[] {
  type Entries = Array<Record<string, unknown>> | undefined;
  type FeedDoc = {
    rss?: { channel?: { item?: Entries } };
    "rdf:RDF"?: { item?: Entries };
    feed?: { entry?: Entries };
  };
  const doc = parser.parse(xml) as FeedDoc;

  const rssItems = doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item;
  const atomEntries = doc.feed?.entry;
  const raw = rssItems ?? atomEntries ?? [];
  if (!rssItems && !atomEntries && !doc.rss && !doc.feed && !doc["rdf:RDF"]) {
    throw new Error("Not an RSS or Atom feed");
  }

  const items: FeedItem[] = [];
  for (const entry of raw) {
    const url = normalizeUrl(linkOf(entry.link) || textOf(entry.guid), feedUrl);
    const title = htmlToText(textOf(entry.title));
    if (!url || !title) continue;
    const html =
      textOf(entry["content:encoded"]) ||
      textOf(entry.description) ||
      textOf(entry.content) ||
      textOf(entry.summary);
    const publishedAt = parseFeedDate(
      textOf(entry.pubDate) || textOf(entry["dc:date"]) || textOf(entry.published) || textOf(entry.updated),
    );
    items.push({ url, title, content: capText(htmlToText(html), MAX_SUMMARY_CHARS), publishedAt });
  }
  return items;
}

