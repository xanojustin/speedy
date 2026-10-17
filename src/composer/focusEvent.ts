/** DOM event the composer listens for to take focus. */
export const FOCUS_COMPOSER_EVENT = "speedy:focus-composer";
export interface FocusComposerDetail {
  threadId: string;
}

/** DOM event that attaches a snippet (a terminal selection) to the thread's composer. */
export const ADD_TO_COMPOSER_EVENT = "speedy:add-to-composer";
export interface AddToComposerDetail {
  threadId: string;
  text: string;
  /** Where it came from, shown on the chip ("Terminal 2"). */
  source: string;
}
