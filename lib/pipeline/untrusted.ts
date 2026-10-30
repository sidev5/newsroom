/**
 * Untrusted text can't close or reopen the tags that mark it as data
 * (<article> for classify/write, <source> and <draft> for fact-check, <draft> and <problems> for the repair).
 */
export function neutralise(text: string): string {
  return text.replace(/<\/?\s*(?:article|source|draft|problems)\b[^>]*>/gi, "");
}
