import { byline } from "@/lib/news/byline";
import { departmentStyle } from "@/lib/news/departments";
import { isoDate, relativeTime, sourceName } from "@/lib/news/format";
import { isWorldStory } from "@/lib/news/filter";
import type { FeedStory } from "@/lib/news/types";
import { DeptChip } from "./DeptChip";
import { PinIcon } from "./icons";

type Props = {
  story: FeedStory;
  selected: boolean;
  /** Current time in ms, set on the client after mount; null on the server and first render. */
  now: number | null;
  onSelect: (slug: string) => void;
  /** Pointer or keyboard focus on the card: its country's marker is emphasised on the globe. */
  onHoverCountry?: (code: string | null) => void;
};

export function StoryCard({ story, selected, now, onSelect, onHoverCountry }: Props) {
  const when = story.published_at
    ? now === null
      ? (isoDate(story.published_at) ?? "")
      : relativeTime(story.published_at, now)
    : "";
  const source = sourceName(story.source_urls[0]);
  const country = story.country_name ?? story.place;
  const where = [source, country].filter(Boolean).join(" · ");
  const color = departmentStyle(isWorldStory(story) ? "world" : story.department?.slug).dot;
  const by = byline(story);

  return (
    <button
      type="button"
      data-slug={story.slug}
      aria-pressed={selected}
      onClick={() => onSelect(story.slug)}
      onPointerEnter={(e) => e.pointerType !== "touch" && onHoverCountry?.(story.country_code)}
      onPointerLeave={() => onHoverCountry?.(null)}
      onFocus={() => onHoverCountry?.(story.country_code)}
      onBlur={() => onHoverCountry?.(null)}
      // The department colour marks the selected card: a thick left edge plus a ring in the same colour.
      style={selected ? { borderColor: color, boxShadow: `inset 5px 0 0 ${color}, 0 0 0 1px ${color}` } : undefined}
      className={`flex min-h-11 w-full flex-col gap-2 rounded-[10px] border p-4 text-left transition-colors ${
        selected ? "bg-mint pl-5" : "border-line bg-paper hover:bg-mint/40"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <DeptChip department={story.department} />
        <span className="font-mono text-[11px] font-medium uppercase text-meta">{when}</span>
      </span>
      <span className="font-headline text-[19px] font-semibold leading-snug text-ink">{story.headline}</span>
      {by && <span className="text-[13px] font-medium text-secondary">{by}</span>}
      <span className="line-clamp-3 text-[14px] leading-relaxed text-body">{story.summary}</span>
      {where && (
        <span className="flex items-center gap-1.5 text-[13px] text-secondary">
          <PinIcon className="shrink-0" />
          <span className="truncate">{where}</span>
        </span>
      )}
    </button>
  );
}
