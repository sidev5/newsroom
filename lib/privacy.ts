// Text that ends up in a column the public site can read must never contain an email address.

/** Deliberately loose: it is better to blank something that is not an address than to leave one in. */
export const EMAIL_PATTERN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Replaces every email address in `text`. */
export function redactEmails(text: string, replacement = "an editor"): string {
  return text.replace(EMAIL_PATTERN, replacement);
}

export function containsEmail(text: string): boolean {
  return new RegExp(EMAIL_PATTERN.source).test(text);
}
