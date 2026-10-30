import type { FeedStory } from "./types";

/** World-news story (department kind "world"). */
export function isWorldStory(story: Pick<FeedStory, "department">): boolean {
  return story.department?.kind === "world" || story.department?.slug === "world";
}

/** World feed: every world story. Input order (newest first) is kept. */
export function worldStories(stories: FeedStory[]): FeedStory[] {
  return stories.filter(isWorldStory);
}

/** Company stories: everything that is not world news, before the department and text filters. */
export function companyStories(stories: FeedStory[]): FeedStory[] {
  return stories.filter((s) => !isWorldStory(s));
}

export type Filters = {
  /** Department slug, or null for All. */
  department: string | null;
  /** Free text, matched against headline and place. */
  query: string;
};

export function matchesQuery(story: Pick<FeedStory, "headline" | "place">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return story.headline.toLowerCase().includes(q) || (story.place ?? "").toLowerCase().includes(q);
}

/** Drives both the company feed and its map markers. */
export function filterStories<T extends FeedStory>(stories: T[], { department, query }: Filters): T[] {
  return stories.filter((s) => (department === null || s.department?.slug === department) && matchesQuery(s, query));
}

/** Stories that can be put on the map. */
export function plottable(stories: FeedStory[]): (FeedStory & { lat: number; lon: number })[] {
  return stories.filter(
    (s): s is FeedStory & { lat: number; lon: number } =>
      typeof s.lat === "number" && typeof s.lon === "number" && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180,
  );
}

export type DepartmentTab = { slug: string; name: string; count: number };

/** Departments present in the stories with the number of stories matching the text query. */
export function departmentTabs(stories: FeedStory[], query: string): { all: number; tabs: DepartmentTab[] } {
  const matching = stories.filter((s) => matchesQuery(s, query));
  const byDept = new Map<string, DepartmentTab>();
  for (const s of stories) {
    if (s.department && !byDept.has(s.department.slug)) {
      byDept.set(s.department.slug, { slug: s.department.slug, name: s.department.name, count: 0 });
    }
  }
  for (const s of matching) if (s.department) byDept.get(s.department.slug)!.count++;
  return { all: matching.length, tabs: [...byDept.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export type FeedChip = { slug: string; label: string; count: number };

/** The feed's filter chips, in this order. World is a chip like the others, not a separate feed. */
export const FEED_CHIPS = [
  { slug: "ev", label: "EV" },
  { slug: "batteries", label: "Batteries" },
  { slug: "defence", label: "Defence" },
  { slug: "software", label: "Software" },
  { slug: "sales-marketing", label: "Sales & Marketing" },
  { slug: "ai-technology", label: "AI & Technology" },
  { slug: "world", label: "World" },
] as const;

/**
 * Counts for the chips among the stories matching the text query. The seven fixed chips always show
 * (even at 0) so the row does not jump; a department outside the list that has stories is added after them.
 */
export function feedChips(stories: FeedStory[], query: string): { all: number; chips: FeedChip[] } {
  const matching = stories.filter((s) => matchesQuery(s, query));
  const counts = new Map<string, number>();
  const extra = new Map<string, string>();
  const fixed = new Set<string>(FEED_CHIPS.map((c) => c.slug));
  for (const s of matching) {
    const slug = s.department?.slug;
    if (!slug) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
    if (!fixed.has(slug)) extra.set(slug, s.department!.name);
  }
  const chips: FeedChip[] = FEED_CHIPS.map((c) => ({ ...c, count: counts.get(c.slug) ?? 0 }));
  for (const [slug, name] of [...extra].sort((a, b) => a[1].localeCompare(b[1]))) chips.push({ slug, label: name, count: counts.get(slug) ?? 0 });
  return { all: matching.length, chips };
}
