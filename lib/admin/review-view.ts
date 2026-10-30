// Pure helpers for the review screen (no database, no React), so they can be tested.

export type ReviewTab = "pending" | "published" | "rejected" | "skipped" | "pipeline";
export const REVIEW_TABS: readonly ReviewTab[] = ["pending", "published", "rejected", "skipped", "pipeline"];

export function parseTab(value: unknown): ReviewTab {
  return typeof value === "string" && (REVIEW_TABS as readonly string[]).includes(value) ? (value as ReviewTab) : "pending";
}

export type DeptInfo = { slug: string; name: string; kind?: "company" | "world" };
/** `origin` is absent on rows from before the column existed; those are AI articles. */
export type WithDept = { department: { slug: string } | null; origin?: "ai" | "employee" };

export type Chip = { key: string; label: string; count: number };

/** Chip key for stories written by employees (it is not a department slug). */
export const EMPLOYEE_CHIP = "employee";

/** Order of the filter chips; any other department follows alphabetically. */
const CHIP_ORDER = ["world", "ev", "batteries", "defence", "software", "sales-marketing", "ai-technology"];
const CHIP_LABELS: Record<string, string> = { software: "Software" };

export function chipLabel(dept: DeptInfo): string {
  return CHIP_LABELS[dept.slug] ?? dept.name;
}

/** All | Employee submissions | World | EV | Batteries | Defence | Software | Sales & Marketing | AI & Technology, each with its pending count. */
export function pendingChips(rows: WithDept[], departments: DeptInfo[]): Chip[] {
  const rank = (slug: string) => {
    const i = CHIP_ORDER.indexOf(slug);
    return i === -1 ? CHIP_ORDER.length : i;
  };
  const sorted = [...departments].sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name));
  const count = (slug: string) => rows.filter((r) => r.department?.slug === slug).length;
  return [
    { key: "all", label: "All", count: rows.length },
    { key: EMPLOYEE_CHIP, label: "Employee submissions", count: rows.filter((r) => r.origin === "employee").length },
    ...sorted.map((d) => ({ key: d.slug, label: chipLabel(d), count: count(d.slug) })),
  ];
}

/** Rows for a chip key ("all", "employee" or a department slug). */
export function filterByChip<T extends WithDept>(rows: T[], key: string): T[] {
  if (key === "all") return rows;
  if (key === EMPLOYEE_CHIP) return rows.filter((r) => r.origin === "employee");
  return rows.filter((r) => r.department?.slug === key);
}

/** The chip key from the URL, falling back to "all" for anything that is not a known chip. */
export function parseChip(value: unknown, chips: Chip[]): string {
  return typeof value === "string" && chips.some((c) => c.key === value) ? value : "all";
}

// ---- Why an article was rejected ---------------------------------------------------------------

export type RejectionInfo =
  | { source: "fact-check"; claims: string[] }
  | { source: "editor"; reason: string | null; by: string | null; at: string | null; claims?: string[] }
  | { source: "unknown" };

type LogLite = { action: string; actor_email: string; reason: string | null; created_at: string };

const claimsOf = (notes: string) =>
  notes
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);

/**
 * Who rejected an article and why. Fact-check notes are stored as "- claim" lines; an editor
 * rejection is in the audit log. If an editor rejected it last (e.g. after a restore), the editor
 * is named and the earlier fact-check claims are still listed.
 */
export function rejectionInfo(factCheckNotes: string | null, latestLog: LogLite | null): RejectionInfo {
  const notes = factCheckNotes?.trim();
  if (latestLog?.action === "reject") {
    return {
      source: "editor",
      reason: latestLog.reason,
      by: latestLog.actor_email,
      at: latestLog.created_at,
      ...(notes ? { claims: claimsOf(notes) } : {}),
    };
  }
  if (notes) return { source: "fact-check", claims: claimsOf(notes) };
  return { source: "unknown" };
}

// ---- Fact-check notes on a pending story ---------------------------------------------------------

/**
 * What the fact-check box on a pending card shows. Notes made only of "- Minor: ..." lines are wording warnings on a story
 * that passed; any other notes on a pending story were kept from before an editor restored it.
 */
export type FactCheckNotice = { kind: "passed" } | { kind: "minor"; items: string[] } | { kind: "restored"; items: string[] };

const MINOR = /^Minor:\s*/i;

export function factCheckNotice(factCheckNotes: string | null): FactCheckNotice {
  const items = claimsOf(factCheckNotes ?? "");
  if (items.length === 0) return { kind: "passed" };
  if (items.every((i) => MINOR.test(i))) return { kind: "minor", items: items.map((i) => i.replace(MINOR, "")) };
  return { kind: "restored", items };
}

/** One line for a stage run's stored summary: its progress, or a clipped JSON fallback. */
export function summarizeRun(summary: unknown): string {
  const s = summary as Record<string, unknown> | null;
  if (s && typeof s === "object" && typeof s.processed === "number" && typeof s.remaining === "number") {
    const parts = [`processed ${s.processed}`, `remaining ${s.remaining}`];
    if (typeof s.rejected === "number" && s.rejected > 0) parts.push(`rejected ${s.rejected}`);
    if (typeof s.failed === "number" && s.failed > 0) parts.push(`failed ${s.failed}`);
    if (s.rateLimited === true) parts.push("rate limited");
    if (typeof s.stoppedError === "string" && s.stoppedError) parts.push(`stopped (${typeof s.stopped === "string" ? s.stopped : "?"}): ${s.stoppedError.slice(0, 300)}`);
    return parts.join(" · ");
  }
  return (JSON.stringify(summary) ?? "").slice(0, 200);
}
/** "2026-10-14 09:30 UTC", or an em dash when there is no time. */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ---- Pipeline funnel ---------------------------------------------------------------------------

export const RAW_STATUSES = ["new", "new-relevant", "written", "skipped", "failed"] as const;
export const ARTICLE_STATUSES = ["draft", "pending_review", "published", "rejected"] as const;

export type FunnelRow = { status: string; count: number; /** 0-1 of the largest row, for bar width. */ share: number };

/** Every status in the given order (zero when absent), with bar widths relative to the largest count. */
export function funnel(order: readonly string[], counts: Record<string, number>): FunnelRow[] {
  const max = Math.max(1, ...order.map((s) => counts[s] ?? 0));
  return order.map((status) => ({ status, count: counts[status] ?? 0, share: (counts[status] ?? 0) / max }));
}

/** Rows grouped by a status column -> counts per status. */
export function countBy(rows: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
