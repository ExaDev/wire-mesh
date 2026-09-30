// Persistence for the console's own interface preferences over the portable KeyValueStorage port: today, whether the first-run intro has been dismissed.

import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

const INTRO_DISMISSED_KEY = "preferences/intro-dismissed";
const FLAG_SET = new Uint8Array([1]);

export interface PreferencesStore {
  introDismissed: () => Promise<boolean>;
  /** Records that the intro was dismissed, or (with false) that it should be shown again. */
  setIntroDismissed: (dismissed: boolean) => Promise<void>;
}

export function createPreferencesStore(
  storage: Readonly<KeyValueStorage>,
): PreferencesStore {
  return {
    async introDismissed() {
      return (await storage.get(INTRO_DISMISSED_KEY)) !== undefined;
    },
    async setIntroDismissed(dismissed) {
      if (dismissed) {
        await storage.set(INTRO_DISMISSED_KEY, new Uint8Array(FLAG_SET));
      } else {
        await storage.delete(INTRO_DISMISSED_KEY);
      }
    },
  };
}
