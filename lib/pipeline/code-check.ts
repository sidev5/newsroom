import { parse } from "@babel/parser";
import type { Block, BlocksDoc } from "@/lib/stories/blocks";
import { languageLabel, type CodeLanguage } from "@/lib/stories/languages";

// Cheap checks of the code blocks an AI-written story contains. Nothing is ever run: JSON is parsed, JavaScript and TypeScript
// are parsed (a syntax check, no evaluation), Python gets a structural check (brackets, strings, indentation: there is no Python
// parser here, and the message says so). A second check looks for what the model may have invented: version numbers and
// packages that the source does not mention. The results are warnings for the admin, never a reason to drop a story.

export type CodeWarning = { block: number; language: CodeLanguage; message: string };

const MAX_MESSAGE = 160;
const short = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s).replace(/\s+/g, " ");

// ---------------------------------------------------------------------------------------------------------------------
// Syntax
// ---------------------------------------------------------------------------------------------------------------------

function parseJs(code: string, typescript: boolean): string | null {
  try {
    parse(code, {
      sourceType: "module",
      plugins: typescript ? ["typescript"] : ["jsx"],
      // A snippet may `return` or `await` at its top level, or import in the middle: that is not a mistake in an example.
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
    return null;
  } catch (err) {
    return short(err instanceof Error ? err.message : "could not be parsed");
  }
}

const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const BLOCK_STARTERS = /^(def|class|if|elif|else|for|while|try|except|finally|with|match|case|async\s+def|async\s+for|async\s+with)\b/;

/**
 * Structure of Python code: strings that are never closed, brackets that do not match, indentation that mixes tabs and spaces,
 * a line ending in ":" with nothing indented under it, and a dedent to a level that was never open. It is not a parser: code can
 * pass it and still be wrong.
 */
export function checkPythonStructure(code: string): string | null {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const stack: { ch: string; line: number }[] = [];
  const indents: number[] = [0];
  let triple: { quote: string; line: number } | null = null;
  let usesTab = false;
  let usesSpace = false;
  let expectIndentFrom: number | null = null;
  let continued = false;

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = n + 1;
    let i = 0;
    const startedInString = triple !== null;
    const startsInBrackets = stack.length > 0;

    // Indentation of a line that starts a statement (not inside a string, a bracket or after a backslash).
    if (!startedInString && !startsInBrackets && !continued && raw.trim() !== "" && !raw.trim().startsWith("#")) {
      const lead = /^[ \t]*/.exec(raw)![0];
      if (lead.includes("\t")) usesTab = true;
      if (lead.includes(" ")) usesSpace = true;
      if (lead.includes("\t") && lead.includes(" ")) return `line ${line}: tabs and spaces are mixed in the indentation`;
      const width = lead.length;
      if (expectIndentFrom !== null) {
        if (width <= expectIndentFrom) return `line ${line}: expected an indented block after the line ending in ":"`;
        indents.push(width);
        expectIndentFrom = null;
      } else if (width > indents[indents.length - 1]) {
        return `line ${line}: unexpected indent`;
      } else {
        while (indents.length > 1 && width < indents[indents.length - 1]) indents.pop();
        if (width !== indents[indents.length - 1]) return `line ${line}: the indentation does not match any outer level`;
      }
    }
    continued = false;

    let lastSignificant = "";
    while (i < raw.length) {
      if (triple) {
        const end = raw.indexOf(triple.quote, i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        i = end + 3;
        triple = null;
        lastSignificant = '"';
        continue;
      }
      const ch = raw[i];
      if (ch === "#") break;
      if (ch === '"' || ch === "'") {
        if (raw.startsWith(ch.repeat(3), i)) {
          triple = { quote: ch.repeat(3), line };
          i += 3;
          continue;
        }
        let j = i + 1;
        while (j < raw.length && raw[j] !== ch) j += raw[j] === "\\" ? 2 : 1;
        if (j >= raw.length) return `line ${line}: a string is not closed`;
        i = j + 1;
        lastSignificant = ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") stack.push({ ch, line });
      else if (ch === ")" || ch === "]" || ch === "}") {
        const open = stack.pop();
        if (!open) return `line ${line}: "${ch}" has no matching opening bracket`;
        if (open.ch !== PAIRS[ch]) return `line ${line}: "${ch}" does not match the "${open.ch}" opened on line ${open.line}`;
      }
      if (ch.trim()) lastSignificant = ch;
      i++;
    }

    const text = raw.trim();
    if (!triple && stack.length === 0 && raw.endsWith("\\")) continued = true;
    if (!startedInString && !startsInBrackets && !triple && stack.length === 0 && lastSignificant === ":" && BLOCK_STARTERS.test(text)) {
      expectIndentFrom = /^[ \t]*/.exec(raw)![0].length;
    }
  }
  if (triple) return `line ${triple.line}: a triple-quoted string is not closed`;
  if (stack.length > 0) return `line ${stack[stack.length - 1].line}: "${stack[stack.length - 1].ch}" is never closed`;
  if (expectIndentFrom !== null) return `the last line ends in ":" with nothing indented under it`;
  void usesTab;
  void usesSpace;
  return null;
}

/** The syntax problem of one code block, or null. Languages without a check (SQL, Bash, ...) always pass. */
export function checkSyntax(code: string, language: CodeLanguage): string | null {
  switch (language) {
    case "json":
      try {
        JSON.parse(code);
        return null;
      } catch (err) {
        return `is not valid JSON: ${short(err instanceof Error ? err.message : "")}`;
      }
    case "js": {
      const e = parseJs(code, false);
      return e && `does not parse as JavaScript: ${e}`;
    }
    case "ts": {
      const e = parseJs(code, true);
      return e && `does not parse as TypeScript: ${e}`;
    }
    case "python": {
      const e = checkPythonStructure(code);
      return e && `looks wrong as Python (structure check only, not a full parse): ${e}`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Things the source does not support
// ---------------------------------------------------------------------------------------------------------------------

const NODE_BUILTINS = new Set("assert async_hooks buffer child_process cluster console crypto dgram dns events fs http http2 https module net os path perf_hooks process querystring readline stream string_decoder timers tls url util v8 vm worker_threads zlib".split(" "));
const PYTHON_STDLIB = new Set(
  "abc argparse array ast asyncio base64 bisect builtins calendar collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib email enum errno fnmatch fractions functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging math multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl statistics string struct subprocess sys tempfile textwrap threading time timeit traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib __future__".split(" "),
);

function importedPackages(code: string, language: CodeLanguage): string[] {
  const out = new Set<string>();
  if (language === "js" || language === "ts") {
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("#")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!NODE_BUILTINS.has(name)) out.add(name);
    }
  } else if (language === "python") {
    for (const m of code.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm)) {
      const names = m[1] ? [m[1]] : m[2].split(",").map((s) => s.trim());
      for (const n of names) {
        const top = n.split(".")[0];
        if (top && !PYTHON_STDLIB.has(top)) out.add(top);
      }
    }
  }
  return [...out];
}

/** Version numbers in the code: 1.2.3, v2.0, "==3.11", "@4.1": what a model likes to make up. */
function versionsIn(code: string): string[] {
  const found = new Set<string>();
  for (const m of code.matchAll(/\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b|\bv\d+\.\d+\b|(?:==|~=|>=|<=|\^|~|@)v?(\d+\.\d+)\b/g)) found.add(m[1] ?? m[0]);
  return [...found];
}

/** Warnings about parts of the code that the source text does not back up. */
export function checkSourceSupport(code: string, language: CodeLanguage, source: string): string[] {
  const haystack = source.toLowerCase();
  const out: string[] = [];
  for (const v of versionsIn(code)) {
    if (!haystack.includes(v.toLowerCase())) out.push(`mentions version ${v}, which the source does not`);
  }
  for (const pkg of importedPackages(code, language)) {
    if (!haystack.includes(pkg.toLowerCase())) out.push(`imports "${pkg}", which the source does not mention`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// A story
// ---------------------------------------------------------------------------------------------------------------------

/** Every problem found in the code blocks of a story, numbered by position among the story's code blocks. */
export function checkCodeBlocks(doc: BlocksDoc, source: string): CodeWarning[] {
  const out: CodeWarning[] = [];
  let n = 0;
  for (const b of doc.blocks as Block[]) {
    if (b.type !== "code") continue;
    n++;
    const syntax = checkSyntax(b.code, b.language);
    if (syntax) out.push({ block: n, language: b.language, message: syntax });
    for (const m of checkSourceSupport(b.code, b.language, source)) out.push({ block: n, language: b.language, message: m });
  }
  return out;
}

/** The text stored in the admin-only review note, or null when everything passed. */
export function formatCodeWarnings(warnings: readonly CodeWarning[]): string | null {
  if (warnings.length === 0) return null;
  return `Code check: ${warnings.map((w) => `code block ${w.block} (${languageLabel(w.language)}) ${w.message}`).join("; ")}. The code was not run: check it before approving.`;
}
