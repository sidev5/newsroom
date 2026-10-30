// Cleaning of text typed by employees. Pure. Everything is stored as plain text: no HTML or markdown is
// interpreted anywhere, and every place that shows it escapes it (React, and esc() in the digest).

/** Characters that never belong in a headline or story: C0/C1 controls, zero-width and bidi override marks, the BOM. */
function isStripped(cp: number): boolean {
  return (
    cp <= 0x08 ||
    cp === 0x0b ||
    cp === 0x0c ||
    (cp >= 0x0e && cp <= 0x1f) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/**
 * Removes control characters. Tabs become spaces; CR, CRLF, the Unicode line and paragraph separators
 * become "\n". Text is normalised to NFC so look-alike compositions compare equal.
 */
export function stripControl(value: string, options: { keepTabs?: boolean } = {}): string {
  let out = "";
  const text = value.normalize("NFC");
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++; // a surrogate pair is one code point
    if (cp === 0x09) out += options.keepTabs ? "\t" : " ";
    else if (cp === 0x0d) {
      out += "\n";
      if (text.charCodeAt(i + 1) === 0x0a) i++;
    } else if (cp === 0x0a || cp === 0x2028 || cp === 0x2029) out += "\n";
    else if (!isStripped(cp)) out += String.fromCodePoint(cp);
  }
  return out;
}

/** One line: control characters removed, every run of whitespace (including line breaks) collapsed to one space. */
export function cleanLine(value: string): string {
  return stripControl(value).replace(/\s+/g, " ").trim();
}

/** Story text: control characters removed; each line break starts a new paragraph (paragraphs are joined by a blank line). */
export function cleanParagraphs(value: string): string {
  return stripControl(value)
    .split("\n")
    .map((line) => line.replace(/[  ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Lower-case, single-spaced form of a title, for the duplicate check. */
export function titleKey(title: string): string {
  return cleanLine(title).toLowerCase();
}

/** Same scheme as the write stage: a readable base plus 8 characters of the id, so slugs are unique without a lookup. */
export function submissionSlug(title: string, id: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${base || "story"}-${id.replace(/-/g, "").slice(0, 8)}`;
}
