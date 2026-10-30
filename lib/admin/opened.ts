// SEC-08: "Approve selected" publishes stories exactly as stored. An editor who selected stories without ever looking at them
// is warned first. A story counts as opened when the editor clicked, typed or tabbed into its card, or kept at least half of it
// on screen for a couple of seconds. Plain module: the rule is tested, the board only reports the events.

/** How long half of a card has to stay in view for it to count as read. */
export const SEEN_MS = 2000;
/** How much of the card has to be in view. */
export const SEEN_RATIO = 0.5;

/** The selected ids that were never opened, in the order of `selected`. */
export function unopenedIds(selected: readonly string[], opened: ReadonlySet<string>): string[] {
  return selected.filter((id) => !opened.has(id));
}

/** The warning above the confirm button of a bulk approve, or null when every selected story was opened. */
export function unopenedWarning(selectedCount: number, unopened: number): string | null {
  if (selectedCount <= 0 || unopened <= 0) return null;
  const all = unopened === selectedCount;
  const which = all ? (selectedCount === 1 ? "The selected story was" : `All ${selectedCount} selected stories were`) : `${unopened} of the ${selectedCount} selected stories ${unopened === 1 ? "was" : "were"}`;
  return `${which} never opened: you have not scrolled to ${unopened === 1 ? "it" : "them"} or clicked in ${unopened === 1 ? "it" : "them"}. Approving publishes ${unopened === 1 ? "it" : "them"} exactly as stored, without anyone having read ${unopened === 1 ? "it" : "them"}.`;
}