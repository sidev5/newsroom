"use client";

import { useEffect, useRef, type ChangeEvent, type ReactNode } from "react";
import { STORY_LIMITS as L } from "@/lib/config";
import { BLOCK_LABELS, IMAGE_ACCEPT, type EditorBlock } from "@/lib/stories/editor";
import { CODE_LANGUAGES, type CodeLanguage } from "@/lib/stories/languages";

// One block in the editor: a header (type, move up, move down, delete) and the editor of its kind. Every control has a visible
// label or an aria-label. The inputs have no `name`, so they are not part of the form's own data; the form sends the blocks as JSON.

const field = "w-full rounded-lg border border-input bg-paper px-3 text-[15px] text-ink placeholder:text-secondary";
const input = `${field} h-11`;
const area = `${field} py-2.5 leading-relaxed`;
const small = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-input bg-paper px-2.5 text-[13px] font-medium text-ink hover:bg-mint disabled:opacity-40";

type Props = {
  block: EditorBlock;
  index: number;
  total: number;
  error?: string;
  /** The picked image as a data: address, for the thumbnail. */
  preview?: string;
  imageBusy?: boolean;
  imageError?: string;
  onChange: (block: EditorBlock) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onPickImage: (file: File | null) => void;
};

function Labeled({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-[13px] text-secondary">{hint}</p>}
    </div>
  );
}

