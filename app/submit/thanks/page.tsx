import type { Metadata } from "next";
import Link from "next/link";
import { WriteIcon } from "@/components/dashboard/icons";

export const metadata: Metadata = { title: "Thanks | Company Newsroom", robots: { index: false } };

export default function ThanksPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-paper px-4 py-3 lg:px-6">
        <WriteIcon />
        <p className="font-headline text-[22px] font-bold leading-7 text-ink">Write</p>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-4 py-12">
        <div className="rounded-[10px] border border-line bg-mint p-6">
          <h1 className="font-headline text-[30px] font-bold leading-tight text-ink">Thanks, your story is waiting for review by the newsroom admin.</h1>
          <p className="mt-3 text-[16px] leading-relaxed text-body">
            You do not need to do anything else. If the editor publishes it, it will appear on the dashboard with your name.
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/" className="inline-flex h-11 items-center rounded-lg bg-deep-sage px-5 text-[15px] font-semibold text-white hover:bg-deep-sage-dark">
            Back to the dashboard
          </Link>
          <Link href="/submit" className="inline-flex h-11 items-center rounded-lg border border-input px-5 text-[15px] font-medium text-ink hover:bg-mint">
            Write another story
          </Link>
        </div>
      </main>
    </div>
  );
}
