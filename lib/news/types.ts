import type { BlocksDoc } from "@/lib/stories/blocks";

export type StoryDepartment = { name: string; slug: string; kind?: "company" | "world" };

/** A published article as the article page and the reader see it. Never includes source text. */
export type Story = {
  id: string;
  slug: string;
  headline: string;
  body: string;
  /** About 240 characters from the start of the body, stored when the article is written or submitted. */
  summary: string;
  department: StoryDepartment | null;
  place: string | null;
  lat: number | null;
  lon: number | null;
  /** ISO-3166 alpha-2 and display name of the country the event took place in; null when unknown. */
  country_code: string | null;
  country_name: string | null;
  source_urls: string[];
  source_published_at: string | null;
  published_at: string | null;
  image_url: string | null;
  image_credit: string | null;
  image_credit_url: string | null;
  image_alt: string | null;
  /** 'employee' for stories sent through /submit, otherwise 'ai'. */
  origin: StoryOrigin;
  /** Byline of an employee story. Never the email: that is in a private table the public site cannot read. */
  author_first_name: string | null;
  author_last_name: string | null;
  author_department: string | null;
  /** 'blocks' for stories written on the Write page (then ody_blocks holds them and ody their plain text); otherwise 'plain'. */
  body_format?: "plain" | "blocks";
  body_blocks?: BlocksDoc | null;
};

export type StoryOrigin = "ai" | "employee";

/** What the feed list, the globe and the ticker need: a story without its body and source date. */
export type FeedStory = Omit<Story, "body" | "source_published_at" | "body_blocks" | "body_format">;

/**
 * What the reader shows: the feed fields at once, the body and source date once /api/story/<slug> has answered.
 * `body` is undefined while it loads.
 */
export type ReaderStory = FeedStory & Partial<Pick<Story, "body" | "source_published_at" | "body_blocks" | "body_format">>;

/** ready: the full story is here. loading: the body is on its way. missing: no such published story. error: the fetch failed. */
export type ReaderStatus = "ready" | "loading" | "missing" | "error";

/** One page of the feed. `hasMore` is true when older stories exist beyond this page. */
export type FeedPage = { stories: FeedStory[]; hasMore: boolean };
