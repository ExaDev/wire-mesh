// Whether the first-run intro is on screen. It opens on a device that has never dismissed it, stays closed until the stored answer has loaded so a returning user never sees it flash, and can be reopened.

import { useCallback, useEffect, useState } from "react";
import type { PreferencesStore } from "../preferences-store.js";

export interface Intro {
  /** True once the stored answer has loaded and the intro is wanted. */
  visible: boolean;
  /** True once the stored answer has loaded, so the control that reopens the intro is not offered before then. */
  ready: boolean;
  dismiss: () => void;
  show: () => void;
}

export function useIntro(store: Readonly<PreferencesStore>): Intro {
  const [dismissed, setDismissed] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    void store.introDismissed().then(setDismissed);
  }, [store]);

  const remember = useCallback(
    (value: boolean): void => {
      setDismissed(value);
      void store.setIntroDismissed(value);
    },
    [store],
  );
  const dismiss = useCallback(() => {
    remember(true);
  }, [remember]);
  const show = useCallback(() => {
    remember(false);
  }, [remember]);

  return {
    visible: dismissed === false,
    ready: dismissed !== undefined,
    dismiss,
    show,
  };
}
