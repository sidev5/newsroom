"use client";

import "./csp-safe-zod"; // first: zod must not use eval in the browser (see the file)
import { useRouter } from "next/navigation";
import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BlocksView } from "@/components/story/BlocksView";
import { STORY_LIMITS as L } from "@/lib/config";
import { parseSubmittedDoc, readingMinutes } from "@/lib/stories/blocks";
import { DRAFT_KEY, imageCount, insertAt, isEmptyDraft, moveBlock, newBlockId, parseDraft, removeAt, replaceAt, serializeDraft, toPreviewDoc, toSubmitDoc, type EditorBlock, type MenuChoice } from "@/lib/stories/editor";
import type { StoryField } from "@/lib/stories/fields";
import { TURNSTILE_SCRIPT } from "@/lib/submissions/turnstile";
import { AddBlock } from "./AddBlock";
import { BlockCard } from "./BlockCard";
import { prepareImage } from "./images";
import { TurnstileWidget } from "./TurnstileWidget";

type Props = {
  sectors: { slug: string; name: string }[];
  authorDepartments: string[];
  countries: { code: string; name: string }[];
  defaultCountry: string;
  /** Allowed company email domains, for the hint under the email field. */
  domains: string[];
  /** Cloudflare Turnstile site key: the widget is shown only when this is set. */
  turnstileSiteKey: string | null;
};

const input = "h-11 w-full rounded-lg border border-input bg-paper px-3 text-[15px] text-ink placeholder:text-secondary";
const area = "w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-[15px] leading-relaxed text-ink";
const btn = "inline-flex h-11 items-center rounded-lg border border-input px-4 text-[15px] font-medium text-ink hover:bg-mint disabled:opacity-50";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[13px] text-secondary">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-[13px] font-medium text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}

