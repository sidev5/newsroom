import type { FeedStory } from "@/lib/news/types";
import { DeptChip } from "./DeptChip";

const MAX_ITEMS = 20;

function Items({ stories, onSelect, hidden }: { stories: FeedStory[]; onSelect: (slug: string) => void; hidden?: boolean }) {
  return (
    <ul className="flex shrink-0 items-center" aria-hidden={hidden}>
      {stories.map((s) => (
        <li key={s.id} className="flex shrink-0 items-center gap-2 pr-10">
          <DeptChip department={s.department} />
          <button
            type="button"
            tabIndex={hidden ? -1 : 0}
            onClick={() => onSelect(s.slug)}
            className="min-h-11 whitespace-nowrap text-[14px] text-white hover:underline"
            style={{ outlineColor: "#fff" }} // the default sage ring would vanish on the sage bar
          >
            {s.headline}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Scrolling headlines. The list is rendered twice so the -50% loop is seamless. */
export function Ticker({ stories, onSelect }: { stories: FeedStory[]; onSelect: (slug: string) => void }) {
  const items = stories.slice(0, MAX_ITEMS);
  return (
    <div className="ticker mt-auto flex h-11 items-center overflow-hidden bg-deep-sage text-white" aria-label="Latest headlines" role="region">
      <span className="z-10 flex h-full shrink-0 items-center bg-blush px-4 font-mono text-[11px] font-medium uppercase tracking-wider text-ink">Latest</span>
      {items.length === 0 ? (
        <span className="px-4 text-[14px]">No stories yet.</span>
      ) : (
        <div className="ticker-track flex w-max items-center pl-6">
          <Items stories={items} onSelect={onSelect} />
          <Items stories={items} onSelect={onSelect} hidden />
        </div>
      )}
    </div>
  );
}