/** A textarea that grows with its text (set through the DOM, so no inline style attribute is written). */
function Grow({ value, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 640)}px`;
  }, [value]);
  return <textarea ref={ref} value={value} rows={3} {...rest} />;
}

export function BlockCard({ block, index, total, error, preview, imageBusy, imageError, onChange, onMove, onDelete, onPickImage }: Props) {
  const id = block.id;
  const label = `${BLOCK_LABELS[block.type]} ${index + 1}`;
  const first = `field-${id}`;
  const set = (patch: Partial<EditorBlock>) => onChange({ ...block, ...patch } as EditorBlock);
  const on = (key: string) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set({ [key]: e.target.value });

  function onCodeKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Tab writes a tab in a code box (as in an editor); Escape then Tab leaves the box.
    if (e.key === "Escape") {
      (e.currentTarget as HTMLTextAreaElement).dataset.leave = "1";
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.currentTarget.dataset.leave === "1") {
        e.currentTarget.dataset.leave = "";
        return;
      }
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: from, selectionEnd: to } = el;
      const next = `${el.value.slice(0, from)}\t${el.value.slice(to)}`;
      set({ code: next } as Partial<EditorBlock>);
      requestAnimationFrame(() => el.setSelectionRange(from + 1, from + 1));
    } else if (e.key !== "Shift") {
      e.currentTarget.dataset.leave = "";
    }
  }

  return (
    <section aria-label={label} className={`flex flex-col gap-3 rounded-lg border bg-paper p-3 sm:p-4 ${error ? "border-red-700" : "border-line"}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-mono text-[11px] font-medium uppercase tracking-wide text-meta">
          {BLOCK_LABELS[block.type]}
          {block.type === "heading" ? ` H${block.level}` : block.type === "list" ? (block.ordered ? " (numbered)" : " (bulleted)") : ""}
        </h3>
        <button type="button" className={small} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${label} up`}>
          <span aria-hidden="true">↑</span>
        </button>
        <button type="button" className={small} disabled={index === total - 1} onClick={() => onMove(1)} aria-label={`Move ${label} down`}>
          <span aria-hidden="true">↓</span>
        </button>
        <button type="button" className={`${small} text-red-800`} onClick={onDelete} aria-label={`Delete ${label}`}>
          Delete
        </button>
      </header>

      {block.type === "paragraph" && (
        <Labeled id={first} label="Paragraph" hint={`${block.text.length} of ${L.PARAGRAPH_MAX} characters`}>
          <Grow id={first} value={block.text} onChange={on("text")} maxLength={L.PARAGRAPH_MAX} className={area} aria-invalid={error ? true : undefined} />
        </Labeled>
      )}

      {block.type === "heading" && (
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Labeled id={`${first}-level`} label="Level">
            <select id={`${first}-level`} value={block.level} onChange={(e) => set({ level: e.target.value === "3" ? 3 : 2 } as Partial<EditorBlock>)} className={input}>
              <option value={2}>Heading 2</option>
              <option value={3}>Heading 3</option>
            </select>
          </Labeled>
          <Labeled id={first} label="Heading text">
            <input id={first} value={block.text} onChange={on("text")} maxLength={L.HEADING_MAX} className={input} aria-invalid={error ? true : undefined} />
          </Labeled>
        </div>
      )}

      {block.type === "image" && (
        <div className="flex flex-col gap-3">
          <Labeled id={first} label="Image file" hint={`JPEG, PNG or WebP, up to ${L.MAX_IMAGES} images in a story. Location and camera details are removed from the file.`}>
            <input
              id={first}
              type="file"
              accept={IMAGE_ACCEPT}
              onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
              className="w-full rounded-lg border border-input bg-paper px-3 py-2 text-[14px] text-ink file:mr-3 file:rounded-md file:border-0 file:bg-sage file:px-3 file:py-1.5 file:text-[14px] file:font-medium file:text-ink"
            />
          </Labeled>
          {imageBusy && <p role="status" className="text-[13px] text-secondary">Preparing the image…</p>}
          {imageError && <p role="alert" className="text-[13px] font-medium text-red-800">{imageError}</p>}
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element -- a data: address of the file the person just chose
            <img src={preview} alt={block.alt || "Preview of the chosen image"} className="max-h-64 w-auto max-w-full rounded-lg" />
          )}
          <Labeled id={`${first}-alt`} label="Description of the image (alt text, required)" hint="For people who cannot see the image. Say what it shows.">
            <input id={`${first}-alt`} value={block.alt} onChange={on("alt")} maxLength={L.ALT_MAX} className={input} />
          </Labeled>
          <Labeled id={`${first}-caption`} label="Caption (optional)">
            <input id={`${first}-caption`} value={block.caption} onChange={on("caption")} maxLength={L.CAPTION_MAX} className={input} />
          </Labeled>
        </div>
      )}

      {block.type === "code" && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled id={`${first}-lang`} label="Language">
              <select id={`${first}-lang`} value={block.language} onChange={(e) => set({ language: e.target.value as CodeLanguage } as Partial<EditorBlock>)} className={input}>
                {CODE_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled id={`${first}-file`} label="File name (optional)">
              <input id={`${first}-file`} value={block.filename} onChange={on("filename")} maxLength={L.FILENAME_MAX} placeholder="example.ts" className={input} />
            </Labeled>
          </div>
          <Labeled id={first} label="Code" hint={`Tabs and spaces are kept. Press Tab to indent; press Escape and then Tab to leave the box. ${block.code.length} of ${L.CODE_MAX} characters.`}>
            <textarea
              id={first}
              value={block.code}
              onChange={on("code")}
              onKeyDown={onCodeKey}
              rows={8}
              wrap="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              maxLength={L.CODE_MAX}
              className={`${area} overflow-x-auto whitespace-pre font-mono text-[14px] leading-[1.6] [tab-size:2]`}
              aria-invalid={error ? true : undefined}
            />
          </Labeled>
        </div>
      )}

      {block.type === "quote" && (
        <div className="flex flex-col gap-3">
          <Labeled id={first} label="Quote">
            <Grow id={first} value={block.text} onChange={on("text")} maxLength={L.QUOTE_MAX} className={area} aria-invalid={error ? true : undefined} />
          </Labeled>
          <Labeled id={`${first}-cite`} label="Who said it (optional)">
            <input id={`${first}-cite`} value={block.cite} onChange={on("cite")} maxLength={L.CITE_MAX} className={input} />
          </Labeled>
        </div>
      )}

      {block.type === "list" && (
        <Labeled id={first} label={block.ordered ? "Numbered list" : "Bulleted list"} hint="One item per line.">
          <Grow id={first} value={block.itemsText} onChange={(e) => set({ itemsText: e.target.value } as Partial<EditorBlock>)} className={area} aria-invalid={error ? true : undefined} />
        </Labeled>
      )}

      {block.type === "divider" && (
        <p id={first} tabIndex={-1} className="text-[14px] text-secondary">
          A dividing line between two parts of the story.
        </p>
      )}

      {block.type === "link" && (
        <div className="flex flex-col gap-3">
          <Labeled id={first} label="Address (http:// or https://)">
            <input id={first} type="url" inputMode="url" value={block.url} onChange={on("url")} maxLength={L.URL_MAX} placeholder="https://" className={input} aria-invalid={error ? true : undefined} />
          </Labeled>
          <Labeled id={`${first}-title`} label="Link title">
            <input id={`${first}-title`} value={block.title} onChange={on("title")} maxLength={L.LINK_TITLE_MAX} className={input} />
          </Labeled>
          <Labeled id={`${first}-desc`} label="Short description (optional)">
            <input id={`${first}-desc`} value={block.description} onChange={on("description")} maxLength={L.LINK_DESCRIPTION_MAX} className={input} />
          </Labeled>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[13px] font-medium text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}
