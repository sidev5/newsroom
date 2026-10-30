import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { capText, htmlToText, MAX_FULL_TEXT_CHARS } from "./text";

/** Main article text from a page's HTML, plain text and capped. Null if Readability finds nothing. */
export function extractArticleText(html: string): string | null {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = htmlToText(article?.content ?? "");
  return text ? capText(text, MAX_FULL_TEXT_CHARS) : null;
}
