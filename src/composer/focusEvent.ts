/** DOM event the composer listens for to take focus. */
export const FOCUS_COMPOSER_EVENT = "speedy:focus-composer";
export interface FocusComposerDetail {
  threadId: string;
}
