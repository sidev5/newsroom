import { DEFAULT_IMAGE_SLUGS } from "@/lib/config";

export const DEEP_SAGE = "#657166";

/** Pastel chip background (ink text) and deeper marker/dot colour, by department slug. */
const STYLES: Record<string, { chip: string; dot: string }> = {
  ev: { chip: "#99CDD8", dot: "#2E7D6E" },
  batteries: { chip: "#F3C3B2", dot: "#B4573A" },
  defence: { chip: "#CFD6C4", dot: "#2F6F8A" },
  software: { chip: "#DAEBE3", dot: "#8A5A78" },
  "sales-marketing": { chip: "#FDE8D3", dot: "#5F7A3A" },
  // The one palette colour the others do not use: deep sage for the marker, a pastel of it for the tag.
  "ai-technology": { chip: "#BABFBA", dot: "#657166" },
  // World is not a company department, so it gets a neutral sage rather than a hue.
  world: { chip: "#E1E6DA", dot: "#4E5A51" },
};

const FALLBACK = { chip: "#CFD6C4", dot: DEEP_SAGE };

export function departmentStyle(slug: string | null | undefined): { chip: string; dot: string } {
  return (slug && STYLES[slug]) || FALLBACK;
}

/** Department default SVG in public/images/defaults/ (the generic one for unknown departments). */
export function defaultImagePath(slug: string | null | undefined): string {
  const known = (DEFAULT_IMAGE_SLUGS as readonly string[]).includes(slug ?? "");
  return `/images/defaults/${known ? slug : "default"}.svg`;
}
