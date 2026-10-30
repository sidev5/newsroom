// Choosing and summarising the stories for a digest. Deterministic, no LLM. Pure.
import { SUBJECT_MAX, SUBJECT_PREFIX, type DigestArticle } from "./types";

const time = (a: DigestArticle) => {
  const t = a.published_at ? new Date(a.published_at).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

/** Newest first; ties broken by id so the order never depends on input order. */
export function newestFirst(articles: DigestArticle[]): DigestArticle[] {
  return [...articles].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}

/** A real photo usable in email: an absolute https URL. Department default SVGs (/images/...) are not. */
export function hasPhoto(a: Pick<DigestArticle, "image_url">): boolean {
  if (!a.image_url) return false;
  try {
    return new URL(a.image_url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The lead is the newest story that has a photo (the newest story if none has one); the others are
 * added newest first but always from the department with the fewest stories so far, so one department
 * cannot take over the digest. `max` 1 gives a single-story digest.
 */
export function selectStories(candidates: DigestArticle[], max: number): DigestArticle[] {
  const sorted = newestFirst(candidates);
  if (sorted.length === 0 || max < 1) return [];

  const lead = sorted.find(hasPhoto) ?? sorted[0];
  const picked = [lead];
  const rest = sorted.filter((a) => a.id !== lead.id);
  const counts = new Map<string, number>();
  const key = (a: DigestArticle) => a.department?.slug ?? "_none";
  counts.set(key(lead), 1);

  while (picked.length < max && rest.length > 0) {
    let best = 0;
    for (let i = 1; i < rest.length; i++) {
      if ((counts.get(key(rest[i])) ?? 0) < (counts.get(key(rest[best])) ?? 0)) best = i; // strict: ties keep the newest
    }
    const [next] = rest.splice(best, 1);
    picked.push(next);
    counts.set(key(next), (counts.get(key(next)) ?? 0) + 1);
  }
  return picked;
}

// ---- Text -------------------------------------------------------------------------------------

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function sentences(body: string): string[] {
  return clean(body)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“‘(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The first 2-3 sentences of the body, within `maxChars` (whole sentences where possible). */
export function summarySentences(body: string, maxSentences = 3, maxChars = 380): string {
  const all = sentences(body);
  let out = "";
  for (const s of all.slice(0, maxSentences)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > maxChars) break;
    out = next;
  }
  return out || clip(all[0] ?? "", maxChars);
}

/** One line for the "Also this week" list. */
export function oneLiner(body: string, maxChars = 130): string {
  return clip(sentences(body)[0] ?? "", maxChars);
}

/** "Company Newsroom weekly: <lead headline>", at most 90 characters. */
export function digestSubject(leadHeadline: string): string {
  const headline = clean(leadHeadline);
  const room = SUBJECT_MAX - SUBJECT_PREFIX.length;
  return `${SUBJECT_PREFIX}${clip(headline, room)}`;
}
