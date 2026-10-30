import { safeHttpUrl } from "@/lib/news/format";

/** "(source)" links for stored URLs. Only http(s) links are rendered; anything else is dropped (SEC-12). */
export function SourceLinks({ urls }: { urls: string[] }) {
  return (
    <>
      {urls.map((u) => {
        const href = safeHttpUrl(u);
        return href ? (
          <span key={u}>
            {" "}
            (<a href={href} target="_blank" rel="noopener noreferrer" className="underline">source</a>)
          </span>
        ) : null;
      })}
    </>
  );
}

/** The title of a raw item, linked to its page when the stored URL is a web link, plain text otherwise. */
export function ItemLink({ url, children }: { url: string; children: React.ReactNode }) {
  const href = safeHttpUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}
