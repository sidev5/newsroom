import type { Metadata } from "next";
import Link from "next/link";
import { WriteIcon } from "@/components/dashboard/icons";
import { WriteForm } from "@/components/write/WriteForm";
import { PRIVACY_RETENTION, SUBMISSION_AUTHOR_DEPARTMENTS, SUBMISSION_DEFAULT_COUNTRY } from "@/lib/config";
import { env } from "@/lib/env";
import { COUNTRIES } from "@/lib/geo/countries";
import { supabaseServer } from "@/lib/supabase/server";
import { turnstileConfig } from "@/lib/submissions/turnstile";
import { PrivacyNotice } from "./PrivacyNotice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Write | Company Newsroom",
  description: "Employees can write a story and send it to the newsroom editor for review.",
};

const COUNTRY_OPTIONS = Object.entries(COUNTRIES)
  .map(([code, c]) => ({ code, name: c.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The departments a story can be filed under: the company departments shown on the dashboard. Public data (RLS allows it). */
async function loadSectors(): Promise<{ slug: string; name: string }[] | null> {
  const { data, error } = await (await supabaseServer()).from("departments").select("slug, name").eq("kind", "company").order("name");
  if (error) {
    console.error(`Loading departments for /submit failed: ${error.message}`);
    return null;
  }
  return (data ?? []) as { slug: string; name: string }[];
}

export default async function SubmitPage() {
  const sectors = await loadSectors();
  let domains: string[] = [];
  let notice = { contact: null as string | null, ipDays: PRIVACY_RETENTION.IP_HASH_DAYS as number, emailDays: PRIVACY_RETENTION.EMAIL_DAYS as number };
  try {
    const e = env();
    domains = e.ALLOWED_EMAIL_DOMAINS;
    notice = { contact: e.PRIVACY_CONTACT ?? null, ipDays: e.SUBMITTER_IP_RETENTION_DAYS, emailDays: e.SUBMITTER_EMAIL_RETENTION_DAYS };
  } catch {
    // The hint is optional; the server action validates against the real list.
  }
  const turnstileSiteKey = turnstileConfig(process.env)?.siteKey ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-paper px-4 py-3 lg:px-6">
        <WriteIcon />
        <p className="font-headline text-[22px] font-bold leading-7 text-ink">Write</p>
        <Link href="/" className="ml-auto inline-flex h-11 items-center rounded-lg border border-input px-4 text-[15px] font-medium text-ink hover:bg-mint">
          Back to the dashboard
        </Link>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <h1 className="font-headline text-[34px] font-bold leading-tight text-ink">Write a story</h1>
        <p className="mt-2 text-[16px] leading-relaxed text-body">
          Have news from your team that colleagues should read? Write it here, with headings, images, code and more, and send it for review. No account is needed. An editor reads every story and decides
          whether to publish it. Nothing is published automatically, and AI does not check or rewrite your text.
        </p>

        <PrivacyNotice {...notice} />

        {sectors === null ? (
          <p role="alert" className="mt-6 rounded-lg bg-blush px-4 py-3 text-ink">
            The form is not available right now. Please try again in a few minutes.
          </p>
        ) : (
          <WriteForm
            sectors={sectors}
            authorDepartments={[...SUBMISSION_AUTHOR_DEPARTMENTS]}
            countries={COUNTRY_OPTIONS}
            defaultCountry={SUBMISSION_DEFAULT_COUNTRY}
            domains={domains}
            turnstileSiteKey={turnstileSiteKey}
          />
        )}
      </main>
    </div>
  );
}
