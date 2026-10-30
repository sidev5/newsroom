// In-memory DigestStore and RecipientStore for tests. update() is a synchronous check-and-set, which is
// what makes it behave like the database's `update ... where status = ...`: of two callers, one wins.
import type { Recipient, RecipientStore } from "./recipients";
import type { DigestStore, NewDigest } from "./service";
import type { DigestArticle, DigestRow, DigestStatus } from "./types";

export type LogEntry = { digestId: string | null; action: string; actor: string; detail?: Record<string, unknown> };

export function createMemoryStore(seed: { articles?: DigestArticle[]; digests?: DigestRow[]; recipients?: string[] } = {}) {
  const articles = [...(seed.articles ?? [])];
  const digests = [...(seed.digests ?? [])];
  const recipients: Recipient[] = (seed.recipients ?? []).map((email, i) => ({ id: `r${i}`, email, active: true }));
  const logs: LogEntry[] = [];
  /** Like a database read: the caller gets a copy, not the stored row. */
  const copy = (d: DigestRow | undefined): DigestRow | null => (d ? { ...d, article_ids: [...d.article_ids] } : null);
  let n = digests.length;

  const store: DigestStore = {
    async getByWeek(week) {
      return copy(digests.find((d) => d.week_start === week));
    },
    async getById(id) {
      return copy(digests.find((d) => d.id === id));
    },
    async current(week) {
      return copy([...digests].filter((d) => d.week_start <= week).sort((a, b) => b.week_start.localeCompare(a.week_start))[0]);
    },
    async insertIfAbsent(row: NewDigest) {
      if (digests.some((d) => d.week_start === row.week_start)) return null;
      const now = new Date().toISOString();
      const saved: DigestRow = { ...row, id: `d${++n}`, created_at: now, updated_at: now };
      digests.push(saved);
      return copy(saved);
    },
    async update(id, patch, from: DigestStatus[], opts) {
      const d = digests.find((x) => x.id === id);
      if (!d || !from.includes(d.status)) return null;
      if (opts?.reminderUnsent && d.reminder_sent_at) return null;
      Object.assign(d, patch, { updated_at: new Date().toISOString() });
      return copy(d);
    },
    async usedArticleIds(beforeWeek) {
      return new Set(
        digests.filter((d) => d.week_start < beforeWeek && ["approved", "sending", "sent"].includes(d.status)).flatMap((d) => d.article_ids),
      );
    },
    async candidates(sinceIso) {
      return articles
        .filter((a) => a.published_at && a.published_at >= sinceIso)
        .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
    },
    async articles(ids) {
      return ids.map((id) => articles.find((a) => a.id === id)).filter((a): a is DigestArticle => Boolean(a));
    },
    async activeRecipients() {
      return recipients.filter((r) => r.active).map((r) => r.email);
    },
    async log(digestId, action, actor, detail) {
      logs.push({ digestId, action, actor, detail });
    },
    async lastFailure(digestId) {
      const last = [...logs].reverse().find((l) => l.digestId === digestId && l.action === "send_failed");
      return last ? { at: "", error: String(last.detail?.error ?? "") } : null;
    },
  };

  const recipientStore: RecipientStore = {
    async list() {
      return [...recipients];
    },
    async add(emails) {
      let added = 0;
      for (const email of emails) {
        if (recipients.some((r) => r.email === email)) continue;
        recipients.push({ id: `r${recipients.length}`, email, active: true });
        added++;
      }
      return added;
    },
    async remove(id) {
      const i = recipients.findIndex((r) => r.id === id);
      if (i === -1) return false;
      recipients.splice(i, 1);
      return true;
    },
    async setActive(id, active) {
      const r = recipients.find((x) => x.id === id);
      if (!r) return false;
      r.active = active;
      return true;
    },
  };

  return { store, recipientStore, articles, digests, recipients, logs };
}

export function article(id: string, over: Partial<DigestArticle> = {}): DigestArticle {
  return {
    id,
    slug: `slug-${id}`,
    headline: `Headline ${id}`,
    body: "First sentence of the story. Second sentence adds detail. Third sentence closes it. Fourth is cut.",
    department: { name: "EV", slug: "ev" },
    country_name: "Germany",
    image_url: `https://images.unsplash.com/photo-${id}?ixid=abc&w=1080`,
    image_alt: `Alt for ${id}`,
    image_credit: "Ada Photographer",
    image_credit_url: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral",
    source_urls: [`https://www.example.com/news/${id}`],
    source_published_at: "2026-10-12T08:00:00.000Z",
    published_at: "2026-10-14T08:00:00.000Z",
    origin: "ai",
    author_first_name: null,
    author_last_name: null,
    author_department: null,
    ...over,
  };
}

export function digestRow(over: Partial<DigestRow> = {}): DigestRow {
  return {
    id: "d1",
    week_start: "2026-10-12",
    status: "draft",
    subject: "Company Newsroom weekly: Headline a1",
    intro: "Intro.",
    lead_article_id: "a1",
    article_ids: ["a1"],
    approved_by: null,
    approved_at: null,
    sent_at: null,
    error: null,
    recipient_count: null,
    reminder_sent_at: null,
    created_at: "2026-10-12T03:00:00.000Z",
    updated_at: "2026-10-12T03:00:00.000Z",
    ...over,
  };
}
