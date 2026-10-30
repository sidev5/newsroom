// Shared digest types. No server-only imports: the admin editor renders the preview in the browser.

export type DigestStatus = "draft" | "approved" | "sending" | "sent" | "failed" | "skipped";

export type DigestRow = {
  id: string;
  /** Monday of the week (YYYY-MM-DD, Asia/Kolkata). */
  week_start: string;
  status: DigestStatus;
  subject: string;
  intro: string;
  lead_article_id: string | null;
  /** The stories in order; the first is the lead. */
  article_ids: string[];
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  error: string | null;
  recipient_count: number | null;
  reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A published article as the digest sees it. */
export type DigestArticle = {
  id: string;
  slug: string;
  headline: string;
  body: string;
  department: { name: string; slug: string } | null;
  country_name: string | null;
  /** Absolute https URL of a real photo, or null (department default SVGs are not used in email). */
  image_url: string | null;
  image_alt: string | null;
  image_credit: string | null;
  image_credit_url: string | null;
  source_urls: string[];
  source_published_at: string | null;
  published_at: string | null;
  /** 'employee' for stories sent through /submit: no source, a byline, and no "AI-generated" wording. */
  origin: "ai" | "employee";
  author_first_name: string | null;
  author_last_name: string | null;
  author_department: string | null;
};

export type DigestAction =
  | "draft_created"
  | "draft_skipped"
  | "edit"
  | "approve"
  | "unapprove"
  | "approval_reset"
  | "test_sent"
  | "eml_downloaded"
  | "send_started"
  | "send_batch"
  | "sent"
  | "send_failed"
  | "marked_failed"
  | "retry"
  | "reminder_sent"
  | "reminder_failed"
  | "recipients_changed";

export const DEFAULT_INTRO =
  "Here are this week's stories from Company Newsroom, summarised by AI from public sources and reviewed by an editor.";

/** Default intro when the week has employee stories as well: the AI-only wording would not be true. */
export const DEFAULT_INTRO_WITH_EMPLOYEES =
  "Here are this week's stories from Company Newsroom: summaries written by AI from public sources, and contributions from colleagues. An editor reviewed every story.";

export const SUBJECT_PREFIX = "Company Newsroom weekly: ";
export const SUBJECT_MAX = 90;
