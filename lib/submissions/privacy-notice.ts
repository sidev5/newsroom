// The privacy notice on /submit (SEC-13), as plain data so its content can be tested. The figures come from the
// same settings the cleanup job uses, so the notice cannot promise something the job does not do.

export type NoticeInput = {
  /** PRIVACY_CONTACT, or null when it is not set. */
  contact: string | null;
  /** SUBMITTER_IP_RETENTION_DAYS. */
  ipDays: number;
  /** SUBMITTER_EMAIL_RETENTION_DAYS. */
  emailDays: number;
};

export type NoticeItem = { title: string; text: string };

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export function privacyNotice({ contact, ipDays, emailDays }: NoticeInput): { heading: string; items: NoticeItem[]; contact: string | null } {
  return {
    heading: "How we handle your details",
    contact,
    items: [
      {
        title: "What we store",
        text:
          "Your first and last name, your department, your company email address, your story, and the images you add to it. " +
          "We also keep a scrambled, one-way code made from your network (IP) address, only to stop spam. The address itself is never stored.",
      },
      {
        title: "Who can see it",
        text:
          "If the editor publishes your story, your images appear in it. Your name and department appear as its byline only if you tick \"Show my name\" on the form; otherwise it is published as \"Newsroom contributor\". " +
          "Your email address is visible only to the newsroom's administrators. The scrambled network code is not shown to anyone.",
      },
      {
        title: "How long we keep it",
        text:
          `The story and its byline stay for as long as the story is on the site. The scrambled network code is deleted after ${days(ipDays)}. ` +
          `Your email address is replaced by an anonymous placeholder ${days(emailDays)} after the editor publishes or rejects your story, and the private copy of your images is deleted then (your name and department are removed from the private record at the same time). Readers who like or comment sign in with a code sent to their company email: only a one-way code made from the address is kept, never the address.`,
      },
      {
        title: "Asking us to delete it",
        text: contact
          ? `To see or delete your details, write to ${contact}. We remove your submitter record and photo, and take your name off the story (or take the story down, if you ask).`
          : "To see or delete your details, ask the newsroom editor. We remove your submitter record and photo, and take your name off the story (or take the story down, if you ask).",
      },
    ],
  };
}
