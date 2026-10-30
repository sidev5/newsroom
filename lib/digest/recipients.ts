import { z } from "zod";
import type { DigestStore } from "./service";

// Recipients of the weekly digest. Admin only; the audit log records counts, never addresses.

export type Recipient = { id: string; email: string; active: boolean };

export interface RecipientStore {
  list(): Promise<Recipient[]>;
  /** Adds the addresses that are not there yet. Returns how many were new. */
  add(emails: string[]): Promise<number>;
  remove(id: string): Promise<boolean>;
  setActive(id: string, active: boolean): Promise<boolean>;
}

export type RecipientDeps = {
  recipients: RecipientStore;
  adminEmail: () => Promise<string | null>;
  log: DigestStore["log"];
};

export const MAX_PASTE = 500;
const emailSchema = z.email();

/**
 * Splits pasted text into addresses. Entries are separated by commas, semicolons or new lines, and
 * words within an entry by spaces. A word group in front of "<a@b.c>" is a display name and is dropped;
 * any other word that is not an address is reported as invalid.
 */
export function parseRecipients(text: string): { valid: string[]; invalid: string[] } {
  const tokens: string[] = [];
  for (const entry of text.split(/[,;\n\r]+/)) {
    let names: string[] = [];
    for (const word of entry.trim().split(/\s+/).filter(Boolean)) {
      const bracketed = /<([^<>]+)>/.exec(word);
      if (bracketed) {
        tokens.push(bracketed[1]); // "Ada Lovelace <ada@x.com>": the words before it were the name
        names = [];
      } else if (word.includes("@")) {
        tokens.push(...names, word);
        names = [];
      } else {
        names.push(word);
      }
    }
    tokens.push(...names);
  }
  const valid = new Set<string>();
  const invalid = new Set<string>();
  for (const raw of tokens) {
    const t = raw.trim().replace(/^["']+|["']+$/g, "").toLowerCase();
    if (!t) continue;
    (emailSchema.safeParse(t).success ? valid : invalid).add(t);
  }
  return { valid: [...valid], invalid: [...invalid] };
}
const NOT_ADMIN = "Not authorised.";

export async function addRecipients(deps: RecipientDeps, text: string): Promise<{ ok: true; added: number; duplicates: number; invalid: number } | { ok: false; error: string }> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };
  const { valid, invalid } = parseRecipients(text);
  if (valid.length === 0) return { ok: false, error: invalid.length ? "None of those look like email addresses." : "Paste at least one email address." };
  if (valid.length > MAX_PASTE) return { ok: false, error: `Add at most ${MAX_PASTE} addresses at a time.` };
  const added = await deps.recipients.add(valid);
  await deps.log(null, "recipients_changed", admin, { added, invalid: invalid.length });
  return { ok: true, added, duplicates: valid.length - added, invalid: invalid.length };
}

export const REMOVE_NEEDS_CONFIRMATION = "Removing a recipient needs confirmation.";

/**
 * Removes a recipient. It cannot be undone (the address is gone from the list), so the admin's confirmation is required:
 * the admin check comes first, then the confirmation. `confirmed` defaults to true for callers that confirm elsewhere.
 */
export async function removeRecipient(deps: RecipientDeps, id: string, confirmed = true): Promise<{ ok: boolean; error?: string }> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };
  if (!confirmed) return { ok: false, error: REMOVE_NEEDS_CONFIRMATION };
  if (!id) return { ok: false, error: "Missing id." };
  const removed = await deps.recipients.remove(id);
  if (removed) await deps.log(null, "recipients_changed", admin, { removed: 1 });
  return removed ? { ok: true } : { ok: false, error: "That recipient no longer exists." };
}

export async function setRecipientActive(deps: RecipientDeps, id: string, active: boolean): Promise<{ ok: boolean; error?: string }> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };
  if (!id) return { ok: false, error: "Missing id." };
  const changed = await deps.recipients.setActive(id, active);
  if (changed) await deps.log(null, "recipients_changed", admin, { [active ? "activated" : "deactivated"]: 1 });
  return changed ? { ok: true } : { ok: false, error: "That recipient no longer exists." };
}
