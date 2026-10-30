import { photoCreditLinks } from "@/lib/images/utm";

/** "Photo by <name> on Unsplash". Renders nothing for default (uncredited) images. */
export function PhotoCredit({ credit, creditUrl }: { credit: string | null; creditUrl: string | null }) {
  const links = photoCreditLinks(credit, creditUrl);
  if (!links) return null;
  return (
    <p className="text-xs text-zinc-500">
      Photo by{" "}
      <a href={links.profileUrl} target="_blank" rel="noopener noreferrer" className="underline">
        {links.name}
      </a>{" "}
      on{" "}
      <a href={links.unsplashUrl} target="_blank" rel="noopener noreferrer" className="underline">
        Unsplash
      </a>
    </p>
  );
}
