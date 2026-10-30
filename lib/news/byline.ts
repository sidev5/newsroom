import type { Story } from "./types";

// What the reader is told about who wrote a story. Pure.

export const EMPLOYEE_TAG = "Employee contribution";
export const AI_TAG = "AI-generated";

type Authored = Pick<Story, "origin" | "author_first_name" | "author_last_name" | "author_department">;

export function isEmployeeStory(story: Pick<Story, "origin">): boolean {
  return story.origin === "employee";
}

/** "By Ada Lovelace · Software Development" for an employee story; null for an AI story or when no name is stored. */
export function byline(story: Authored): string | null {
  if (!isEmployeeStory(story)) return null;
  const name = [story.author_first_name, story.author_last_name].filter(Boolean).join(" ");
  if (!name) return null;
  return story.author_department ? `By ${name} · ${story.author_department}` : `By ${name}`;
}

/** The tag next to the department chip: "Employee contribution" replaces "AI-generated" on employee stories. */
export function originTag(story: Pick<Story, "origin">): string {
  return isEmployeeStory(story) ? EMPLOYEE_TAG : AI_TAG;
}
