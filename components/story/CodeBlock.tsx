"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { languageLabel, type CodeLanguage } from "@/lib/stories/languages";
import { browserCopyEnv, COPY_LABEL, createCopyAction, type CopyState } from "./copy";

type Highlighter = ComponentType<{ code: string; language: CodeLanguage }>;

/**
 * A code block: a contrasted panel with a header bar (language, optional file name, Copy button) and the code in monospace.
 * The code never wraps; a long line scrolls sideways. It is shown as plain text at once and highlighted after the highlighter
 * has loaded, which only happens when a code block is on screen: the homepage does not carry the library.
 */
export function CodeBlock({ code, language, filename }: { code: string; language: CodeLanguage; filename?: string }) {
  const [Highlighted, setHighlighted] = useState<Highlighter | null>(null);
  const [state, setState] = useState<CopyState>("idle");
  const action = useRef<ReturnType<typeof createCopyAction> | null>(null);

  useEffect(() => {
    if (language === "plain") return;
    let live = true;
    import("./highlight").then((m) => live && setHighlighted(() => m.HighlightedCode)).catch(() => {});
    return () => {
      live = false;
    };
  }, [language]);

  useEffect(() => {
    action.current = createCopyAction(browserCopyEnv, setState);
    return () => action.current?.cancel();
  }, []);

  const label = languageLabel(language);
  return (
    <figure className="my-7 overflow-hidden rounded-lg bg-[#243029] text-[#e8efe9]">
      <figcaption className="flex items-center gap-3 border-b border-white/10 px-4 py-2 font-mono text-[12px] text-[#cfd6c4]">
        <span className="font-medium uppercase tracking-wide">{label}</span>
        {filename && <span className="min-w-0 flex-1 truncate" title={filename}>{filename}</span>}
        <button
          type="button"
          onClick={() => void action.current?.copy(code)}
          aria-label={`Copy the ${label} code${filename ? ` from ${filename}` : ""}`}
          className="ml-auto inline-flex min-h-8 items-center rounded-md border border-white/25 px-3 text-[12px] font-medium text-[#e8efe9] hover:bg-white/10"
        >
          {COPY_LABEL[state]}
        </button>
        {/* Read out when the state changes; the visible button text changes with it. */}
        <span role="status" aria-live="polite" className="sr-only">
          {state === "copied" ? "Copied to the clipboard" : state === "failed" ? "Copying failed" : ""}
        </span>
      </figcaption>
      <pre tabIndex={0} aria-label={`${label} code`} className="overflow-x-auto px-4 py-4 text-[14px] leading-[1.6] [tab-size:2]">
        <code className="block min-w-max whitespace-pre font-mono">{Highlighted ? <Highlighted code={code} language={language} /> : code}</code>
      </pre>
    </figure>
  );
}
