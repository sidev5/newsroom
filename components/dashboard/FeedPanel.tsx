import { departmentStyle } from "@/lib/news/departments";
import type { FeedChip } from "@/lib/news/filter";
import type { FeedStory } from "@/lib/news/types";
import { StoryCard } from "./StoryCard";

type Props = {
  /** Stories after the chip and search filters, newest first. */
  stories: FeedStory[];
  /** How many stories are loaded (before the chip and search filters). */
  totalPublished: number;
  /** Older stories exist that are not loaded yet. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  onLoadMore: () => void;
  allCount: number;
  chips: FeedChip[];
  /** Department slug, or null for All. */
  department: string | null;
  onDepartment: (slug: string | null) => void;
  query: string;
  onQuery: (q: string) => void;
  selectedSlug: string | null;
  now: number | null;
  onSelect: (slug: string) => void;
  onHoverCountry: (code: string | null) => void;
};

function Chip({ active, onClick, dot, label, count }: { active: boolean; onClick: () => void; dot: string | null; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium text-ink transition-colors ${
        active ? "border-deep-sage bg-mint" : "border-line bg-paper hover:bg-mint/40"
      }`}
    >
      {dot && <span className="size-2.5 rounded-full" style={{ backgroundColor: dot }} aria-hidden="true" />}
      {label}
      <span className="font-mono text-[10px] text-meta">{count}</span>
    </button>
  );
}

export function FeedPanel({ stories, totalPublished, hasMore, loadingMore, loadMoreFailed, onLoadMore, allCount, chips, department, onDepartment, query, onQuery, selectedSlug, now, onSelect, onHoverCountry }: Props) {
  return (
    <section
      id="main-content"
      tabIndex={-1}
      aria-label="All news"
      className="flex min-h-0 flex-col border-line bg-feed max-[1099px]:h-[640px] max-[1099px]:border-t min-[1100px]:w-[400px] min-[1100px]:shrink-0 min-[1100px]:border-r"
    >
      <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
        <h2 className="font-headline text-[24px] font-bold leading-tight text-ink">All news</h2>
        <p className="font-mono text-[11px] font-medium text-meta" aria-live="polite">
          {stories.length}
          {hasMore ? "+" : ""} {stories.length === 1 && !hasMore ? "story" : "stories"}
        </p>
      </div>

      <div className="px-4 pb-3">
        <label htmlFor="story-search" className="sr-only">
          Search headlines and places
        </label>
        <input
          id="story-search"
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search headlines and places"
          className="h-11 w-full rounded-lg border border-input bg-paper px-3 text-[15px] text-ink placeholder:text-secondary"
        />
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pb-3" role="group" aria-label="Filter by department">
        <Chip active={department === null} onClick={() => onDepartment(null)} dot={null} label="All" count={allCount} />
        {chips.map((c) => (
          <Chip key={c.slug} active={department === c.slug} onClick={() => onDepartment(c.slug)} dot={departmentStyle(c.slug).dot} label={c.label} count={c.count} />
        ))}
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-line px-4 pb-4 pt-3">
        {totalPublished === 0 && !hasMore ? (
          <p className="rounded-[10px] border border-line bg-paper p-4 text-[15px] text-body">
            No stories have been published yet. Check back soon: new items appear here once an editor approves them.
          </p>
        ) : stories.length === 0 ? (
          <p className="p-2 text-[15px] text-secondary">
            No stories match your filters{hasMore ? ` among the ${totalPublished} loaded` : ""}.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {stories.map((s) => (
              <li key={s.id} className="feed-card">
                <StoryCard story={s} selected={s.slug === selectedSlug} now={now} onSelect={onSelect} onHoverCountry={onHoverCountry} />
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <div className="pt-3">
            {(department !== null || query.trim() !== "") && (
              <p className="pb-2 text-[13px] text-secondary">Search and filters cover the {totalPublished} loaded stories. Load more to include older ones.</p>
            )}
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="h-11 w-full rounded-lg border border-line bg-paper text-[14px] font-medium text-ink hover:bg-mint/40 disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more stories"}
            </button>
            {loadMoreFailed && (
              <p role="alert" className="pt-2 text-[13px] text-secondary">
                More stories could not be loaded. Please try again.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
