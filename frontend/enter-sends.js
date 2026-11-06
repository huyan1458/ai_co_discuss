/**
 * Whether the return key sends what is typed. Phones and tablets have no Shift+Enter, so there it adds a line and only
 * the send button sends; every composer in the page follows this one rule.
 */
export const ENTER_SENDS = typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches;
