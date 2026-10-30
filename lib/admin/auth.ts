/** Case-insensitive match against ADMIN_EMAILS (already lower-cased and trimmed by env.ts). */
export function isAdminEmail(email: string | null | undefined, adminEmails: string[]): boolean {
  if (!email) return false;
  return adminEmails.includes(email.trim().toLowerCase());
}
