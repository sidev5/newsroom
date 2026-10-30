"use client";

import { useEffect, useRef } from "react";
import { relativeTime } from "@/lib/news/format";
import type { CountryGroup } from "@/lib/news/markers";
import { DeptChip } from "./DeptChip";
import { CloseIcon } from "./icons";

type Props = {
  group: CountryGroup;
  now: number | null;
  onSelect: (slug: string) => void;
  onClose: () => void;
};

/** Short list of a country's stories, shown when a marker with more than one story is clicked. */
export function CountryList({ group, now, onSelect, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group.code, onClose]);

  return (
    <aside
      aria-label={`Stories from ${group.name}`}
      className="absolute right-4 top-4 z-30 flex max-h-[calc(100%-2rem)] w-[min(340px,calc(100%-2rem))] flex-col rounded-[10px] border border-line bg-paper shadow-[0_8px_24px_rgba(44,53,47,0.18)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-wide text-meta">{group.name}</p>
          <p className="text-[13px] text-secondary">
            {group.count} {group.count === 1 ? "story" : "stories"}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close list"
          className="grid size-11 place-items-center rounded-lg text-ink hover:bg-mint"
        >
          <CloseIcon />
        </button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {group.stories.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onSelect(s.slug)}
              className="flex min-h-11 w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-mint/40"
            >
              <span className="flex items-center justify-between gap-2">
                <DeptChip department={s.department} />
                <span className="font-mono text-[11px] font-medium uppercase text-meta">
                  {now !== null && s.published_at ? relativeTime(s.published_at, now) : ""}
                </span>
              </span>
              <span className="font-headline text-[16px] font-semibold leading-snug text-ink">{s.headline}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
