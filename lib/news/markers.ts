// Country markers on the globe and their hover state. Pure logic (no DOM) so it can be tested.
import { countryByCode } from "@/lib/geo/countries";
import { departmentStyle } from "./departments";
import { isWorldStory } from "./filter";
import type { FeedStory } from "./types";

export type CountryGroup = {
  code: string;
  name: string;
  lat: number;
  lon: number;
  count: number;
  /** Newest first. */
  stories: FeedStory[];
  /** Department of the newest story; null when that story has none. */
  departmentSlug: string | null;
  /** Marker colour: the newest story's department colour, the neutral world colour for world stories. */
  color: string;
};

function time(s: FeedStory): number {
  const t = s.published_at ? new Date(s.published_at).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/**
 * One group per country_code that has stories, positioned from lib/geo/countries.ts. Stories with no
 * code, or a code that is not in the map, are left off the globe rather than placed somewhere.
 */
export function groupByCountry(stories: FeedStory[]): CountryGroup[] {
  const byCode = new Map<string, FeedStory[]>();
  for (const s of stories) {
    const country = countryByCode(s.country_code);
    if (!country) continue;
    const list = byCode.get(country.code);
    if (list) list.push(s);
    else byCode.set(country.code, [s]);
  }

  const groups: CountryGroup[] = [];
  for (const [code, list] of byCode) {
    const country = countryByCode(code)!;
    const sorted = [...list].sort((a, b) => time(b) - time(a));
    const newest = sorted[0];
    const slug = isWorldStory(newest) ? "world" : (newest.department?.slug ?? null);
    groups.push({
      code,
      name: country.name,
      lat: country.lat,
      lon: country.lon,
      count: sorted.length,
      stories: sorted,
      departmentSlug: slug,
      color: departmentStyle(slug).dot,
    });
  }
  // Stable order for rendering: most stories first, then by name.
  return groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---- Hover -------------------------------------------------------------------------------------

export const HOVER_SCALE = 1.5;
export const HOVER_MS = 180;
export const HOVER_EASING = "ease-out";
/** Marker depth (cos of angle from the view centre) below which a country counts as on the far side. */
export const REVEAL_DEPTH = 0.15;
export const TOOLTIP_HEADLINES = 3;

/** Where a hover or focus is coming from. Marker and card hover are tracked separately. */
export type HoverState = { marker: string | null; focus: string | null; card: string | null };
export const NO_HOVER: HoverState = { marker: null, focus: null, card: null };

export type HoverEvent =
  | { type: "marker-enter" | "marker-leave" | "focus" | "blur" | "card-enter" | "card-leave"; code: string };

const SLOT = {
  "marker-enter": "marker",
  "marker-leave": "marker",
  focus: "focus",
  blur: "focus",
  "card-enter": "card",
  "card-leave": "card",
} as const;

/** A leave or blur only clears its slot if it is for the country currently in it. */
export function hoverReducer(state: HoverState, event: HoverEvent): HoverState {
  const slot = SLOT[event.type];
  const entering = event.type === "marker-enter" || event.type === "focus" || event.type === "card-enter";
  if (entering) return state[slot] === event.code ? state : { ...state, [slot]: event.code };
  return state[slot] === event.code ? { ...state, [slot]: null } : state;
}

/** Country whose marker is emphasised. A direct marker hover wins over focus, which wins over a feed card. */
export function activeCountry(state: HoverState): string | null {
  return state.marker ?? state.focus ?? state.card;
}

/** Country whose tooltip is open: only a marker hover or focus opens one, not a feed card hover. */
export function tooltipCountry(state: HoverState): string | null {
  return state.marker ?? state.focus;
}

export function markerScale(code: string, state: HoverState): number {
  return activeCountry(state) === code ? HOVER_SCALE : 1;
}

/** Tailwind z-index class: the emphasised marker sits above the rest, a selected one above the idle ones. */
export function markerLayer(code: string, state: HoverState, selected: boolean): "z-30" | "z-10" | "z-0" {
  if (activeCountry(state) === code) return "z-30";
  return selected ? "z-10" : "z-0";
}

/** The globe stops auto-rotating while any marker is emphasised. */
export function pausesRotation(state: HoverState): boolean {
  return activeCountry(state) !== null;
}

/** True when a country's marker is on the far side (or the limb), so the globe should turn to it. */
export function needsReveal(depth: number, threshold = REVEAL_DEPTH): boolean {
  return depth < threshold;
}

export type Tooltip = { title: string; headlines: string[]; more: number };

/** Country name, up to three headlines, and how many more stories there are. */
export function tooltipFor(group: Pick<CountryGroup, "name" | "stories">, max = TOOLTIP_HEADLINES): Tooltip {
  const headlines = group.stories.slice(0, max).map((s) => s.headline);
  return { title: group.name, headlines, more: Math.max(0, group.stories.length - headlines.length) };
}

/** Text on the count badge: nothing for a single story. */
export function badgeLabel(count: number): string | null {
  if (count <= 1) return null;
  return count > 99 ? "99+" : String(count);
}
