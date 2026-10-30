import Link from "next/link";
import { BrandMark } from "./icons";

export function Header() {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-paper px-4 py-3 lg:px-6">
      <div className="flex items-center gap-3">
        <BrandMark />
        <div>
          <h1 className="font-headline text-[24px] font-bold leading-7 text-ink">Company Newsroom</h1>
          <p className="font-mono text-[11px] font-medium leading-4 text-meta">Industry news · AI-assisted</p>
        </div>
      </div>

      <span className="ml-auto rounded-full bg-mint px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-ink">
        AI-generated · editor approved
      </span>

      <Link
        href="/submit"
        className="inline-flex h-11 items-center rounded-lg bg-deep-sage px-4 text-[15px] font-semibold text-white hover:bg-deep-sage-dark"
      >
        Write
      </Link>

      <Link
        href="/admin/review"
        className="inline-flex h-11 items-center rounded-lg border border-input px-4 text-[15px] font-medium text-ink hover:bg-mint"
      >
        Admin
      </Link>
    </header>
  );
}
