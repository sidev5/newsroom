import { RADIUS, VIEW } from "@/lib/news/globe";

/**
 * A plain circle the size and colour of the globe's sphere, shown until the globe's code has loaded, so the map
 * area does not jump. No script and no canvas: it is part of the server-rendered HTML.
 */
export function GlobePlaceholder() {
  return (
    <div aria-hidden="true" className="relative grid aspect-square w-full place-items-center">
      <div
        className="aspect-square rounded-full"
        style={{
          width: `${((RADIUS * 2) / VIEW) * 100}%`,
          background: "radial-gradient(circle at 31% 29%, #9CCBD8 0%, #5E9BAE 55%, #3F7488 100%)",
          boxShadow: "0 0 24px rgba(168, 208, 240, 0.9)",
        }}
      />
    </div>
  );
}
