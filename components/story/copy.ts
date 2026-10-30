// The "Copy" button of a code block: copying the exact text, with a fallback for browsers or pages where the clipboard API is
// missing or refused, and the "Copied" message that goes away after two seconds. Plain functions with the browser injected, so
// the behaviour is tested without one.

/** How long "Copied" stays on the button. */
export const COPIED_MS = 2000;

export type CopyEnv = {
  /** navigator.clipboard, when the browser has it (it needs a secure page and a user action). */
  clipboard?: { writeText(text: string): Promise<void> } | null;
  /** The old way (a hidden textarea and document.execCommand("copy")). Returns whether the browser copied. */
  legacyCopy?: (text: string) => boolean;
};

/** Copies `text` exactly as it is. Tries the clipboard API first, then the fallback. Resolves to whether anything was copied. */
export async function copyText(text: string, env: CopyEnv): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // refused (permissions policy, no focus): try the fallback
    }
  }
  try {
    return env.legacyCopy?.(text) === true;
  } catch {
    return false;
  }
}

export type CopyState = "idle" | "copied" | "failed";

export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Copies and reports the result through `setState`: "copied" (or "failed") now, "idle" again after `ms`. Returns a function that
 * cancels the pending reset (call it when the component goes away). A second click during the two seconds starts them again.
 */
export function createCopyAction(env: () => CopyEnv, setState: (state: CopyState) => void, timers: Timers = realTimers, ms: number = COPIED_MS) {
  let pending: unknown;
  return {
    async copy(text: string): Promise<void> {
      const ok = await copyText(text, env());
      setState(ok ? "copied" : "failed");
      if (pending !== undefined) timers.clear(pending);
      pending = timers.set(() => {
        pending = undefined;
        setState("idle");
      }, ms);
    },
    cancel(): void {
      if (pending !== undefined) timers.clear(pending);
      pending = undefined;
    },
  };
}

/** The real browser's environment. Called when the button is pressed, never during rendering. */
export function browserCopyEnv(): CopyEnv {
  return {
    clipboard: typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null,
    legacyCopy(text) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.setAttribute("aria-hidden", "true");
      area.className = "fixed -left-[9999px] top-0 opacity-0";
      document.body.appendChild(area);
      area.select();
      try {
        return document.execCommand("copy");
      } finally {
        area.remove();
      }
    },
  };
}

/** The button's text for each state. */
export const COPY_LABEL: Record<CopyState, string> = { idle: "Copy", copied: "Copied", failed: "Copy failed" };