type Errors = { fields: Partial<Record<StoryField, string>>; blocks: Record<string, string>; general?: string };
const NO_ERRORS: Errors = { fields: {}, blocks: {} };

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export function WriteForm({ sectors, authorDepartments, countries, defaultCountry, domains, turnstileSiteKey }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [sector, setSector] = useState("");
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [names, setNames] = useState({ first: "", last: "", department: "", showName: false });
  const [files, setFiles] = useState<Record<string, File>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [widgetKey, setWidgetKey] = useState(0);
  const ready = useRef(false);
  const focusId = useRef<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // --- The draft: restored once when the page opens, saved a moment after every change. localStorage may be missing or full: every use is in try/catch.
  useEffect(() => {
    try {
      const draft = parseDraft(window.localStorage.getItem(DRAFT_KEY));
      if (draft && !isEmptyDraft(draft)) {
        setTitle(draft.title);
        setSummary(draft.summary);
        setSector(sectors.some((s) => s.slug === draft.sector) ? draft.sector : "");
        setBlocks(draft.blocks);
        setRestored(draft.savedAt);
      }
    } catch {
      // no storage: the editor works without a draft
    }
    ready.current = true;
  }, [sectors]);

  useEffect(() => {
    if (!ready.current) return;
    const timer = setTimeout(() => {
      try {
        if (isEmptyDraft({ title, summary, blocks })) window.localStorage.removeItem(DRAFT_KEY);
        else {
          const now = new Date();
          window.localStorage.setItem(DRAFT_KEY, serializeDraft({ title, summary, sector, blocks }, now));
          setSaved(now.toISOString());
        }
      } catch {
        setSaved(null);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [title, summary, sector, blocks]);

  // --- Moving the focus to a block that was just added.
  useEffect(() => {
    if (focusId.current) {
      document.getElementById(`field-${focusId.current}`)?.focus();
      focusId.current = null;
    }
  }, [blocks]);

  const addBlock = useCallback(
    (choice: MenuChoice, index: number) => {
      const id = newBlockId(new Set(blocks.map((b) => b.id)));
      focusId.current = id;
      setBlocks((current) => insertAt(current, index, choice.make(id)));
      setAnnounce(`${choice.label} block added at position ${index + 1}.`);
    },
    [blocks],
  );

  const dropFile = (id: string) => {
    setFiles(({ [id]: _removed, ...rest }) => (void _removed, rest));
    setPreviews(({ [id]: _removed, ...rest }) => (void _removed, rest));
  };

  async function pickImage(block: EditorBlock, file: File | null) {
    const id = block.id;
    setImageErrors(({ [id]: _e, ...rest }) => (void _e, rest));
    if (!file) {
      dropFile(id);
      return;
    }
    setBusy((b) => ({ ...b, [id]: true }));
    const prepared = await prepareImage(file);
    setBusy((b) => ({ ...b, [id]: false }));
    if ("error" in prepared) {
      dropFile(id);
      setImageErrors((e) => ({ ...e, [id]: prepared.error }));
      return;
    }
    setFiles((f) => ({ ...f, [id]: prepared.file }));
    setPreviews((p) => ({ ...p, [id]: prepared.dataUrl }));
    setBlocks((current) => current.map((b) => (b.id === id && b.type === "image" ? { ...b, fileName: prepared.file.name } : b)));
  }

  function removeBlock(index: number) {
    const gone = blocks[index];
    if (gone.type === "image") dropFile(gone.id);
    setBlocks((current) => removeAt(current, index));
    setAnnounce(`Block ${index + 1} deleted.`);
  }

  const doc = useMemo(() => toPreviewDoc(blocks), [blocks]);
  const sectorName = sectors.find((s) => s.slug === sector)?.name;

  function checkLocally(): Errors | null {
    const out: Errors = { fields: {}, blocks: {} };
    const parsed = parseSubmittedDoc(toSubmitDoc(blocks));
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        if (issue.blockId) out.blocks[issue.blockId] ??= issue.message;
        else out.general ??= issue.message;
      }
    }
    for (const b of blocks) if (b.type === "image" && !files[b.id]) out.blocks[b.id] ??= "Choose an image file for this block, or delete the block.";
    return out.general || Object.keys(out.blocks).length ? out : null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const local = checkLocally();
    if (local) {
      // The browser's own checks (required fields) have already run; these are the ones about the blocks.
      setErrors({ ...local, general: local.general ?? "Some blocks need fixing. They are marked below." });
      setPreview(false);
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setPending(true);
    setErrors(NO_ERRORS);
    const data = new FormData(e.currentTarget);
    data.set("blocks", JSON.stringify(toSubmitDoc(blocks)));
    for (const b of blocks) if (b.type === "image" && files[b.id]) data.set(`image:${b.id}`, files[b.id], files[b.id].name);
    try {
      const res = await fetch("/api/write/submit", { method: "POST", body: data });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; fieldErrors?: Errors["fields"]; blockErrors?: Record<string, string> } | null;
      if (res.ok && body?.ok) {
        try {
          window.localStorage.removeItem(DRAFT_KEY);
        } catch {
          // fine
        }
        router.push("/submit/thanks");
        return;
      }
      setErrors({
        fields: body?.fieldErrors ?? {},
        blocks: body?.blockErrors ?? {},
        // The host can refuse a large request before the app sees it (Vercel allows about 4.5 MB): then there is no JSON to read.
        general: body?.error ?? (res.status === 413 ? "The story and its images are too large for the server to accept. Remove or shrink some images and try again. Your draft is still here." : "Something went wrong and your story was not saved. Please try again in a few minutes."),
      });
      setWidgetKey((k) => k + 1); // a human-check token works once
      requestAnimationFrame(() => summaryRef.current?.focus());
    } catch {
      setErrors({ fields: {}, blocks: {}, general: "The story could not be sent. Check your connection and try again. Your draft is still here." });
    } finally {
      setPending(false);
    }
  }

  function startOver() {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // fine
    }
    setTitle("");
    setSummary("");
    setBlocks([]);
    setFiles({});
    setPreviews({});
    setRestored(null);
    setSaved(null);
  }

  const fe = errors.fields;
  const describe = (name: StoryField, hint?: boolean) => [fe[name] ? `${name}-error` : null, hint && !fe[name] ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  const invalid = (name: StoryField) => (fe[name] ? true : undefined);
  const byline = names.showName && (names.first || names.last) ? `By ${[names.first, names.last].filter(Boolean).join(" ")}${names.department ? ` · ${names.department}` : ""}` : "By Newsroom contributor";

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-6">
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        {errors.general && (
          <p role="alert" className="rounded-lg bg-blush px-4 py-3 text-[15px] text-ink">
            {errors.general}
          </p>
        )}
      </div>

      {restored && (
        <p className="flex flex-wrap items-center gap-3 rounded-lg bg-mint px-4 py-3 text-[14px] text-ink">
          <span>We restored the draft you were writing{time(restored) ? ` (saved at ${time(restored)})` : ""}. Images have to be chosen again.</span>
          <button type="button" onClick={startOver} className="font-medium underline">
            Start over
          </button>
        </p>
      )}

      {/* Honeypot: people never see or fill this; bots do. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      <div hidden={preview} className="flex flex-col gap-6">
        <Field id="title" label="Title" hint={`${L.TITLE_MIN}–${L.TITLE_MAX} characters. ${title.length} so far.`} error={fe.title}>
          <input
            id="title"
            name="title"
            required
            minLength={L.TITLE_MIN}
            maxLength={L.TITLE_MAX}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={invalid("title")}
            aria-describedby={describe("title", true)}
            className={`${input} font-headline text-[22px] font-bold`}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="sector" label="Department the story is for" hint="Where it will appear on the dashboard." error={fe.sector}>
            <select id="sector" name="sector" required value={sector} onChange={(e) => setSector(e.target.value)} aria-invalid={invalid("sector")} aria-describedby={describe("sector", true)} className={input}>
              <option value="" disabled>
                Choose…
              </option>
              {sectors.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="country" label="Country (optional)" hint="Where the story takes place. It puts the story on the globe." error={fe.country}>
            <select id="country" name="country" defaultValue={defaultCountry} aria-invalid={invalid("country")} aria-describedby={describe("country", true)} className={input}>
              <option value="">No country</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field id="summary" label="Summary (optional)" hint={`The line under the title on the feed card, up to ${L.SUMMARY_MAX} characters. Leave it empty to use the start of your story. ${summary.length} so far.`} error={fe.summary}>
          <textarea id="summary" name="summary" rows={2} maxLength={L.SUMMARY_MAX} value={summary} onChange={(e) => setSummary(e.target.value)} aria-invalid={invalid("summary")} aria-describedby={describe("summary", true)} className={area} />
        </Field>

        <section aria-labelledby="blocks-heading" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="blocks-heading" className="font-headline text-[22px] font-bold text-ink">
              Your story
            </h2>
            <p className="text-[13px] text-secondary">
              {blocks.length} of {L.MAX_BLOCKS} blocks · {imageCount(blocks)} of {L.MAX_IMAGES} images
            </p>
          </div>
          {blocks.length === 0 && <p className="rounded-lg bg-feed px-4 py-3 text-[14px] text-secondary">Press + to add the first block: a paragraph, a heading, an image, code, a quote, a list, a divider or a link.</p>}
          <AddBlock index={0} blocks={blocks} onAdd={addBlock} first />
          <ol className="flex list-none flex-col gap-2 p-0">
            {blocks.map((block, i) => (
              <li key={block.id} className="flex flex-col gap-2">
                <BlockCard
                  block={block}
                  index={i}
                  total={blocks.length}
                  error={errors.blocks[block.id]}
                  preview={previews[block.id]}
                  imageBusy={busy[block.id]}
                  imageError={imageErrors[block.id]}
                  onChange={(next) => setBlocks((current) => replaceAt(current, i, next))}
                  onMove={(d) => {
                    setBlocks((current) => moveBlock(current, i, d));
                    setAnnounce(`Block moved ${d < 0 ? "up" : "down"} to position ${i + d + 1}.`);
                  }}
                  onDelete={() => removeBlock(i)}
                  onPickImage={(file) => void pickImage(block, file)}
                />
                <AddBlock index={i + 1} blocks={blocks} onAdd={addBlock} />
              </li>
            ))}
          </ol>
        </section>

        <fieldset className="flex flex-col gap-5 rounded-lg border border-line bg-feed p-4">
          <legend className="px-1 text-[14px] font-medium text-ink">About you</legend>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="firstName" label="First name" error={fe.firstName}>
              <input id="firstName" name="firstName" required maxLength={60} autoComplete="given-name" value={names.first} onChange={(e) => setNames((n) => ({ ...n, first: e.target.value }))} aria-invalid={invalid("firstName")} aria-describedby={describe("firstName")} className={input} />
            </Field>
            <Field id="lastName" label="Last name" error={fe.lastName}>
              <input id="lastName" name="lastName" required maxLength={60} autoComplete="family-name" value={names.last} onChange={(e) => setNames((n) => ({ ...n, last: e.target.value }))} aria-invalid={invalid("lastName")} aria-describedby={describe("lastName")} className={input} />
            </Field>
          </div>
          <Field
            id="email"
            label="Company email"
            hint={domains.length ? `Use your company address (${domains.map((d) => `@${d}`).join(" or ")}). It is only seen by the editor and is never published.` : "It is only seen by the editor and is never published."}
            error={fe.email}
          >
            <input id="email" name="email" type="email" required autoComplete="email" aria-invalid={invalid("email")} aria-describedby={describe("email", true)} className={input} />
          </Field>
          <Field id="authorDepartment" label="Your department" error={fe.authorDepartment}>
            <select id="authorDepartment" name="authorDepartment" required value={names.department} onChange={(e) => setNames((n) => ({ ...n, department: e.target.value }))} aria-invalid={invalid("authorDepartment")} aria-describedby={describe("authorDepartment")} className={input}>
              <option value="" disabled>
                Choose…
              </option>
              {authorDepartments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-start gap-3 text-[15px] text-ink">
            <input type="checkbox" name="showName" checked={names.showName} onChange={(e) => setNames((n) => ({ ...n, showName: e.target.checked }))} className="mt-1 size-5 accent-[#657166]" />
            <span>
              Show my name and department on the story.
              <span className="block text-[13px] text-secondary">If you leave this empty the story is published as &ldquo;Newsroom contributor&rdquo;. The editor still sees who wrote it.</span>
            </span>
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-feed p-4">
          <legend className="px-1 text-[14px] font-medium text-ink">Please confirm</legend>
          <div className="flex flex-col gap-1">
            <label className="flex items-start gap-3 text-[15px] text-ink">
              <input type="checkbox" name="ownWork" required aria-invalid={invalid("ownWork")} aria-describedby={describe("ownWork")} className="mt-1 size-5 accent-[#657166]" />
              <span>This is my own work and I am allowed to share it, including the images.</span>
            </label>
            {fe.ownWork && (
              <p id="ownWork-error" role="alert" className="ml-8 text-[13px] font-medium text-red-800">
                {fe.ownWork}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-start gap-3 text-[15px] text-ink">
              <input type="checkbox" name="noConfidential" required aria-invalid={invalid("noConfidential")} aria-describedby={describe("noConfidential")} className="mt-1 size-5 accent-[#657166]" />
              <span>It contains no confidential or customer information.</span>
            </label>
            {fe.noConfidential && (
              <p id="noConfidential-error" role="alert" className="ml-8 text-[13px] font-medium text-red-800">
                {fe.noConfidential}
              </p>
            )}
          </div>
        </fieldset>
      </div>

      {preview && (
        <section aria-label="Preview of your story" className="rounded-lg border border-line bg-paper px-5 py-6">
          <p className="mb-4 rounded-md bg-peach px-3 py-2 text-[13px] text-ink">This is how your story will look when it is published. Nothing has been sent yet.</p>
          <div className="mx-auto w-full max-w-[680px]">
            <div className="flex flex-wrap items-center gap-2">
              {sectorName && <span className="rounded-full bg-mint px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-ink">{sectorName}</span>}
              <span className="rounded-full bg-peach px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-ink">Employee contribution</span>
              {doc.blocks.length > 0 && <span className="font-mono text-[11px] font-medium text-meta">{readingMinutes(doc)} min read</span>}
            </div>
            <h2 className="mt-3 font-headline text-[36px] font-bold leading-[1.15] text-ink">{title || "Your title"}</h2>
            <p className="mt-2 text-[15px] font-medium text-secondary">{byline}</p>
          </div>
          <div className="mt-6">
            {doc.blocks.length === 0 ? <p className="text-[15px] text-secondary">Nothing to show yet. Add some blocks first.</p> : <BlocksView doc={doc} headingOffset={1} images={previews} />}
          </div>
        </section>
      )}

      {turnstileSiteKey && (
        <>
          <Script src={TURNSTILE_SCRIPT} strategy="afterInteractive" />
          <TurnstileWidget key={widgetKey} siteKey={turnstileSiteKey} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="inline-flex h-12 items-center rounded-lg bg-deep-sage px-6 text-[15px] font-semibold text-white hover:bg-deep-sage-dark disabled:opacity-60">
          {pending ? "Sending…" : "Submit for review"}
        </button>
        <button type="button" onClick={() => setPreview((v) => !v)} aria-pressed={preview} className={btn}>
          {preview ? "Back to editing" : "Preview"}
        </button>
        <p className="text-[13px] text-secondary" aria-live="polite">
          {saved ? `Draft saved on this device at ${time(saved)}.` : "An editor will read it before anything is published."}
        </p>
      </div>
    </form>
  );
}
