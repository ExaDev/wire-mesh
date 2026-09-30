// Whether the first-run intro is on screen. It opens on a device that has never dismissed it, stays closed until the stored answer has loaded so a returning user never sees it flash, and can be reopened.

import { useCallback, useEffect, useState } from "react";
import type { PreferencesStore } from "../preferences-store.js";

export interface Intro {
  /** True once the stored answer has loaded and the intro is wanted. */
  visible: boolean;
  /** True once the stored answer has loaded, so the control that reopens the intro is not offered before then. */
  ready: boolean;
  /** Why the stored answer could not be read or saved, for the person to see: the intro then follows this session's choice only, and reappears next load if the dismissal was not saved. */
  error: string | undefined;
  dismiss: () => void;
  show: () => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useIntro(store: Readonly<PreferencesStore>): Intro {
  const [dismissed, setDismissed] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    store.introDismissed().then(setDismissed, (reason: unknown) => {
      setError(describe(reason));
    });
  }, [store]);

  const remember = useCallback(
    (value: boolean): void => {
      setDismissed(value);
      store.setIntroDismissed(value).then(
        () => {
          setError(undefined);
        },
        (reason: unknown) => {
          setError(describe(reason));
        },
      );
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
    error,
    dismiss,
    show,
  };
}
