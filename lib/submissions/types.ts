// Types shared by server and client code (no server-only imports).

/** What only an admin may see about the author, plus a short-lived link to the private photo. */
export type SubmitterView = {
  email: string;
  /** True when the address matched ALLOWED_EMAIL_DOMAINS; false means no domain list was configured. */
  emailVerified: boolean;
  submittedAt: string;
  /** Signed URL of the photo waiting in the private bucket, or null (no photo, or already published). */
  photoUrl: string | null;
  /** The author's real name, which the public byline shows only when 
amePublic (Write stories; null for older submissions). */
  authorName?: string | null;
  authorDepartment?: string | null;
  /** False: the author did not agree to show their name, so the story is published as "Newsroom contributor". */
  namePublic?: boolean;
};
